//+------------------------------------------------------------------+
//|                                                      DaveEA.mq5   |
//|  Dave's MT5 bridge, version 4.0.                                   |
//|                                                                    |
//|  Connection (unchanged from 3.x, proven live): every second a tiny |
//|  "anything for me?" poll, a full report (account, positions,       |
//|  pending orders, closed trades, command results) every PushSeconds |
//|  -- WebRequest, or the container's file bridge. Commands (open,    |
//|  modify, close, delete_pending, analyze, ...) come back in the     |
//|  SAME HTTP answer; results are kept until the bot has them.        |
//|                                                                    |
//|  Analysis (rebuilt in 4.0): 15 groups + account tools, each its    |
//|  own job, all reading one shared memory per symbol+timeframe that  |
//|  is worked out on CLOSED candles only when a new candle closes.    |
//|  Raw facts with their rules printed, the APA strategy's pieces     |
//|  (shift/reclaim/transition, areas of liquidity types 1-4,          |
//|  liquidity engineering, flip levels, cycles and FTAs) included.    |
//+------------------------------------------------------------------+
#property strict
#include <Trade\Trade.mqh>

// Real compile error fixed (MetaEditor: "undeclared identifier 'DAVEEA_BARS'" at
// PrewarmAnalysisSymbols) -- MQL5's preprocessor requires a #define to appear before its first
// use in the file, same as C. This was originally defined further down (right before
// TimeframeFromString), after PrewarmAnalysisSymbols/ExecuteCommandsFromResponse already used
// it -- moved here, to the top, so every real use compiles regardless of where it appears below.
#define DAVEEA_BARS 1000
// Reported with every heartbeat so the bot can tell the trader when this file is out of date.
#define EA_VERSION "4.0"
// Docker-mode file bridge (see UseFileBridge) -- defined up here for the same reason.
#define BRIDGE_DIR "dave_bridge"
#define BRIDGE_TIMEOUT_MS 20000

input string WebhookURL     = "{{WEBHOOK_URL}}";
input string EaToken        = "{{TOKEN}}"; // embedded in WebhookURL's path -- kept here for logging/diagnostics only
// Real, live change (the trader, explicit, live: first "change it to 1 min", then "if possible
// make it 8 sec"). This compiled default has moved several times this session already -- 1s
// ("wants the full-report push as fast as possible"), then a 120s live override ("the ea tick
// should be sending every 2min") that outlived its own later source revert because a live
// runtime override persists on an already-running MT5 terminal independent of what a recompile
// would produce. Every "analyze" command's result only ships on the EA's NEXT poll after the one
// that picked it up, so a slower interval directly costs real minutes per autonomous cycle
// (confirmed live: some timeframe requests hit their full 5-minute timeout at 120s). Hardcoded
// here as the real, settled default (8s) rather than left as another live-only override that
// would silently revert on the next terminal restart -- also set live right now via dave-admin's
// ea-push-interval route so this takes effect immediately without needing a recompile.
input int    PushSeconds    = 8;     // periodic state-push cadence (default 8s, the trader's explicit setting)
input bool   EnablePush     = true;  // Step 11.2: MT5 push notification on open/close/error
input bool   EnableEmail    = true;  // Step 11.2: email on open/close/error
input int    MagicNumber    = 88001; // ported from the reference DAVE.mq5 -- tags every order this EA places
input int    SlippagePoints = 20;    // ported from the reference DAVE.mq5
input int    SwingLookback  = 5;     // ported from the reference DAVEMA EA -- fractal/swing strength for structure/liquidity/etc
input int    ZoneMax        = 5;     // ported from the reference DAVEMA EA -- supply/demand zones kept per request
input double EqTolerancePips= 1.5;   // ported from the reference DAVEMA EA -- equal high/low tolerance
// Docker mode (MT5 running in Dave's own container, no VPS). MT5 only lets WebRequest reach URLs
// ticked in Tools > Options, and that list is stored encrypted -- it cannot be preset by a script
// (MetaQuotes: "not possible for security reason"). So in the container the EA does not make the
// HTTP call itself: it writes each report to MQL5\Files\dave_bridge, and the container's relay
// posts it to WebhookURL and writes the answer back. Off by default: a normal install is unchanged.
input bool   UseFileBridge  = false;

CTrade trade;

// Item 5 real gap fixed: PushSeconds is a compiled-in `input` (read-only at runtime) -- this
// mirrors it into a real mutable global so a "set_push_interval" command can change the EA's
// actual push/heartbeat cadence live, without requiring a recompile or restart.
int g_pushIntervalSeconds = 1;
uint g_lastFullAt = 0; // when the last FULL report went (the 1 s timer sends light polls in between)

//+------------------------------------------------------------------+
//| Broker symbol resolver -- ported from the reference DAVE.mq5.     |
//| Dave's tools speak in base symbols ("EURUSD"); brokers often list |
//| them with a suffix ("EURUSDm", "EURUSD.raw", ...). Resolves once  |
//| per command so an open/modify/close never fails purely because   |
//| the literal string didn't match this broker's naming.            |
//+------------------------------------------------------------------+
string ResolveBrokerSymbol(const string base)
  {
   if(StringLen(base) == 0) return base;
   if(SymbolSelect(base, true)) return base;
   string suffixes[] = {"m", ".raw", ".pro", ".ecn", "+", ".", "_i", "i", "-Cash", ".cash", "c", ".m", "x"};
   for(int i = 0; i < ArraySize(suffixes); i++)
     {
      string cand = base + suffixes[i];
      if(SymbolSelect(cand, true)) return cand;
     }
   int total = SymbolsTotal(false);
   for(int i = 0; i < total; i++)
     {
      string nm = SymbolName(i, false);
      if(StringFind(nm, base) == 0 && SymbolSelect(nm, true)) return nm;
     }
   return base; // fallback -- caller will see the real SymbolInfo failure rather than a silent swallow
  }

// Market Watch variant: the exact name or a known broker suffix only. No prefix scan -- short
// names ("V", "MA", "BA") would otherwise switch on some unrelated symbol that merely starts so.
bool SelectExactOrSuffixed(const string base)
  {
   if(SymbolSelect(base, true)) return true;
   string suffixes[] = {"m", ".raw", ".pro", ".ecn", "+", ".", "_i", "i", "-Cash", ".cash", "c", ".m", "x"};
   for(int i = 0; i < ArraySize(suffixes); i++)
      if(SymbolSelect(base + suffixes[i], true)) return true;
   return false;
  }

//+------------------------------------------------------------------+
//| Broker min-stop-distance enforcement -- ported from the reference |
//| DAVE.mq5. Real MT5 fact: every symbol has a SYMBOL_TRADE_STOPS_   |
//| LEVEL (broker-enforced minimum distance a pending price or an     |
//| SL/TP may sit from the current market); requests inside that      |
//| distance are rejected by the broker outright. Rather than let     |
//| Dave's calculated entry silently fail against an unknown-to-Dave  |
//| broker limit, the EA itself widens it just enough to clear that   |
//| limit before sending.                                              |
//+------------------------------------------------------------------+
double MinStopDistance(const string sym)
  {
   long stopLevel = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL);
   double pt = SymbolInfoDouble(sym, SYMBOL_POINT);
   if(stopLevel <= 0) stopLevel = 10;
   return (double)(stopLevel + 5) * pt;
  }

double EnforcePendingPrice(const string sym, const string actionType, const double requested)
  {
   double ask = SymbolInfoDouble(sym, SYMBOL_ASK);
   double bid = SymbolInfoDouble(sym, SYMBOL_BID);
   double minDist = MinStopDistance(sym);
   int    digits  = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double price = requested;
   if(actionType == "buy_limit")
     {
      double cap = ask - minDist;
      if(price <= 0 || price > cap) price = cap;
     }
   else if(actionType == "sell_limit")
     {
      double floorP = bid + minDist;
      if(price <= 0 || price < floorP) price = floorP;
     }
   else if(actionType == "buy_stop")
     {
      double floorP = ask + minDist;
      if(price <= 0 || price < floorP) price = floorP;
     }
   else if(actionType == "sell_stop")
     {
      double cap = bid - minDist;
      if(price <= 0 || price > cap) price = cap;
     }
   return NormalizeDouble(price, digits);
  }

//+------------------------------------------------------------------+
int OnInit()
  {
   // Refuse to run on an un-personalized template rather than silently
   // failing on every WebRequest call -- a raw {{...}} placeholder means
   // this file was compiled without going through Dave's /ea command.
   if(StringFind(WebhookURL, "{{") >= 0 || StringLen(EaToken) == 0 || StringFind(EaToken, "{{") >= 0)
     {
      Print("Dave EA: WebhookURL/EaToken still contain template placeholders. ",
            "Get a personalized copy via /ea in Telegram instead of using this file as-is.");
      return(INIT_PARAMETERS_INCORRECT);
     }

   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(SlippagePoints);

   if(UseFileBridge)
     {
      FolderCreate(BRIDGE_DIR);
      Print("Dave EA: file bridge on -- reports go through ", BRIDGE_DIR, " (container relay), not WebRequest");
     }
   Print("Dave EA starting. Webhook: ", WebhookURL, ", magic=", MagicNumber,
         ", phone push ", TerminalInfoInteger(TERMINAL_NOTIFICATIONS_ENABLED) ? "on" : "off (no MetaQuotes ID)");
   g_pushIntervalSeconds = PushSeconds;
   EventSetTimer(1); // a light poll every second; the full report every PushSeconds (see OnTimer)
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   ReleaseAllWarm();
   FreeSlots();
  }

//+------------------------------------------------------------------+
//| Real bug fixed (the trader, live: the MetaTrader push notification |
//| "doesn't send full reasoning -- it just stops at ...").            |
//| SendNotification's body is genuinely capped at 255 characters by   |
//| the MetaQuotes push service, and the old NotifyTradeEvent simply   |
//| cut the combined string at 252 and appended "..." -- so everything |
//| past the first ~250 characters of the model's reasoning never      |
//| reached the phone at all. The per-MESSAGE cap is real, but the     |
//| reasoning can still arrive in full as FURTHER notifications.       |
//| MetaQuotes also rate-limits pushes (roughly 2/second), so overflow |
//| parts are queued and drained one per OnTimer tick rather than      |
//| fired in a burst the service would drop -- and no Sleep() is used, |
//| so the EA is never blocked mid-tick.                               |
//+------------------------------------------------------------------+
#define PUSH_MAX_LEN   255
#define PUSH_MAX_PARTS 6     // ~1.4k chars of real reasoning; past that it genuinely is trimmed.

string g_pushQueue[];
int    g_pushQueueCount = 0;

void EnqueuePush(string text)
  {
   if(g_pushQueueCount >= ArraySize(g_pushQueue))
      ArrayResize(g_pushQueue, g_pushQueueCount + 8);
   g_pushQueue[g_pushQueueCount] = text;
   g_pushQueueCount++;
  }

// Sends exactly one queued push per call -- real rate-limit respect without blocking the EA.
void DrainPushQueue()
  {
   if(g_pushQueueCount <= 0)
      return;
   SendNotification(g_pushQueue[0]);
   for(int i = 1; i < g_pushQueueCount; i++)
      g_pushQueue[i - 1] = g_pushQueue[i];
   g_pushQueueCount--;
  }

// Splits `text` into at most PUSH_MAX_PARTS chunks of <= maxLen, breaking at the last space before
// the cap so a chunk never cuts mid-word or mid-number (the same real complaint that produced
// summarizeReason's word-boundary fix on the Telegram side).
int SplitForPush(string text, int maxLen, string &out[])
  {
   int count = 0;
   ArrayResize(out, 0);
   while(StringLen(text) > 0 && count < PUSH_MAX_PARTS)
     {
      if(StringLen(text) <= maxLen)
        {
         ArrayResize(out, count + 1);
         out[count] = text;
         count++;
         // Cleared before breaking so the leftover check below correctly sees "nothing remains" --
         // otherwise a message that fit perfectly would be falsely marked truncated with "...".
         text = "";
         break;
        }
      int cut = maxLen;
      int lastSpace = -1;
      for(int i = 0; i < maxLen; i++)
         if(StringGetCharacter(text, i) == ' ')
            lastSpace = i;
      if(lastSpace > maxLen / 2)
         cut = lastSpace;
      ArrayResize(out, count + 1);
      out[count] = StringSubstr(text, 0, cut);
      count++;
      text = StringSubstr(text, cut);
      StringTrimLeft(text);
     }
   // Only reachable when the reasoning genuinely exceeds PUSH_MAX_PARTS messages. Mark the last
   // part so the reader can see it really was cut, rather than "(6/6)" implying a complete message.
   if(StringLen(text) > 0 && count > 0)
      out[count - 1] = out[count - 1] + "...";
   return count;
  }

void OnTimer()
  {
   // Drain before the (much heavier) report push so a queued reasoning part always goes out on
   // schedule even when the webhook call is slow.
   DrainPushQueue();
   // Speed (the trader: a full analysis took 30 s -- "should be 2 sec"): the maths takes ms; the
   // time was two heartbeats of waiting -- one to pick the job up, one to send the answer back.
   // Now a tiny "anything for me?" poll goes every second between full reports, and answers go
   // back the moment they are computed instead of on the next heartbeat.
   bool full = g_lastFullAt == 0 || GetTickCount() - g_lastFullAt >= (uint)g_pushIntervalSeconds * 1000;
   PushReportAndExecuteCommands(!full);
   for(int k = 0; k < 5 && g_pendingResultsJson != ""; k++)
      PushReportAndExecuteCommands(false);
   // EA 4.0: work out a new candle on the timeframes the bot reads, before it asks again
   PrecomputeTick();
  }

// Real, light addition (open-trade/price monitoring cadence, faster than any timer): -1 means
// "not observed yet" so the very first real tick after EA start never fires a spurious push.
int g_lastKnownPositionsTotal = -1;

void OnTick()
  {
   // OnTick() fires on every genuine MT5 price tick -- faster than EventSetTimer's real floor
   // (PushSeconds, now 1s). This deliberately does NOT call the full, expensive
   // PushReportAndExecuteCommands() on every tick -- on a fast-ticking symbol that would hammer
   // the webhook and just duplicate the timer's own job for no benefit. The one cheap, local,
   // real check that's worth doing here: has the actual number of open positions changed since
   // the last tick (a genuine SL/TP hit, a manual close/open in the terminal, or an order this
   // EA itself just placed)? If so, push one report immediately instead of waiting up to
   // PushSeconds for the next scheduled one -- position/price state reaches Dave the instant it
   // genuinely changes, without adding any network cost in the far more common case where
   // nothing changed between ticks.
   int total = PositionsTotal();
   if(g_lastKnownPositionsTotal >= 0 && total != g_lastKnownPositionsTotal)
      PushReportAndExecuteCommands();
   g_lastKnownPositionsTotal = total;
  }

//+------------------------------------------------------------------+
//| Build one JSON report of real account/position/pending state,    |
//| POST it, and execute whatever commands come back in the response |
//+------------------------------------------------------------------+
// light = the tiny poll (no positions/account, no results) -- only asks for queued commands.
void PushReportAndExecuteCommands(bool light = false)
  {
   g_sentResultsLen = 0;
   string body = light ? "{\"type\":\"poll\",\"eaVersion\":\"" + EA_VERSION + "\"}" : BuildReportJson();
   if(!light) g_lastFullAt = GetTickCount();

   char post[];
   // UTF-8, so a trade note or symbol with any character reaches the bot exactly as written.
   int rawLen = StringToCharArray(body, post, 0, WHOLE_ARRAY, CP_UTF8);
   // StringToCharArray appends a terminating 0 byte -- WebRequest would
   // send that as a trailing NUL inside the POST body, which some JSON
   // parsers reject. Trim it off.
   if(ArraySize(post) > 0 && post[ArraySize(post) - 1] == 0)
      ArrayResize(post, ArraySize(post) - 1);

   if(UseFileBridge)
     {
      int bridgeStatus = 0;
      string bridgeResponse = "";
      if(!FileBridgeRequest(body, bridgeStatus, bridgeResponse))
         return; // already logged
      if(bridgeStatus != 200)
        {
         Print("Dave EA: webhook responded with HTTP ", bridgeStatus, " (via bridge): ", bridgeResponse);
         return;
        }
      ClearSentResults(); // delivered
      ExecuteCommandsFromResponse(bridgeResponse);
      return;
     }

   char result[];
   string resultHeaders;
   string headers = "Content-Type: application/json\r\n";
   ResetLastError();
   int status = WebRequest("POST", WebhookURL, headers, 20000, post, result, resultHeaders);

   if(status == -1)
     {
      int err = GetLastError();
      if(err == 4014)
         Print("Dave EA: WebRequest blocked (error 4014). Go to Tools > Options > Expert Advisors ",
               "and add the webhook host to 'Allow WebRequest for listed URL'.");
      else
         Print("Dave EA: WebRequest failed, error ", err);
      return;
     }
   if(status != 200)
     {
      Print("Dave EA: webhook responded with HTTP ", status, ": ", CharArrayToString(result));
      return;
     }

   ClearSentResults(); // delivered
   string response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   ExecuteCommandsFromResponse(response);
  }

//+------------------------------------------------------------------+
//| Docker-mode transport (see UseFileBridge). One request = one      |
//| file: line 1 is the URL, the rest is the JSON body. The relay     |
//| answers with a file whose line 1 is the HTTP status. Files are    |
//| written under a temp name and renamed, so neither side ever reads |
//| half a file.                                                      |
//+------------------------------------------------------------------+
bool FileBridgeRequest(const string body, int &status, string &response)
  {
   static int seq = 0;
   seq++;
   string id = IntegerToString((long)TimeLocal()) + "_" + IntegerToString(seq);
   string tmpName = BRIDGE_DIR + "\\req_" + id + ".tmp";
   string reqName = BRIDGE_DIR + "\\req_" + id + ".json";
   string resName = BRIDGE_DIR + "\\res_" + id + ".json";

   uchar data[];
   int n = StringToCharArray(WebhookURL + "\n" + body, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(n > 0 && data[n - 1] == 0) n--; // drop the terminating NUL
   int h = FileOpen(tmpName, FILE_WRITE | FILE_BIN);
   if(h == INVALID_HANDLE)
     {
      Print("Dave EA: bridge could not write a request, error ", GetLastError());
      return(false);
     }
   FileWriteArray(h, data, 0, n);
   FileClose(h);
   if(!FileMove(tmpName, 0, reqName, FILE_REWRITE))
     {
      Print("Dave EA: bridge could not publish a request, error ", GetLastError());
      FileDelete(tmpName);
      return(false);
     }

   uint started = GetTickCount();
   while(GetTickCount() - started < BRIDGE_TIMEOUT_MS)
     {
      if(FileIsExist(resName))
        {
         int r = FileOpen(resName, FILE_READ | FILE_BIN);
         if(r == INVALID_HANDLE) { Sleep(20); continue; }
         int size = (int)FileSize(r);
         uchar buf[];
         if(size > 0) FileReadArray(r, buf, 0, size);
         FileClose(r);
         FileDelete(resName);
         string text = size > 0 ? CharArrayToString(buf, 0, size, CP_UTF8) : "";
         int nl = StringFind(text, "\n");
         status = (int)StringToInteger(nl >= 0 ? StringSubstr(text, 0, nl) : text);
         response = nl >= 0 ? StringSubstr(text, nl + 1) : "";
         return(true);
        }
      Sleep(25);
     }
   FileDelete(reqName); // nobody picked it up -- don't let it be sent late
   Print("Dave EA: bridge got no answer in ", BRIDGE_TIMEOUT_MS, "ms -- is the container relay running?");
   return(false);
  }

//+------------------------------------------------------------------+
//| Real report: account, every open position, every pending order.  |
//| Manual-close detection happens Dave-side by comparing two         |
//| consecutive real reports -- this EA's only job is to always       |
//| report the truth, every time.                                     |
//+------------------------------------------------------------------+
string JsonEscape(string v)
  {
   // Fast path: nothing to escape (the usual case -- symbols, retcode texts).
   bool plain = true;
   int n = StringLen(v);
   for(int i = 0; i < n && plain; i++)
     {
      ushort c = StringGetCharacter(v, i);
      if(c == '"' || c == '\\' || c < 0x20) plain = false;
     }
   if(plain) return v;
   string out = "";
   for(int i = 0; i < n; i++)
     {
      ushort c = StringGetCharacter(v, i);
      if(c == '"') out += "\\\"";
      else if(c == '\\') out += "\\\\";
      else if(c == '\n') out += "\\n";
      else if(c == '\r') out += "\\r";
      else if(c == '\t') out += "\\t";
      else if(c < 0x20) out += StringFormat("\\u%04x", c);
      else out += ShortToString(c);
     }
   return out;
  }

// Broker server time -> real UTC. Every time the EA reports is UTC (the bot and Dave's own clock are
// UTC); MT5's bar/deal/calendar times are the broker's server clock (often UTC+2/+3), so a raw one
// labelled "Z" was hours off. The offset is rounded to 15 minutes (TimeTradeServer is an estimate).
long g_srvOffset = 0;
long SrvOffset()
  {
   long off = (long)(TimeTradeServer() - TimeGMT());
   return (long)MathRound(off / 900.0) * 900;
  }
string IsoUtc(datetime t)
  {
   MqlDateTime d; TimeToStruct(t, d);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02dZ", d.year, d.mon, d.day, d.hour, d.min, d.sec);
  }
string SrvToIso(datetime serverTime) { return serverTime <= 0 ? "" : IsoUtc((datetime)((long)serverTime - g_srvOffset)); }
string Px(double v, string sym) { return DoubleToString(v, (int)SymbolInfoInteger(sym, SYMBOL_DIGITS)); }

string BuildReportJson()
  {
   g_srvOffset = SrvOffset();
   string positions = "";
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(positions != "") positions += ",";
      string psym = PositionGetString(POSITION_SYMBOL);
      bool   isBuy = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
      // The price this position could close at RIGHT NOW (bid for a buy, ask for a sell).
      double curPrice = isBuy ? SymbolInfoDouble(psym, SYMBOL_BID) : SymbolInfoDouble(psym, SYMBOL_ASK);
      long magic = PositionGetInteger(POSITION_MAGIC);
      // Tickets are 64-bit: an (int) cast wrapped every ticket above ~2.1 billion into a wrong number.
      positions += "{\"ticket\":\"" + IntegerToString((long)ticket) + "\"," +
                   "\"symbol\":\"" + JsonEscape(psym) + "\"," +
                   "\"type\":\"" + (isBuy ? "buy" : "sell") + "\"," +
                   "\"lots\":" + DoubleToString(PositionGetDouble(POSITION_VOLUME), 2) + "," +
                   "\"openPrice\":" + Px(PositionGetDouble(POSITION_PRICE_OPEN), psym) + "," +
                   "\"sl\":" + Px(PositionGetDouble(POSITION_SL), psym) + "," +
                   "\"tp\":" + Px(PositionGetDouble(POSITION_TP), psym) + "," +
                   "\"currentPrice\":" + Px(curPrice, psym) + "," +
                   // MT5's own profit column (swap separate, as the terminal shows it).
                   "\"pnl\":" + DoubleToString(PositionGetDouble(POSITION_PROFIT), 2) + "," +
                   "\"swap\":" + DoubleToString(PositionGetDouble(POSITION_SWAP), 2) + "," +
                   "\"openTime\":\"" + SrvToIso((datetime)PositionGetInteger(POSITION_TIME)) + "\"," +
                   "\"magic\":" + IntegerToString(magic) + "," +
                   "\"byDave\":" + (magic == MagicNumber ? "true" : "false") + "," +
                   "\"comment\":\"" + JsonEscape(PositionGetString(POSITION_COMMENT)) + "\"," +
                   "\"digits\":" + IntegerToString(SymbolInfoInteger(psym, SYMBOL_DIGITS)) + "," +
                   // EA 3.3: the live spread and the broker's minimum stop distance, both in price.
                   // A stop fires on the other side of the spread, so a "breakeven" stop placed
                   // exactly on the entry closes a spread's worth in loss -- the bot needs the
                   // spread to put breakeven where the trade really closes at 0.00.
                   "\"spread\":" + Px(SymbolInfoDouble(psym, SYMBOL_ASK) - SymbolInfoDouble(psym, SYMBOL_BID), psym) + "," +
                   "\"stopsLevel\":" + Px(SymbolInfoInteger(psym, SYMBOL_TRADE_STOPS_LEVEL) * SymbolInfoDouble(psym, SYMBOL_POINT), psym) + "}";
     }

   string pendingOrders = "";
   int totalOrders = OrdersTotal();
   for(int i = 0; i < totalOrders; i++)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      if(pendingOrders != "") pendingOrders += ",";
      ENUM_ORDER_TYPE ot = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      string osym = OrderGetString(ORDER_SYMBOL);
      long omagic = OrderGetInteger(ORDER_MAGIC);
      pendingOrders += "{\"ticket\":\"" + IntegerToString((long)ticket) + "\"," +
                        "\"symbol\":\"" + JsonEscape(osym) + "\"," +
                        "\"type\":\"" + OrderTypeToString(ot) + "\"," +
                        "\"lots\":" + DoubleToString(OrderGetDouble(ORDER_VOLUME_CURRENT), 2) + "," +
                        "\"price\":" + Px(OrderGetDouble(ORDER_PRICE_OPEN), osym) + "," +
                        "\"sl\":" + Px(OrderGetDouble(ORDER_SL), osym) + "," +
                        "\"tp\":" + Px(OrderGetDouble(ORDER_TP), osym) + "," +
                        "\"placedTime\":\"" + SrvToIso((datetime)OrderGetInteger(ORDER_TIME_SETUP)) + "\"," +
                        "\"expiration\":\"" + SrvToIso((datetime)OrderGetInteger(ORDER_TIME_EXPIRATION)) + "\"," +
                        "\"byDave\":" + (omagic == MagicNumber ? "true" : "false") + "," +
                        "\"comment\":\"" + JsonEscape(OrderGetString(ORDER_COMMENT)) + "\"}";
     }

   string results = LastResultsJson();
   string closedPositions = BuildClosedPositionsJson();

   return "{\"type\":\"heartbeat\"," +
          "\"eaVersion\":\"" + EA_VERSION + "\"," +
          "\"account\":\"" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + "\"," +
          // The account holder's name and the broker server, so the app can say whose account it is.
          "\"accountName\":\"" + JsonEscape(AccountInfoString(ACCOUNT_NAME)) + "\"," +
          "\"server\":\"" + JsonEscape(AccountInfoString(ACCOUNT_SERVER)) + "\"," +
          "\"company\":\"" + JsonEscape(AccountInfoString(ACCOUNT_COMPANY)) + "\"," +
          "\"currency\":\"" + JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)) + "\"," +
          "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + "," +
          "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + "," +
          "\"profit\":" + DoubleToString(AccountInfoDouble(ACCOUNT_PROFIT), 2) + "," +
          "\"margin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN), 2) + "," +
          "\"freeMargin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) + "," +
          // MT5's own margin level (equity / margin, %); 0 with no open trades.
          "\"marginLevel\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 2) + "," +
          "\"leverage\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LEVERAGE)) + "," +
          // Whether this EA may place trades right now: the terminal's Algo Trading button AND the
          // EA's own "allow algo trading" permission. Off = every order fails, so Dave says so up
          // front instead of discovering it on the first trade.
          "\"algoTrading\":" + ((TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED)) ? "true" : "false") + "," +
          // Whether MT5 can push to the trader's phone (a MetaQuotes ID is set and push is on).
          "\"phonePush\":" + (TerminalInfoInteger(TERMINAL_NOTIFICATIONS_ENABLED) ? "true" : "false") + "," +
          // Broker clock minus UTC, in seconds -- how far MT5's own times are from real UTC.
          "\"serverUtcOffset\":" + IntegerToString(g_srvOffset) + "," +
          "\"positions\":[" + positions + "]," +
          "\"pendingOrders\":[" + pendingOrders + "]," +
          "\"results\":[" + results + "]," +
          "\"closedPositions\":[" + closedPositions + "]}";
  }

//+------------------------------------------------------------------+
//| A position that vanished since the last report: its REAL result  |
//| from MT5's deal history -- every deal of the position added up    |
//| (a partial close is several deals; commission is often charged    |
//| on the ENTRY deal), and the reason from the final closing deal.   |
//| MT5 sometimes hasn't written the closing deal yet on the very     |
//| next report, so such a position waits and is retried on the      |
//| following reports rather than going out as "$0, closed by hand".  |
//+------------------------------------------------------------------+
ulong g_lastTickets[];
ulong g_lastIds[];
ulong g_waitTickets[];
ulong g_waitIds[];
int   g_waitTries[];
#define CLOSE_RETRIES 6

bool ClosedPositionJson(ulong ticket, ulong posId, bool force, string &json)
  {
   string symbol = "", type = "", reason = "unknown";
   double profit = 0, swap = 0, comm = 0, fee = 0, volOut = 0, openPx = 0, closePx = 0;
   datetime openT = 0, closeT = 0;
   long magicOut = 0;
   bool anyOut = false;
   if(HistorySelectByPosition((long)posId))
     {
      int deals = HistoryDealsTotal();
      for(int d = 0; d < deals; d++)
        {
         ulong dt = HistoryDealGetTicket(d);
         if(dt == 0) continue;
         long entry = HistoryDealGetInteger(dt, DEAL_ENTRY);
         symbol = HistoryDealGetString(dt, DEAL_SYMBOL);
         profit += HistoryDealGetDouble(dt, DEAL_PROFIT);
         swap   += HistoryDealGetDouble(dt, DEAL_SWAP);
         comm   += HistoryDealGetDouble(dt, DEAL_COMMISSION);
         fee    += HistoryDealGetDouble(dt, DEAL_FEE);
         if(entry == DEAL_ENTRY_IN)
           {
            openPx = HistoryDealGetDouble(dt, DEAL_PRICE);
            openT  = (datetime)HistoryDealGetInteger(dt, DEAL_TIME);
            type   = HistoryDealGetInteger(dt, DEAL_TYPE) == DEAL_TYPE_BUY ? "buy" : "sell";
           }
         else if(entry == DEAL_ENTRY_OUT || entry == DEAL_ENTRY_OUT_BY || entry == DEAL_ENTRY_INOUT)
           {
            anyOut = true;
            volOut += HistoryDealGetDouble(dt, DEAL_VOLUME);
            closePx = HistoryDealGetDouble(dt, DEAL_PRICE);
            closeT  = (datetime)HistoryDealGetInteger(dt, DEAL_TIME);
            magicOut = HistoryDealGetInteger(dt, DEAL_MAGIC);
            long r = HistoryDealGetInteger(dt, DEAL_REASON);
            if(r == DEAL_REASON_TP) reason = "tp";
            else if(r == DEAL_REASON_SL) reason = "sl";
            else if(r == DEAL_REASON_SO) reason = "stopout";
            // DEAL_REASON_EXPERT is ANY expert advisor; only this EA's magic number is Dave.
            else if(r == DEAL_REASON_EXPERT) reason = (magicOut == MagicNumber ? "dave" : "manual");
            else reason = "manual";
           }
        }
     }
   if(!anyOut && !force) return false; // history not written yet -- try again next report
   double net = profit + swap + comm + fee;
   json = "{\"ticket\":\"" + IntegerToString((long)ticket) + "\"," +
          "\"symbol\":\"" + JsonEscape(symbol) + "\"," +
          "\"pnl\":" + DoubleToString(net, 2) + "," +
          "\"profit\":" + DoubleToString(profit, 2) + "," +
          "\"swap\":" + DoubleToString(swap, 2) + "," +
          "\"commission\":" + DoubleToString(comm + fee, 2) + "," +
          "\"reason\":\"" + reason + "\"," +
          "\"type\":\"" + type + "\"," +
          "\"volume\":" + DoubleToString(volOut, 2) + "," +
          "\"openPrice\":" + (symbol != "" ? Px(openPx, symbol) : "0") + "," +
          "\"closePrice\":" + (symbol != "" ? Px(closePx, symbol) : "0") + "," +
          "\"openTime\":\"" + SrvToIso(openT) + "\"," +
          "\"closeTime\":\"" + SrvToIso(closeT) + "\"," +
          "\"historyMissing\":" + (anyOut ? "false" : "true") + "}";
   return true;
  }

void AddWait(ulong ticket, ulong id)
  {
   int n = ArraySize(g_waitTickets);
   ArrayResize(g_waitTickets, n + 1); ArrayResize(g_waitIds, n + 1); ArrayResize(g_waitTries, n + 1);
   g_waitTickets[n] = ticket; g_waitIds[n] = id; g_waitTries[n] = 0;
  }

void RemoveWait(int i)
  {
   int n = ArraySize(g_waitTickets);
   for(int j = i; j < n - 1; j++) { g_waitTickets[j] = g_waitTickets[j + 1]; g_waitIds[j] = g_waitIds[j + 1]; g_waitTries[j] = g_waitTries[j + 1]; }
   ArrayResize(g_waitTickets, n - 1); ArrayResize(g_waitIds, n - 1); ArrayResize(g_waitTries, n - 1);
  }

string BuildClosedPositionsJson()
  {
   ulong currentTickets[], currentIds[];
   int total = PositionsTotal();
   ArrayResize(currentTickets, total);
   ArrayResize(currentIds, total);
   for(int i = 0; i < total; i++)
     {
      currentTickets[i] = PositionGetTicket(i);
      currentIds[i] = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
     }

   string out = "";
   // Retry the ones still waiting for their history first (oldest closes first).
   for(int w = ArraySize(g_waitTickets) - 1; w >= 0; w--)
     {
      g_waitTries[w]++;
      string js;
      if(ClosedPositionJson(g_waitTickets[w], g_waitIds[w], g_waitTries[w] >= CLOSE_RETRIES, js))
        {
         out += (out != "" ? "," : "") + js;
         RemoveWait(w);
        }
     }
   for(int i = 0; i < ArraySize(g_lastTickets); i++)
     {
      ulong ticket = g_lastTickets[i];
      bool stillOpen = false;
      for(int j = 0; j < ArraySize(currentTickets); j++)
         if(currentTickets[j] == ticket) { stillOpen = true; break; }
      if(stillOpen) continue;
      string js;
      if(ClosedPositionJson(ticket, g_lastIds[i], false, js)) out += (out != "" ? "," : "") + js;
      else AddWait(ticket, g_lastIds[i]);
     }

   ArrayResize(g_lastTickets, total);
   ArrayResize(g_lastIds, total);
   for(int i = 0; i < total; i++) { g_lastTickets[i] = currentTickets[i]; g_lastIds[i] = currentIds[i]; }
   return out;
  }

string OrderTypeToString(ENUM_ORDER_TYPE ot)
  {
   switch(ot)
     {
      case ORDER_TYPE_BUY_LIMIT: return "buy_limit";
      case ORDER_TYPE_SELL_LIMIT: return "sell_limit";
      case ORDER_TYPE_BUY_STOP: return "buy_stop";
      case ORDER_TYPE_SELL_STOP: return "sell_stop";
      default: return "unknown";
     }
  }

//+------------------------------------------------------------------+
//| Pending command results from the LAST batch executed, reported   |
//| on THIS report -- one report's worth of results at a time.        |
//+------------------------------------------------------------------+
string g_pendingResultsJson = "";

// Results stay queued until the bot has really received them (HTTP 200). They used to be cleared
// the moment the report was built -- one failed send (timeout, bridge hiccup) lost the analysis and
// the bot waited out its full 5-minute timeout for an answer that was never coming.
int g_sentResultsLen = 0;
string LastResultsJson()
  {
   g_sentResultsLen = StringLen(g_pendingResultsJson);
   return g_pendingResultsJson;
  }
void ClearSentResults()
  {
   if(g_sentResultsLen <= 0) return;
   g_pendingResultsJson = StringSubstr(g_pendingResultsJson, g_sentResultsLen);
   if(StringGetCharacter(g_pendingResultsJson, 0) == ',') g_pendingResultsJson = StringSubstr(g_pendingResultsJson, 1);
   g_sentResultsLen = 0;
  }

void AppendResult(string commandId, bool ok, string message, string ticket)
  {
   if(g_pendingResultsJson != "") g_pendingResultsJson += ",";
   g_pendingResultsJson += "{\"commandId\":\"" + commandId + "\"," +
                           "\"status\":\"" + (ok ? "ok" : "error") + "\"," +
                           "\"message\":\"" + JsonEscape(message) + "\"" +
                           (ticket != "" ? ",\"ticket\":\"" + ticket + "\"" : "") + "}";
  }

// Item 5 (DAVEMA retirement): the "analyze" command's real result carries a raw computed JSON
// object in `data`, not a ticket/message -- this is the on-demand replacement for what DAVEMA
// used to return over HTTP, reported back through this SAME command-result channel.
void AppendResultData(string commandId, string dataJson)
  {
   if(g_pendingResultsJson != "") g_pendingResultsJson += ",";
   g_pendingResultsJson += "{\"commandId\":\"" + commandId + "\"," +
                           "\"status\":\"ok\"," +
                           "\"data\":" + dataJson + "}";
  }

//+------------------------------------------------------------------+
//| Narrow parser for Dave's OWN response shape                       |
//| {"commands":[{"id":"...","action":"...","symbol":"...", ...}]}    |
//| -- deliberately not a general JSON parser (MQL5 has none built    |
//| in); this only needs to understand the exact contract this EA     |
//| and dave-ea-bridge's webhook both implement.                      |
//+------------------------------------------------------------------+
// --- A small JSON reader for Dave's own command shape -----------------------------------------------
// String-aware: a quote, brace or bracket inside a value (a trade note, the full reasoning) never
// breaks it. The old reader split on the first "}" / "]" it saw, so a "}" inside a comment cut a
// command in half and dropped every command after it.
int JsonSkipString(const string s, int i) // i at the opening quote -> index just past the closing quote
  {
   int n = StringLen(s);
   i++;
   while(i < n)
     {
      ushort c = StringGetCharacter(s, i);
      if(c == '\\') { i += 2; continue; }
      if(c == '"') return i + 1;
      i++;
     }
   return n;
  }

bool JsonIsSpace(ushort c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

// The top-level objects of the response's "commands" array.
int SplitCommandObjects(const string response, string &objs[])
  {
   ArrayResize(objs, 0);
   int p = StringFind(response, "\"commands\"");
   if(p < 0) return 0;
   p = StringFind(response, "[", p);
   if(p < 0) return 0;
   int n = StringLen(response), depth = 0, start = -1;
   for(int i = p + 1; i < n; i++)
     {
      ushort c = StringGetCharacter(response, i);
      if(c == '"') { i = JsonSkipString(response, i) - 1; continue; }
      if(c == '{' || c == '[')
        {
         if(depth == 0 && c == '{') start = i;
         depth++;
        }
      else if(c == '}' || c == ']')
        {
         if(depth == 0) break; // the end of the commands array
         depth--;
         if(depth == 0 && c == '}' && start >= 0)
           {
            int k = ArraySize(objs);
            ArrayResize(objs, k + 1);
            objs[k] = StringSubstr(response, start, i - start + 1);
            start = -1;
           }
        }
     }
   return ArraySize(objs);
  }

// Where a TOP-LEVEL key's value starts inside one object, or -1. Keys inside nested values or inside
// strings never match.
int JsonFindValue(const string obj, const string key)
  {
   int n = StringLen(obj), depth = 0, i = 0;
   while(i < n)
     {
      ushort c = StringGetCharacter(obj, i);
      if(c == '"')
        {
         int end = JsonSkipString(obj, i);
         if(depth == 1)
           {
            int j = end;
            while(j < n && JsonIsSpace(StringGetCharacter(obj, j))) j++;
            if(j < n && StringGetCharacter(obj, j) == ':')
              {
               j++;
               while(j < n && JsonIsSpace(StringGetCharacter(obj, j))) j++;
               if(StringSubstr(obj, i + 1, end - i - 2) == key) return j;
               // not this key: skip its value if it is a string (nested values are depth-tracked)
               if(j < n && StringGetCharacter(obj, j) == '"') { i = JsonSkipString(obj, j); continue; }
               i = j;
               continue;
              }
           }
         i = end;
         continue;
        }
      if(c == '{' || c == '[') depth++;
      else if(c == '}' || c == ']') depth--;
      i++;
     }
   return -1;
  }

int JsonHexDigit(ushort c)
  {
   if(c >= '0' && c <= '9') return c - '0';
   if(c >= 'a' && c <= 'f') return c - 'a' + 10;
   if(c >= 'A' && c <= 'F') return c - 'A' + 10;
   return 0;
  }

// A string value with its escapes decoded (\" \\ \n \t \uXXXX ...).
string JsonDecodeString(const string s, int i) // i at the opening quote
  {
   string out = "";
   int n = StringLen(s);
   i++;
   int run = i;
   while(i < n)
     {
      ushort c = StringGetCharacter(s, i);
      if(c == '"') return out + StringSubstr(s, run, i - run);
      if(c == '\\' && i + 1 < n)
        {
         out += StringSubstr(s, run, i - run);
         ushort e = StringGetCharacter(s, i + 1);
         if(e == 'n') out += "\n";
         else if(e == 't') out += "\t";
         else if(e == 'r') out += "\r";
         else if(e == 'b' || e == 'f') { }
         else if(e == 'u' && i + 5 < n)
           {
            int code = 0;
            for(int h = 2; h <= 5; h++) code = code * 16 + JsonHexDigit(StringGetCharacter(s, i + h));
            out += ShortToString((ushort)code);
            i += 6; run = i;
            continue;
           }
         else out += ShortToString(e);
         i += 2; run = i;
         continue;
        }
      i++;
     }
   return out + StringSubstr(s, run);
  }

// A string value; for a non-string value (a ticket sent as a number) its raw text.
string JsonGetString(string obj, string key)
  {
   int v = JsonFindValue(obj, key);
   if(v < 0) return "";
   if(StringGetCharacter(obj, v) == '"') return JsonDecodeString(obj, v);
   int e = v, n = StringLen(obj);
   while(e < n) { ushort c = StringGetCharacter(obj, e); if(c == ',' || c == '}' || c == ']' || JsonIsSpace(c)) break; e++; }
   string raw = StringSubstr(obj, v, e - v);
   return raw == "null" ? "" : raw;
  }

double JsonGetNumber(string obj, string key, double fallback)
  {
   int v = JsonFindValue(obj, key);
   if(v < 0) return fallback;
   int n = StringLen(obj);
   if(StringGetCharacter(obj, v) == '"') v++; // a number sent as a string
   int e = v;
   while(e < n)
     {
      ushort c = StringGetCharacter(obj, e);
      if((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') e++;
      else break;
     }
   if(e == v) return fallback;
   return StringToDouble(StringSubstr(obj, v, e - v));
  }

// "field absent" (don't touch), explicit JSON null (remove -> 0) and a real number (set) are three
// different things for modify: the bridge only sends the side(s) actually being changed.
bool JsonHasKey(string obj, string key) { return JsonFindValue(obj, key) >= 0; }

bool JsonIsNull(string obj, string key)
  {
   int v = JsonFindValue(obj, key);
   return v >= 0 && StringSubstr(obj, v, 4) == "null";
  }

/**
 * Batch scans: MT5 downloads a symbol/timeframe's history in the background the first time anything
 * asks for it. Asking for every "analyze" command's series up front, in one quick pass, lets those
 * downloads run while the earlier commands in the batch are being computed.
 */
void PrewarmAnalysisSymbols(string &objs[])
  {
   for(int i = 0; i < ArraySize(objs); i++)
     {
      if(JsonGetString(objs[i], "action") != "analyze") continue;
      string symbol = ResolveBrokerSymbol(JsonGetString(objs[i], "symbol"));
      if(symbol == "") continue;
      ENUM_TIMEFRAMES tf = TimeframeFromString(JsonGetString(objs[i], "timeframe"));
      SymbolSelect(symbol, true);
      SeriesReady(symbol, tf); // starts a background load when it isn't there yet -- never waits
     }
  }

void ExecuteCommandsFromResponse(string response)
  {
   string objs[];
   if(SplitCommandObjects(response, objs) == 0) return; // no commands this cycle
   PrewarmAnalysisSymbols(objs);
   for(int i = 0; i < ArraySize(objs); i++)
      ExecuteOneCommand(objs[i]);
  }

void ExecuteOneCommand(string obj)
  {
   string id = JsonGetString(obj, "id");
   string action = JsonGetString(obj, "action");

   if(action == "open")
     {
      string symbol = ResolveBrokerSymbol(JsonGetString(obj, "symbol"));
      string type = JsonGetString(obj, "type");
      double lots = JsonGetNumber(obj, "lots", 0);
      double price = JsonGetNumber(obj, "price", 0);
      double sl = JsonGetNumber(obj, "sl", 0);
      double tp = JsonGetNumber(obj, "tp", 0);
      // Real gap fixed (user, live: the reasoning behind a trade never reached MT5 itself, only
      // Dave's own internal log) -- passed through as CTrade's real trailing comment argument so
      // the order is visibly labeled inside the terminal, not just in the bot's own history.
      string comment = JsonGetString(obj, "comment");
      // Real gap fixed (user, live: wants the SAME full reasoning that reaches Telegram to also
      // reach MT5 itself as a real push notification/email -- not just the short `comment` above,
      // which has its own separate, much tighter broker-enforced length limit). This is a
      // SEPARATE field, never used as the CTrade comment argument -- only passed to
      // NotifyTradeEvent below, which splits it across as many numbered push notifications as it
      // takes to deliver it in full (SendNotification's real ~255-char cap is per message), and
      // sends it in one piece via SendMail.
      string pushMessage = JsonGetString(obj, "pushMessage");
      bool ok = false;
      // Real bug fixed here: this used to only ever call trade.Buy/trade.Sell
      // (always market price, ignoring the "price" field entirely), so the 4
      // pending order types this SAME EA reports on in BuildReportJson could
      // never actually be placed via a Dave-issued "open" command -- silently
      // dropped as an unmatched type. All 6 real order types now handled.
      if(type == "buy") ok = trade.Buy(lots, symbol, 0, sl, tp, comment);
      else if(type == "sell") ok = trade.Sell(lots, symbol, 0, sl, tp, comment);
      else if(type == "buy_limit") { price = EnforcePendingPrice(symbol, type, price); ok = trade.BuyLimit(lots, price, symbol, sl, tp, ORDER_TIME_GTC, 0, comment); }
      else if(type == "sell_limit") { price = EnforcePendingPrice(symbol, type, price); ok = trade.SellLimit(lots, price, symbol, sl, tp, ORDER_TIME_GTC, 0, comment); }
      else if(type == "buy_stop") { price = EnforcePendingPrice(symbol, type, price); ok = trade.BuyStop(lots, price, symbol, sl, tp, ORDER_TIME_GTC, 0, comment); }
      else if(type == "sell_stop") { price = EnforcePendingPrice(symbol, type, price); ok = trade.SellStop(lots, price, symbol, sl, tp, ORDER_TIME_GTC, 0, comment); }
      ulong ticket = ok ? trade.ResultOrder() : 0;
      AppendResult(id, ok, ok ? "opened" : ("failed: " + trade.ResultRetcodeDescription()), ok ? IntegerToString((int)ticket) : "");
      if(ok) NotifyTradeEvent("Opened " + type + " " + DoubleToString(lots, 2) + " " + symbol, pushMessage);
      else NotifyTradeEvent("FAILED to open " + type + " " + symbol + ": " + trade.ResultRetcodeDescription(), pushMessage);
     }
   else if(action == "modify")
     {
      string ticketStr = JsonGetString(obj, "ticket");
      ulong ticket = (ulong)StringToInteger(ticketStr);
      if(!PositionSelectByTicket(ticket) && OrderSelect(ticket))
        {
         // A PENDING order's SL/TP: same absent/null/number rules, the entry price and
         // expiry stay exactly as they are.
         double curSL = OrderGetDouble(ORDER_SL);
         double curTP = OrderGetDouble(ORDER_TP);
         double newSL = !JsonHasKey(obj, "sl") ? curSL : (JsonIsNull(obj, "sl") ? 0 : JsonGetNumber(obj, "sl", curSL));
         double newTP = !JsonHasKey(obj, "tp") ? curTP : (JsonIsNull(obj, "tp") ? 0 : JsonGetNumber(obj, "tp", curTP));
         bool ok = trade.OrderModify(ticket, OrderGetDouble(ORDER_PRICE_OPEN), newSL, newTP,
                                     (ENUM_ORDER_TYPE_TIME)OrderGetInteger(ORDER_TYPE_TIME), (datetime)OrderGetInteger(ORDER_TIME_EXPIRATION));
         AppendResult(id, ok, ok ? "modified" : ("failed: " + trade.ResultRetcodeDescription()), "");
        }
      else if(!PositionSelectByTicket(ticket))
        {
         AppendResult(id, false, "ticket not found", "");
        }
      else
        {
         double curSL = PositionGetDouble(POSITION_SL);
         double curTP = PositionGetDouble(POSITION_TP);
         // sl/tp absent entirely -> leave unchanged. Present as JSON null ->
         // remove (0). Present as a real number -> set to that number. This
         // is the real fix for "no way to remove SL/TP independently" AND
         // for the fallback-0-wipes-the-other-field bug described above.
         double newSL = !JsonHasKey(obj, "sl") ? curSL : (JsonIsNull(obj, "sl") ? 0 : JsonGetNumber(obj, "sl", curSL));
         double newTP = !JsonHasKey(obj, "tp") ? curTP : (JsonIsNull(obj, "tp") ? 0 : JsonGetNumber(obj, "tp", curTP));
         bool ok = trade.PositionModify(ticket, newSL, newTP);
         AppendResult(id, ok, ok ? "modified" : ("failed: " + trade.ResultRetcodeDescription()), "");
        }
     }
   else if(action == "close")
     {
      string ticketStr = JsonGetString(obj, "ticket");
      ulong ticket = (ulong)StringToInteger(ticketStr);
      // Real gap fixed here too: "lots" was accepted in the command shape
      // (dave-trading's closePosition(ticket, lots?) sends it for a partial
      // close) but this handler ignored it and always fully closed the
      // position via PositionClose(). CTrade::PositionClosePartial() is the
      // real, separate method for a partial close.
      double partialLots = JsonGetNumber(obj, "lots", 0);
      bool ok = (partialLots > 0) ? trade.PositionClosePartial(ticket, partialLots) : trade.PositionClose(ticket);
      AppendResult(id, ok, ok ? "closed" : ("failed: " + trade.ResultRetcodeDescription()), "");
      if(ok) NotifyTradeEvent((partialLots > 0 ? "Partially closed (" + DoubleToString(partialLots, 2) + " lots) " : "Closed ") + "position #" + ticketStr);
     }
   else if(action == "delete_pending")
     {
      string ticketStr = JsonGetString(obj, "ticket");
      ulong ticket = (ulong)StringToInteger(ticketStr);
      bool ok = trade.OrderDelete(ticket);
      AppendResult(id, ok, ok ? "deleted" : ("failed: " + trade.ResultRetcodeDescription()), "");
     }
   else if(action == "analyze")
     {
      string symbol = ResolveBrokerSymbol(JsonGetString(obj, "symbol"));
      string tfStr = JsonGetString(obj, "timeframe");
      string endpoint = JsonGetString(obj, "endpoint");
      RunAnalysis(id, endpoint, symbol, tfStr, obj);
     }
   else if(action == "set_push_interval")
     {
      // Item 5 real gap fixed: a real, live-applied override of the EA's push/heartbeat cadence,
      // requested from Dave's /connection settings screen. Clamped to a sane real range so a bad
      // value can never make the EA hammer the webhook or effectively stop reporting.
      int seconds = (int)JsonGetNumber(obj, "seconds", g_pushIntervalSeconds);
      // Floor is 1, matching EventSetTimer()'s own real practical floor (and the compiled default
      // above) -- was 3 when the compiled default was still 120; keeping a stricter runtime floor
      // than the default itself made no sense.
      if(seconds < 1) seconds = 1;
      if(seconds > 300) seconds = 300;
      g_pushIntervalSeconds = seconds; // the full-report cadence; the 1 s poll timer stays
      AppendResult(id, true, "push interval set to " + IntegerToString(g_pushIntervalSeconds) + "s", "");
     }
   else if(action == "market_watch")
     {
      // Every pair from every pair group goes into MT5's own Market Watch (the trader: "all those
      // group pairs should be automatically added"). Broker suffixes are resolved (EURUSD ->
      // EURUSDm); pairs this broker doesn't list are reported back, never guessed. No charts.
      string parts[];
      int n = StringSplit(JsonGetString(obj, "symbols"), ',', parts);
      int added = 0, asked = 0;
      string missing = "";
      for(int i = 0; i < n; i++)
        {
         string base = parts[i];
         StringTrimLeft(base);
         StringTrimRight(base);
         if(StringLen(base) == 0) continue;
         asked++;
         if(SelectExactOrSuffixed(base)) added++;
         else missing += (missing == "" ? "" : ", ") + base;
        }
      AppendResult(id, true, IntegerToString(added) + " of " + IntegerToString(asked) + " pairs in Market Watch" +
                   (missing != "" ? " (not on this broker: " + missing + ")" : ""), "");
     }
   else
     {
      AppendResult(id, false, "unknown action \"" + action + "\"", "");
     }
  }

//+------------------------------------------------------------------+
//| ITEM 5 -- DAVEMA RETIREMENT: real on-demand analysis, computed     |
//| locally, right here in the EA -- no external API call. Ported     |
//| from the REAL reference DAVEMA EA's own indicator math (same      |
//| SMA/EMA/RSI/MACD/Stochastic/CCI/WilliamsR/ATR/StdDev formulas),    |
//| not guessed. This is a genuinely SEPARATE on-demand computation   |
//| from the heartbeat above -- PushSeconds/OnTimer is completely     |
//| untouched; this only runs when a real "analyze" command arrives.  |
//|                                                                    |
//| ITEM 13 -- MULTI-SYMBOL FROM ONE CHART: CopySeries below loads     |
//| bars for WHATEVER symbol+timeframe the command asks for, not the  |
//| chart's own symbol/period -- one EA instance can analyze any      |
//| symbol in Market Watch, not just the one it's attached to.        |
//+------------------------------------------------------------------+

// Real gap fixed (user: "it should have the ability to use any tf" -- only 8 of MT5's real 21
// timeframes were ever mapped, so any other real, legal one (M2/M3/M4/M6/M10/M12/M20/H2/H3/H6/
// H8/H12/MN1) silently fell through to the M15 default instead of genuinely being used).
ENUM_TIMEFRAMES TimeframeFromString(string tf)
  {
   if(tf == "M1")  return PERIOD_M1;
   if(tf == "M2")  return PERIOD_M2;
   if(tf == "M3")  return PERIOD_M3;
   if(tf == "M4")  return PERIOD_M4;
   if(tf == "M5")  return PERIOD_M5;
   if(tf == "M6")  return PERIOD_M6;
   if(tf == "M10") return PERIOD_M10;
   if(tf == "M12") return PERIOD_M12;
   if(tf == "M15") return PERIOD_M15;
   if(tf == "M20") return PERIOD_M20;
   if(tf == "M30") return PERIOD_M30;
   if(tf == "H1")  return PERIOD_H1;
   if(tf == "H2")  return PERIOD_H2;
   if(tf == "H3")  return PERIOD_H3;
   if(tf == "H4")  return PERIOD_H4;
   if(tf == "H6")  return PERIOD_H6;
   if(tf == "H8")  return PERIOD_H8;
   if(tf == "H12") return PERIOD_H12;
   if(tf == "D1")  return PERIOD_D1;
   if(tf == "W1")  return PERIOD_W1;
   if(tf == "MN1") return PERIOD_MN1;
   return PERIOD_M15; // real DAVEMA default, ported verbatim -- only for a genuinely unrecognized string
  }

//+------------------------------------------------------------------+
//| EA 4.0 ANALYSIS ENGINE                                            |
//|                                                                    |
//| One memory slot per symbol+timeframe ("EURUSD|H1"): its candles    |
//| (oldest first, the last one is the candle still forming) and the   |
//| shared engines every endpoint reads -- one ATR, one set of moving  |
//| averages, one swing finder. Everything is worked out on CLOSED     |
//| candles, only again when a new candle closes, and each endpoint's  |
//| answer is kept until then, so a request is answered from memory.  |
//|                                                                    |
//| Lessons kept from 3.x (they cost container restarts):             |
//|  - never wait for another pair's history: a series is read only    |
//|    when MT5 has it (SERIES_SYNCHRONIZED); otherwise a background   |
//|    load starts (an indicator handle, never blocks), max 4 a request|
//|  - a background load is let go once its history has arrived        |
//|  - every array read is bounds-checked (an out-of-range read makes  |
//|    MT5 switch the EA off)                                          |
//|  - the economic calendar is read at most every 10 minutes          |
//+------------------------------------------------------------------+

#define SLOT_BARS   600
#define SLOT_MAX    60
#define CH_COUNT    16
// chain ids (index into CSlot.cache)
#define CH_CANDLES  0
#define CH_MS       1
#define CH_LIQ      2
#define CH_ZONES    3
#define CH_TREND    4
#define CH_MOM      5
#define CH_VOLAT    6
#define CH_VOLUME   7
#define CH_LEVELS   8
#define CH_PATTERNS 9

string   g_aErr = "";

// --- JSON helpers --------------------------------------------------------------------------------
string J(string k, string v)          { return "\"" + k + "\":\"" + v + "\""; }
string Js(string k, string v)         { return "\"" + k + "\":\"" + JsonEscape(v) + "\""; }
string Jn(string k, double v, int d=6){ return "\"" + k + "\":" + (MathIsValidNumber(v) ? DoubleToString(v, d) : "null"); }
string Jp(string k, double v, int d)  { return "\"" + k + "\":" + ((v > 0 && MathIsValidNumber(v)) ? DoubleToString(v, d) : "null"); }
string Ji(string k, long v)           { return "\"" + k + "\":" + IntegerToString(v); }
string Jb(string k, bool v)           { return "\"" + k + "\":" + (v ? "true" : "false"); }
string Jr(string k, string rawJson)   { return "\"" + k + "\":" + rawJson; }
string Jnull(string k)                { return "\"" + k + "\":null"; }
string Jwhy(string k, string why)     { return "\"" + k + "\":null,\"" + k + "_why\":\"" + JsonEscape(why) + "\""; }
string Obj(string body)               { return "{" + body + "}"; }
string Arr(string &a[])               { return "[" + A_Join(a) + "]"; }
string A_Join(string &a[], string sep=",")
  {
   string s = "";
   for(int i = 0; i < ArraySize(a); i++) { if(i > 0) StringAdd(s, sep); StringAdd(s, a[i]); }
   return s;
  }
void A_Push(string &arr[], string v) { int n = ArraySize(arr); ArrayResize(arr, n + 1); arr[n] = v; }
string TfName(ENUM_TIMEFRAMES tf) { string t = EnumToString(tf); StringReplace(t, "PERIOD_", ""); return t; }

// --- Time zones (sessions are defined in LOCAL market time, with real summer-time rules) ---------
int DaysInMonth(int y, int m)
  {
   if(m == 2) return ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0) ? 29 : 28;
   if(m == 4 || m == 6 || m == 9 || m == 11) return 30;
   return 31;
  }
datetime MkTime(int y, int m, int d, int h)
  {
   MqlDateTime s; ZeroMemory(s);
   s.year = y; s.mon = m; s.day = d; s.hour = h;
   return StructToTime(s);
  }
int DowOf(int y, int m, int d) { MqlDateTime o; TimeToStruct(MkTime(y, m, d, 0), o); return o.day_of_week; }
int NthSunday(int y, int m, int n) { int w = DowOf(y, m, 1); return 1 + ((7 - w) % 7) + (n - 1) * 7; }
int LastSunday(int y, int m) { int dim = DaysInMonth(y, m); return dim - DowOf(y, m, dim); }
#define TZ_UTC 0
#define TZ_LONDON 1
#define TZ_NEWYORK 2
#define TZ_TOKYO 3
#define TZ_SYDNEY 4
int ZoneOffset(int zone, datetime utc)
  {
   MqlDateTime u; TimeToStruct(utc, u);
   int y = u.year;
   if(zone == TZ_LONDON)
     {
      datetime a = MkTime(y, 3, LastSunday(y, 3), 1), b = MkTime(y, 10, LastSunday(y, 10), 1);
      return (utc >= a && utc < b) ? 1 : 0;
     }
   if(zone == TZ_NEWYORK)
     {
      datetime a = MkTime(y, 3, NthSunday(y, 3, 2), 7), b = MkTime(y, 11, NthSunday(y, 11, 1), 6);
      return (utc >= a && utc < b) ? -4 : -5;
     }
   if(zone == TZ_TOKYO) return 9;
   if(zone == TZ_SYDNEY)
     {
      datetime endA = (datetime)((long)MkTime(y, 4, NthSunday(y, 4, 1), 0) - 8 * 3600);
      datetime startO = (datetime)((long)MkTime(y, 10, NthSunday(y, 10, 1), 0) - 8 * 3600);
      return (utc < endA || utc >= startO) ? 11 : 10;
     }
   return 0;
  }
datetime LocalOf(int zone, datetime utc) { return (datetime)((long)utc + ZoneOffset(zone, utc) * 3600); }
int LocalMinuteOfDay(int zone, datetime utc) { MqlDateTime d; TimeToStruct(LocalOf(zone, utc), d); return d.hour * 60 + d.min; }
// UTC time of today's (in that zone) local hh:mm -- dayShift -1 = yesterday.
datetime UtcOfLocal(int zone, datetime nowUtc, int hh, int mm, int dayShift)
  {
   datetime loc = LocalOf(zone, nowUtc);
   long day0 = (long)loc - ((long)loc % 86400) + (long)dayShift * 86400;
   long locT = day0 + hh * 3600 + mm * 60;
   // convert local -> utc with the offset at that moment (iterate once for DST edges)
   long u = locT - ZoneOffset(zone, (datetime)locT) * 3600;
   u = locT - ZoneOffset(zone, (datetime)u) * 3600;
   return (datetime)u;
  }
string HHMM(int minutes) { return StringFormat("%02d:%02d", minutes / 60, minutes % 60); }

// --- Broker names for other pairs (EURUSD may be "EURUSDm") ---------------------------------------
string g_resBase[];
string g_resName[];
string ResolvedName(string base)
  {
   for(int i = 0; i < ArraySize(g_resBase); i++) if(g_resBase[i] == base) return g_resName[i];
   string nm = ResolveBrokerSymbol(base);
   if(!SymbolSelect(nm, true) || SymbolInfoDouble(nm, SYMBOL_POINT) <= 0) nm = "";
   int n = ArraySize(g_resBase);
   ArrayResize(g_resBase, n + 1); ArrayResize(g_resName, n + 1);
   g_resBase[n] = base; g_resName[n] = nm;
   return nm;
  }

// --- Background history loads (never block) --------------------------------------------------------
string g_warmK[];
int    g_warmH[];
int    g_warmBudget = 4;
bool SeriesReady(string s, ENUM_TIMEFRAMES tf)
  {
   if(s == "") return false;
   if(SeriesInfoInteger(s, tf, SERIES_SYNCHRONIZED)) return true;
   string k = s + "|" + IntegerToString((int)tf);
   for(int i = 0; i < ArraySize(g_warmK); i++) if(g_warmK[i] == k) return false;
   int n = ArraySize(g_warmK);
   if(n < 200 && g_warmBudget > 0)
     {
      int h = iMA(s, tf, 1, 0, MODE_SMA, PRICE_CLOSE); // starts the download without waiting
      if(h == INVALID_HANDLE) return false;
      g_warmBudget--;
      ArrayResize(g_warmK, n + 1); ArrayResize(g_warmH, n + 1);
      g_warmK[n] = k; g_warmH[n] = h;
     }
   return false;
  }
void ReleaseLoadedSeries()
  {
   for(int i = ArraySize(g_warmK) - 1; i >= 0; i--)
     {
      if(BarsCalculated(g_warmH[i]) <= 0) continue;
      IndicatorRelease(g_warmH[i]);
      int last = ArraySize(g_warmK) - 1;
      g_warmK[i] = g_warmK[last]; g_warmH[i] = g_warmH[last];
      ArrayResize(g_warmK, last); ArrayResize(g_warmH, last);
     }
  }
void ReleaseAllWarm()
  {
   for(int i = 0; i < ArraySize(g_warmH); i++) IndicatorRelease(g_warmH[i]);
   ArrayFree(g_warmK); ArrayFree(g_warmH);
  }

// --- Symbol facts -----------------------------------------------------------------------------------
double PipOf(string sym)
  {
   int d = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double pt = SymbolInfoDouble(sym, SYMBOL_POINT);
   double pip = (d == 3 || d == 5) ? pt * 10 : pt;
   return pip > 0 ? pip : (pt > 0 ? pt : 0.0001);
  }
// 24/7 symbols (synthetic indices, crypto): MT5 lists a trading session on Saturday.
bool Is247(string sym)
  {
   datetime f, t;
   return SymbolInfoSessionTrade(sym, SATURDAY, 0, f, t);
  }
bool IsForex(string sym)
  {
   return SymbolInfoInteger(sym, SYMBOL_TRADE_CALC_MODE) == SYMBOL_CALC_MODE_FOREX ||
          SymbolInfoInteger(sym, SYMBOL_TRADE_CALC_MODE) == SYMBOL_CALC_MODE_FOREX_NO_LEVERAGE;
  }
bool IsSynthetic(string sym) { return Is247(sym) && !IsForex(sym); }
string PxS(string sym, double v) { return DoubleToString(v, (int)SymbolInfoInteger(sym, SYMBOL_DIGITS)); }

//+------------------------------------------------------------------+
//| The memory slot                                                   |
//+------------------------------------------------------------------+
class CSlot
  {
public:
   string            sym;
   ENUM_TIMEFRAMES   tf;
   string            key;
   int               n;             // candles held; [n-1] = still forming
   int               lc;            // last CLOSED candle index (n-2)
   double            o[], h[], l[], c[];
   long              v[];
   datetime          t[];
   datetime          lastClosedTime; // time of candle [lc] the engines were built for
   datetime          loadedAt;       // TimeLocal of the last refresh
   datetime          lastUsed;
   bool              stale;          // newest candle behind the last tick
   bool              fromCache;      // refresh failed, older candles kept
   int               digits;
   double            point, pip;
   // engines
   double            atr[], atr10[], ema20[], ema50[], ema200[], smma6[], smma20[], smma100[];
   double            rsi[], macd[], macdSig[], stK[], stD[], adx[], pdi[], mdi[], st[];
   int               stDir[];
   // swings: internal fractal 2/2 (APA, wicks) and external fractal 5/5
   int               swI[];  double swP[]; int swK[];   // kind +1 high, -1 low
   int               exI[];  double exP[]; int exK[];
   // chain answers built for lastClosedTime
   string            cache[CH_COUNT];
   ulong             chUs[CH_COUNT];
   datetime          cacheAt[CH_COUNT];
   datetime          lastAsked;      // last time the bot asked for this one (precompute keeps it warm)
  };

CSlot *g_slots[];

CSlot *FindSlot(string key)
  {
   for(int i = 0; i < ArraySize(g_slots); i++)
      if(CheckPointer(g_slots[i]) != POINTER_INVALID && g_slots[i].key == key) return g_slots[i];
   return NULL;
  }

void EvictSlots()
  {
   // keep at most SLOT_MAX; drop the ones not used for the longest (and anything unused for 2 h)
   datetime now = TimeLocal();
   for(int i = ArraySize(g_slots) - 1; i >= 0; i--)
     {
      bool drop = CheckPointer(g_slots[i]) == POINTER_INVALID || now - g_slots[i].lastUsed > 7200;
      if(!drop && ArraySize(g_slots) > SLOT_MAX)
        {
         int oldest = 0;
         for(int j = 1; j < ArraySize(g_slots); j++)
            if(g_slots[j].lastUsed < g_slots[oldest].lastUsed) oldest = j;
         drop = (oldest == i);
        }
      if(!drop) continue;
      if(CheckPointer(g_slots[i]) == POINTER_DYNAMIC) delete g_slots[i];
      int last = ArraySize(g_slots) - 1;
      g_slots[i] = g_slots[last];
      ArrayResize(g_slots, last);
     }
  }

void FreeSlots()
  {
   for(int i = 0; i < ArraySize(g_slots); i++)
      if(CheckPointer(g_slots[i]) == POINTER_DYNAMIC) delete g_slots[i];
   ArrayFree(g_slots);
  }

int MinBarsFor(ENUM_TIMEFRAMES tf) { return tf == PERIOD_MN1 ? 24 : tf == PERIOD_W1 ? 52 : 120; }

void BuildEngines(CSlot *s);

// Loads (or refreshes) a slot. wait = how long it may wait (ms) for MT5 to catch up; 0 for other
// pairs/timeframes read as context (never blocks: not loaded = NULL and a background load starts).
CSlot *GetSlot(string sym, ENUM_TIMEFRAMES tf, int waitMs)
  {
   if(sym == "" || SymbolInfoDouble(sym, SYMBOL_POINT) <= 0) return NULL;
   string key = sym + "|" + TfName(tf);
   CSlot *s = FindSlot(key);
   bool ready = SeriesReady(sym, tf);
   if(!ready && waitMs > 0)
     {
      for(int w = 0; w < waitMs / 100 && !ready; w++) { Sleep(100); ready = SeriesInfoInteger(sym, tf, SERIES_SYNCHRONIZED) != 0; }
     }
   if(!ready && waitMs <= 0 && s == NULL) return NULL;

   datetime bar0 = ready ? iTime(sym, tf, 0) : 0;
   bool needLoad = s == NULL || (ready && bar0 > 0 && (s.n < 2 || s.t[s.n - 1] != bar0)) || (ready && TimeLocal() - s.loadedAt >= 1);
   if(s != NULL && !needLoad) { s.lastUsed = TimeLocal(); return s; }

   MqlRates r[];
   int got = -1;
   if(ready || waitMs > 0)
     {
      got = CopyRates(sym, tf, 0, SLOT_BARS, r); // oldest first
      long lastTick = SymbolInfoInteger(sym, SYMBOL_TIME);
      // the newest candle must be the candle of the latest tick (MT5 can lag a candle behind)
      for(int w = 0; w < waitMs / 100 && got > 0 && lastTick > 0 && iBarShift(sym, tf, (datetime)lastTick, true) != 0; w++)
        {
         Sleep(100);
         got = CopyRates(sym, tf, 0, SLOT_BARS, r);
        }
     }
   if(got < MinBarsFor(tf))
     {
      if(s != NULL) { s.fromCache = true; s.lastUsed = TimeLocal(); return s; }
      return NULL;
     }
   if(s == NULL)
     {
      s = new CSlot();
      s.sym = sym; s.tf = tf; s.key = key; s.lastClosedTime = 0; s.lastAsked = 0;
      int k = ArraySize(g_slots);
      ArrayResize(g_slots, k + 1);
      g_slots[k] = s;
     }
   s.n = got;
   ArrayResize(s.o, got); ArrayResize(s.h, got); ArrayResize(s.l, got); ArrayResize(s.c, got);
   ArrayResize(s.v, got); ArrayResize(s.t, got);
   for(int i = 0; i < got; i++)
     {
      s.o[i] = r[i].open; s.h[i] = r[i].high; s.l[i] = r[i].low; s.c[i] = r[i].close;
      s.v[i] = r[i].tick_volume; s.t[i] = r[i].time;
     }
   s.lc = got - 2;
   s.digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   s.point = SymbolInfoDouble(sym, SYMBOL_POINT);
   s.pip = PipOf(sym);
   long lt = SymbolInfoInteger(sym, SYMBOL_TIME);
   s.stale = lt > 0 && iBarShift(sym, tf, (datetime)lt, true) != 0;
   s.fromCache = false;
   s.loadedAt = TimeLocal();
   s.lastUsed = TimeLocal();
   if(s.t[s.lc] != s.lastClosedTime)
     {
      BuildEngines(s);
      s.lastClosedTime = s.t[s.lc];
      for(int ch = 0; ch < CH_COUNT; ch++) s.cache[ch] = "";
     }
   return s;
  }

// next higher / lower timeframe used for context
ENUM_TIMEFRAMES HigherTf(ENUM_TIMEFRAMES tf)
  {
   switch(tf)
     {
      case PERIOD_M1: return PERIOD_M5;
      case PERIOD_M2: case PERIOD_M3: case PERIOD_M4: return PERIOD_M15;
      case PERIOD_M5: case PERIOD_M6: return PERIOD_M15;
      case PERIOD_M10: case PERIOD_M12: case PERIOD_M15: case PERIOD_M20: return PERIOD_H1;
      case PERIOD_M30: case PERIOD_H1: return PERIOD_H4;
      case PERIOD_H2: case PERIOD_H3: case PERIOD_H4: case PERIOD_H6: case PERIOD_H8: case PERIOD_H12: return PERIOD_D1;
      case PERIOD_D1: return PERIOD_W1;
      case PERIOD_W1: return PERIOD_MN1;
     }
   return PERIOD_MN1;
  }
ENUM_TIMEFRAMES LowerTf(ENUM_TIMEFRAMES tf)
  {
   switch(tf)
     {
      case PERIOD_MN1: return PERIOD_W1;
      case PERIOD_W1: return PERIOD_D1;
      case PERIOD_D1: return PERIOD_H4;
      case PERIOD_H4: return PERIOD_H1;
      case PERIOD_H1: return PERIOD_M15;
      case PERIOD_M30: return PERIOD_M5;
      case PERIOD_M15: return PERIOD_M5;
      case PERIOD_M5: return PERIOD_M1;
     }
   return PERIOD_M1;
  }

//+------------------------------------------------------------------+
//| Shared indicator maths (whole series, closed + forming candle)    |
//+------------------------------------------------------------------+
void SeriesEma(const double &src[], int n, int p, double &out[])
  {
   ArrayResize(out, n); ArrayInitialize(out, 0);
   if(n < p || p <= 0) return;
   double sum = 0;
   for(int i = 0; i < p; i++) sum += src[i];
   out[p - 1] = sum / p;
   double k = 2.0 / (p + 1);
   for(int i = p; i < n; i++) out[i] = out[i - 1] + k * (src[i] - out[i - 1]);
  }
void SeriesRma(const double &src[], int n, int p, double &out[])
  {
   ArrayResize(out, n); ArrayInitialize(out, 0);
   if(n < p || p <= 0) return;
   double sum = 0;
   for(int i = 0; i < p; i++) sum += src[i];
   out[p - 1] = sum / p;
   for(int i = p; i < n; i++) out[i] = (out[i - 1] * (p - 1) + src[i]) / p;
  }
double SmaAt(const double &a[], int i, int p)
  {
   if(i - p + 1 < 0 || i >= ArraySize(a)) return 0;
   double s = 0;
   for(int k = i - p + 1; k <= i; k++) s += a[k];
   return s / p;
  }
double StdAt(const double &a[], int i, int p)
  {
   double m = SmaAt(a, i, p);
   if(i - p + 1 < 0) return 0;
   double s = 0;
   for(int k = i - p + 1; k <= i; k++) s += (a[k] - m) * (a[k] - m);
   return MathSqrt(s / p);
  }
double HighestH(CSlot *s, int from, int to) { double m = -DBL_MAX; for(int i = MathMax(0, from); i <= to && i < s.n; i++) m = MathMax(m, s.h[i]); return m; }
double LowestL(CSlot *s, int from, int to)  { double m = DBL_MAX;  for(int i = MathMax(0, from); i <= to && i < s.n; i++) m = MathMin(m, s.l[i]); return m; }

void BuildEngines(CSlot *s)
  {
   int n = s.n;
   double tr[]; ArrayResize(tr, n);
   for(int i = 0; i < n; i++)
      tr[i] = i == 0 ? s.h[i] - s.l[i] : MathMax(s.h[i], s.c[i - 1]) - MathMin(s.l[i], s.c[i - 1]);
   SeriesRma(tr, n, 14, s.atr);
   SeriesRma(tr, n, 10, s.atr10);
   SeriesEma(s.c, n, 20, s.ema20);
   SeriesEma(s.c, n, 50, s.ema50);
   SeriesEma(s.c, n, 200, s.ema200);
   SeriesRma(s.c, n, 6, s.smma6);
   SeriesRma(s.c, n, 20, s.smma20);
   SeriesRma(s.c, n, 100, s.smma100);
   // RSI 14 (Wilder)
   double up[], dn[], au[], ad[];
   ArrayResize(up, n); ArrayResize(dn, n);
   up[0] = 0; dn[0] = 0;
   for(int i = 1; i < n; i++) { double d = s.c[i] - s.c[i - 1]; up[i] = d > 0 ? d : 0; dn[i] = d < 0 ? -d : 0; }
   SeriesRma(up, n, 14, au); SeriesRma(dn, n, 14, ad);
   ArrayResize(s.rsi, n); ArrayInitialize(s.rsi, 0);
   for(int i = 14; i < n; i++) s.rsi[i] = ad[i] == 0 ? 100 : 100 - 100 / (1 + au[i] / ad[i]);
   // MACD 12/26/9
   double e12[], e26[];
   SeriesEma(s.c, n, 12, e12); SeriesEma(s.c, n, 26, e26);
   ArrayResize(s.macd, n); ArrayInitialize(s.macd, 0);
   for(int i = 25; i < n; i++) s.macd[i] = e12[i] - e26[i];
   ArrayResize(s.macdSig, n); ArrayInitialize(s.macdSig, 0);
   if(n > 34)
     {
      double sum = 0;
      for(int i = 25; i < 34; i++) sum += s.macd[i];
      s.macdSig[33] = sum / 9;
      for(int i = 34; i < n; i++) s.macdSig[i] = s.macdSig[i - 1] + 0.2 * (s.macd[i] - s.macdSig[i - 1]);
     }
   // Stochastic 14,3,3
   double raw[]; ArrayResize(raw, n); ArrayInitialize(raw, 50);
   for(int i = 13; i < n; i++)
     {
      double hh = HighestH(s, i - 13, i), ll = LowestL(s, i - 13, i);
      raw[i] = hh > ll ? (s.c[i] - ll) / (hh - ll) * 100 : 50;
     }
   ArrayResize(s.stK, n); ArrayResize(s.stD, n);
   for(int i = 0; i < n; i++) s.stK[i] = i >= 15 ? SmaAt(raw, i, 3) : 50;
   for(int i = 0; i < n; i++) s.stD[i] = i >= 17 ? SmaAt(s.stK, i, 3) : 50;
   // ADX 14 (Wilder) + DI
   double pdm[], mdm[], spdm[], smdm[], str_[];
   ArrayResize(pdm, n); ArrayResize(mdm, n);
   pdm[0] = 0; mdm[0] = 0;
   for(int i = 1; i < n; i++)
     {
      double upM = s.h[i] - s.h[i - 1], dnM = s.l[i - 1] - s.l[i];
      pdm[i] = (upM > dnM && upM > 0) ? upM : 0;
      mdm[i] = (dnM > upM && dnM > 0) ? dnM : 0;
     }
   SeriesRma(pdm, n, 14, spdm); SeriesRma(mdm, n, 14, smdm); SeriesRma(tr, n, 14, str_);
   ArrayResize(s.pdi, n); ArrayResize(s.mdi, n); ArrayInitialize(s.pdi, 0); ArrayInitialize(s.mdi, 0);
   double dx[]; ArrayResize(dx, n); ArrayInitialize(dx, 0);
   for(int i = 14; i < n; i++)
     {
      if(str_[i] <= 0) continue;
      s.pdi[i] = 100 * spdm[i] / str_[i];
      s.mdi[i] = 100 * smdm[i] / str_[i];
      double sm = s.pdi[i] + s.mdi[i];
      dx[i] = sm > 0 ? 100 * MathAbs(s.pdi[i] - s.mdi[i]) / sm : 0;
     }
   ArrayResize(s.adx, n); ArrayInitialize(s.adx, 0);
   if(n > 28)
     {
      double sum = 0;
      for(int i = 14; i < 28; i++) sum += dx[i];
      s.adx[27] = sum / 14;
      for(int i = 28; i < n; i++) s.adx[i] = (s.adx[i - 1] * 13 + dx[i]) / 14;
     }
   // Supertrend 10, 3
   ArrayResize(s.st, n); ArrayResize(s.stDir, n); ArrayInitialize(s.st, 0); ArrayInitialize(s.stDir, 0);
   double fu = 0, fl = 0; int dir = 1;
   for(int i = 10; i < n; i++)
     {
      double mid = (s.h[i] + s.l[i]) / 2, a = s.atr10[i];
      double bu = mid + 3 * a, bl = mid - 3 * a;
      fu = (i == 10 || bu < fu || s.c[i - 1] > fu) ? bu : fu;
      fl = (i == 10 || bl > fl || s.c[i - 1] < fl) ? bl : fl;
      if(dir == 1 && s.c[i] < fl) dir = -1;
      else if(dir == -1 && s.c[i] > fu) dir = 1;
      s.st[i] = dir == 1 ? fl : fu;
      s.stDir[i] = dir;
     }
   // Swings on WICKS, confirmed only when their right-hand candles have CLOSED
   ArrayFree(s.swI); ArrayFree(s.swP); ArrayFree(s.swK);
   ArrayFree(s.exI); ArrayFree(s.exP); ArrayFree(s.exK);
   int lc = s.lc;
   for(int pass = 0; pass < 2; pass++)
     {
      int k = pass == 0 ? 2 : 5;
      for(int i = k; i <= lc - k; i++)
        {
         bool hi = true, lo = true;
         for(int j = 1; j <= k && (hi || lo); j++)
           {
            if(!(s.h[i] > s.h[i - j] && s.h[i] >= s.h[i + j])) hi = false;
            if(!(s.l[i] < s.l[i - j] && s.l[i] <= s.l[i + j])) lo = false;
           }
         if(hi)
           {
            if(pass == 0) { int m = ArraySize(s.swI); ArrayResize(s.swI, m + 1); ArrayResize(s.swP, m + 1); ArrayResize(s.swK, m + 1); s.swI[m] = i; s.swP[m] = s.h[i]; s.swK[m] = 1; }
            else          { int m = ArraySize(s.exI); ArrayResize(s.exI, m + 1); ArrayResize(s.exP, m + 1); ArrayResize(s.exK, m + 1); s.exI[m] = i; s.exP[m] = s.h[i]; s.exK[m] = 1; }
           }
         if(lo)
           {
            if(pass == 0) { int m = ArraySize(s.swI); ArrayResize(s.swI, m + 1); ArrayResize(s.swP, m + 1); ArrayResize(s.swK, m + 1); s.swI[m] = i; s.swP[m] = s.l[i]; s.swK[m] = -1; }
            else          { int m = ArraySize(s.exI); ArrayResize(s.exI, m + 1); ArrayResize(s.exP, m + 1); ArrayResize(s.exK, m + 1); s.exI[m] = i; s.exP[m] = s.l[i]; s.exK[m] = -1; }
           }
        }
     }
  }

// --- small readers -------------------------------------------------------------------------------
double Atr(CSlot *s) { double a = s.atr[s.lc]; return a > 0 ? a : (s.h[s.lc] - s.l[s.lc]); }
string SPx(CSlot *s, double v) { return DoubleToString(v, s.digits); }
string BarIso(CSlot *s, int i) { return (i < 0 || i >= s.n) ? "" : SrvToIso(s.t[i]); }
int    Ago(CSlot *s, int i) { return s.lc - i; }
double ToPips(CSlot *s, double d) { return s.pip > 0 ? d / s.pip : 0; }
bool   Syn(CSlot *s) { return IsSynthetic(s.sym); }
// The four facts every price-like item carries.
string Lv(CSlot *s, double price, double ref)
  {
   double a = Atr(s);
   return Jn("price", price, s.digits) + "," + Jn("dist_atr", a > 0 ? MathAbs(price - ref) / a : 0, 2) + "," +
          (Syn(s) ? Jn("dist_points", s.point > 0 ? MathAbs(price - ref) / s.point : 0, 0) : Jn("dist_pips", ToPips(s, MathAbs(price - ref)), 1)) + "," +
          J("side", price >= ref ? "above" : "below");
  }
string LvAt(CSlot *s, double price, int bar)
  {
   return Lv(s, price, s.c[s.lc]) + "," + Ji("bars_ago", Ago(s, bar)) + "," + J("time", BarIso(s, bar));
  }

//+------------------------------------------------------------------+
//| Structure engine (APA rules: wick swings, CLOSE breaks)           |
//+------------------------------------------------------------------+
// One break of structure: a candle CLOSE beyond a confirmed swing.
int    g_brAt[];    // candle that closed through
int    g_brSide[];  // +1 bullish (through a high), -1 bearish
double g_brLvl[];
int    g_brSw[];    // index of the swing broken (into s.swI)
bool   g_brChoch[]; // true = against the structure before it (CHoCH), false = BOS
bool   g_brDisp[];  // with displacement

struct MsRead
  {
   int    trend;          // +1 bullish (HH+HL), -1 bearish (LH+LL), 0 range
   int    lastBos;        // index into g_br* of the last break (any kind), -1 none
   int    lastChoch;      // index of the last CHoCH, -1 none
   double validation;     // level whose break confirmed the side in control
   double invalidation;   // close beyond it = control changed (the shift point)
   int    shiftAt;        // candle that closed through the invalidation, -1 none
   int    shiftSide;
   bool   transition;     // shifted, but no new structure yet
   double reclaim;        // old extreme
   bool   reclaimed;
   int    reclaimAt;
   int    shiftType;      // 1 inside, 2 outside, 3 both, 0 unknown
   bool   returnedIntoAol;
   double returnDepthPct;
   double rangeHi, rangeLo; int rangeHiAt, rangeLoAt;
   int    cisdAt; int cisdSide; double cisdLvl;
  };

bool Displacement(CSlot *s, int i)
  {
   if(i < 1 || i > s.lc) return false;
   double rng = s.h[i] - s.l[i], body = MathAbs(s.c[i] - s.o[i]), a = s.atr[i] > 0 ? s.atr[i] : rng;
   if(rng >= 1.5 * a && rng > 0 && body >= 0.7 * rng) return true;
   if(i + 1 <= s.lc && (s.l[i + 1] > s.h[i - 1] || s.h[i + 1] < s.l[i - 1])) return true; // left an FVG
   return false;
  }

void ReadStructure(CSlot *s, MsRead &r)
  {
   ZeroMemory(r);
   r.lastBos = -1; r.lastChoch = -1; r.shiftAt = -1; r.reclaimAt = -1; r.cisdAt = -1;
   ArrayFree(g_brAt); ArrayFree(g_brSide); ArrayFree(g_brLvl); ArrayFree(g_brSw); ArrayFree(g_brChoch); ArrayFree(g_brDisp);
   int lc = s.lc, ns = ArraySize(s.swI);
   // trend from the last two swing highs and lows
   int h1 = -1, h2 = -1, l1 = -1, l2 = -1;
   for(int k = ns - 1; k >= 0; k--)
     {
      if(s.swK[k] == 1) { if(h2 < 0) h2 = k; else if(h1 < 0) h1 = k; }
      else { if(l2 < 0) l2 = k; else if(l1 < 0) l1 = k; }
      if(h1 >= 0 && l1 >= 0) break;
     }
   if(h1 >= 0 && l1 >= 0)
     {
      if(s.swP[h2] > s.swP[h1] && s.swP[l2] > s.swP[l1]) r.trend = 1;
      else if(s.swP[h2] < s.swP[h1] && s.swP[l2] < s.swP[l1]) r.trend = -1;
     }
   // every swing's first CLOSE beyond it (only after the swing is confirmed: 2 candles to its right)
   int tmpAt[]; int tmpSw[];
   for(int k = 0; k < ns; k++)
     {
      for(int j = s.swI[k] + 3; j <= lc; j++)
        {
         bool broke = s.swK[k] == 1 ? s.c[j] > s.swP[k] : s.c[j] < s.swP[k];
         if(broke) { int m = ArraySize(tmpAt); ArrayResize(tmpAt, m + 1); ArrayResize(tmpSw, m + 1); tmpAt[m] = j; tmpSw[m] = k; break; }
        }
     }
   // chronological; BOS = with the structure before it, CHoCH = against it
   int m = ArraySize(tmpAt);
   for(int a = 0; a < m - 1; a++)
      for(int b = a + 1; b < m; b++)
         if(tmpAt[b] < tmpAt[a] || (tmpAt[b] == tmpAt[a] && tmpSw[b] < tmpSw[a]))
           { int x = tmpAt[a]; tmpAt[a] = tmpAt[b]; tmpAt[b] = x; x = tmpSw[a]; tmpSw[a] = tmpSw[b]; tmpSw[b] = x; }
   int state = 0;
   for(int a = 0; a < m; a++)
     {
      int side = s.swK[tmpSw[a]];
      int q = ArraySize(g_brAt);
      ArrayResize(g_brAt, q + 1); ArrayResize(g_brSide, q + 1); ArrayResize(g_brLvl, q + 1); ArrayResize(g_brSw, q + 1); ArrayResize(g_brChoch, q + 1); ArrayResize(g_brDisp, q + 1);
      g_brAt[q] = tmpAt[a]; g_brSide[q] = side; g_brLvl[q] = s.swP[tmpSw[a]]; g_brSw[q] = tmpSw[a];
      g_brChoch[q] = state != 0 && side != state;
      g_brDisp[q] = Displacement(s, tmpAt[a]);
      state = side;
      r.lastBos = q;
      if(g_brChoch[q]) r.lastChoch = q;
     }
   // validation / invalidation (shift point) from the last break
   if(r.lastBos >= 0)
     {
      int at = g_brAt[r.lastBos], side = g_brSide[r.lastBos];
      r.validation = g_brLvl[r.lastBos];
      // bullish: the last swing LOW before the break (the higher low); bearish: the last swing HIGH
      for(int k = ns - 1; k >= 0; k--)
         if(s.swI[k] < at && s.swK[k] == -side) { r.invalidation = s.swP[k]; break; }
      if(r.invalidation > 0)
        {
         for(int j = at + 1; j <= lc; j++)
           {
            bool shifted = side == 1 ? s.c[j] < r.invalidation : s.c[j] > r.invalidation;
            if(!shifted) continue;
            r.shiftAt = j; r.shiftSide = -side;
            int after = 0;
            for(int k = 0; k < ns; k++) if(s.swI[k] > j) after++;
            r.transition = after < 2;
            r.reclaim = side == 1 ? HighestH(s, at, j) : LowestL(s, at, j);
            for(int q2 = j + 1; q2 <= lc; q2++)
               if(side == 1 ? s.c[q2] > r.reclaim : s.c[q2] < r.reclaim) { r.reclaimed = true; r.reclaimAt = q2; break; }
            // shift type: is the first new swing after the shift inside the old range or beyond it?
            double oldHi = MathMax(r.reclaim, r.invalidation), oldLo = MathMin(r.reclaim, r.invalidation);
            bool inside = false, outside = false;
            for(int k = 0; k < ns; k++)
              {
               if(s.swI[k] <= j) continue;
               if(s.swP[k] <= oldHi && s.swP[k] >= oldLo) inside = true; else outside = true;
              }
            r.shiftType = inside && outside ? 3 : inside ? 1 : outside ? 2 : 0;
            break;
           }
         // pure vs different: after the break, did price come back into validation..invalidation?
         double extreme = side == 1 ? LowestL(s, at + 1, lc) : HighestH(s, at + 1, lc);
         double span = MathAbs(r.validation - r.invalidation);
         if(at < lc && span > 0)
           {
            r.returnedIntoAol = side == 1 ? extreme <= r.validation : extreme >= r.validation;
            r.returnDepthPct = r.returnedIntoAol ? MathMin(100, MathAbs(r.validation - extreme) / span * 100) : 0;
           }
        }
     }
   // dealing range = last external swing high and low
   r.rangeHiAt = -1; r.rangeLoAt = -1;
   for(int k = ArraySize(s.exI) - 1; k >= 0; k--)
     {
      if(s.exK[k] == 1 && r.rangeHiAt < 0) { r.rangeHi = s.exP[k]; r.rangeHiAt = s.exI[k]; }
      if(s.exK[k] == -1 && r.rangeLoAt < 0) { r.rangeLo = s.exP[k]; r.rangeLoAt = s.exI[k]; }
      if(r.rangeHiAt >= 0 && r.rangeLoAt >= 0) break;
     }
   if(r.rangeHiAt < 0 || r.rangeLoAt < 0)
     {
      int from = MathMax(0, lc - 100);
      r.rangeHi = HighestH(s, from, lc); r.rangeLo = LowestL(s, from, lc);
      r.rangeHiAt = from; r.rangeLoAt = from;
     }
   // CISD: the latest close through the OPEN of the run (2+) of opposite candles just before it
   for(int j = lc; j >= MathMax(3, lc - 60) && r.cisdAt < 0; j--)
     {
      for(int side = 1; side >= -1; side -= 2)
        {
         int k = j - 1, start = -1;
         while(k >= 1 && (side == 1 ? s.c[k] < s.o[k] : s.c[k] > s.o[k])) { start = k; k--; }
         if(start < 0 || j - start < 2) continue;
         bool through = side == 1 ? s.c[j] > s.o[start] : s.c[j] < s.o[start];
         if(through) { r.cisdAt = j; r.cisdSide = side; r.cisdLvl = s.o[start]; break; }
        }
     }
  }

string SideName(int side) { return side > 0 ? "bullish" : side < 0 ? "bearish" : "range"; }

// the trend + last break of a timeframe, short (used as higher-timeframe context)
string StructureBrief(CSlot *s)
  {
   if(s == NULL) return "null";
   MsRead r; ReadStructure(s, r);
   string f = J("tf", TfName(s.tf)) + "," + J("trend", SideName(r.trend));
   if(r.lastBos >= 0)
      f += "," + Jr("last_break", Obj(J("type", g_brChoch[r.lastBos] ? "CHoCH" : "BOS") + "," + J("side", SideName(g_brSide[r.lastBos])) + "," + LvAt(s, g_brLvl[r.lastBos], g_brAt[r.lastBos])));
   if(r.shiftAt >= 0) f += "," + Jr("shift", Obj(J("to", SideName(r.shiftSide)) + "," + Jb("transition", r.transition) + "," + LvAt(s, r.invalidation, r.shiftAt)));
   return Obj(f);
  }

//+------------------------------------------------------------------+
//| 3. get_market_structure                                           |
//+------------------------------------------------------------------+
string C_MarketStructure(CSlot *s)
  {
   MsRead r; ReadStructure(s, r);
   int lc = s.lc; double px = s.c[lc], a = Atr(s);
   string f[];
   A_Push(f, J("rules", "swings: fractal 2 left/2 right on wicks (internal), 5/5 (external), confirmed only after their right-hand candles CLOSE; every break needs a candle BODY CLOSE beyond the level; closed candles only"));
   // a. swings
   string sw[];
   int ns = ArraySize(s.swI), lastH = -1, lastL = -1;
   for(int k = MathMax(0, ns - 10); k < ns; k++)
     {
      string lbl = "";
      // label against the previous swing of the same kind
      for(int q = k - 1; q >= 0; q--)
         if(s.swK[q] == s.swK[k])
           { lbl = s.swK[k] == 1 ? (s.swP[k] > s.swP[q] ? "HH" : "LH") : (s.swP[k] > s.swP[q] ? "HL" : "LL"); break; }
      A_Push(sw, Obj(J("kind", s.swK[k] == 1 ? "high" : "low") + "," + J("label", lbl) + "," + LvAt(s, s.swP[k], s.swI[k]) + "," +
                     Ji("confirmed_at_bars_ago", Ago(s, MathMin(lc, s.swI[k] + 2)))));
     }
   A_Push(f, Jr("swings", Arr(sw)));
   // b. trend
   A_Push(f, J("trend", SideName(r.trend)));
   // c-d. breaks (last 4)
   string br[];
   for(int q = MathMax(0, ArraySize(g_brAt) - 4); q < ArraySize(g_brAt); q++)
      A_Push(br, Obj(J("type", g_brChoch[q] ? "CHoCH" : "BOS") + "," + J("side", SideName(g_brSide[q])) + "," + LvAt(s, g_brLvl[q], g_brAt[q]) + "," +
                     Jb("body_close", true) + "," + Jb("with_displacement", g_brDisp[q])));
   A_Push(f, Jr("breaks", Arr(br)));
   // e. CISD
   if(r.cisdAt >= 0) A_Push(f, Jr("cisd", Obj(J("side", SideName(r.cisdSide)) + "," + LvAt(s, r.cisdLvl, r.cisdAt))));
   else A_Push(f, Jnull("cisd"));
   // f. swing failures (wick beyond a swing, close back inside on the same or next candle) -- last 3
   string sf[];
   for(int k = ns - 1; k >= 0 && ArraySize(sf) < 3; k--)
     {
      for(int j = s.swI[k] + 3; j <= lc; j++)
        {
         bool beyond = s.swK[k] == 1 ? s.h[j] > s.swP[k] : s.l[j] < s.swP[k];
         if(!beyond) continue;
         bool backIn = s.swK[k] == 1 ? s.c[j] < s.swP[k] : s.c[j] > s.swP[k];
         if(!backIn && j + 1 <= lc) backIn = s.swK[k] == 1 ? s.c[j + 1] < s.swP[k] : s.c[j + 1] > s.swP[k];
         if(backIn) A_Push(sf, Obj(J("side", s.swK[k] == 1 ? "bearish (high failed)" : "bullish (low failed)") + "," + LvAt(s, s.swP[k], j)));
         break;
        }
     }
   A_Push(f, Jr("swing_failures", Arr(sf)));
   // g. dealing range
   double rh = r.rangeHi, rl = r.rangeLo, eq = (rh + rl) / 2;
   double pos = rh > rl ? (px - rl) / (rh - rl) * 100 : 50;
   A_Push(f, Jr("dealing_range", Obj(Jr("high", Obj(LvAt(s, rh, r.rangeHiAt))) + "," + Jr("low", Obj(LvAt(s, rl, r.rangeLoAt))) + "," +
                                     Jn("equilibrium", eq, s.digits) + "," + Jn("price_position_pct", pos, 1) + "," +
                                     J("zone", pos > 50 ? "premium" : pos < 50 ? "discount" : "equilibrium"))));
   // OTE 62-79% of the last displacement leg (range direction from which swing came last)
   bool upLeg = r.rangeLoAt < r.rangeHiAt;
   double legR = rh - rl;
   double oteA = upLeg ? rh - 0.62 * legR : rl + 0.62 * legR, oteB = upLeg ? rh - 0.79 * legR : rl + 0.79 * legR;
   A_Push(f, Jr("ote", Obj(J("leg", upLeg ? "up" : "down") + "," + Jn("from", MathMin(oteA, oteB), s.digits) + "," + Jn("to", MathMax(oteA, oteB), s.digits) + "," +
                           Jn("mid_0705", upLeg ? rh - 0.705 * legR : rl + 0.705 * legR, s.digits) + "," + Jb("price_inside", px >= MathMin(oteA, oteB) && px <= MathMax(oteA, oteB)))));
   // h. inducement: first internal pullback swing after the last break
   if(r.lastBos >= 0)
     {
      int at = g_brAt[r.lastBos], side = g_brSide[r.lastBos], idx = -1;
      for(int k = 0; k < ns; k++) if(s.swI[k] > at && s.swK[k] == -side) { idx = k; break; }
      if(idx >= 0)
        {
         bool taken = false; int takenAt = -1;
         for(int j = s.swI[idx] + 3; j <= lc; j++) if(side == 1 ? s.l[j] < s.swP[idx] : s.h[j] > s.swP[idx]) { taken = true; takenAt = j; break; }
         A_Push(f, Jr("inducement", Obj(LvAt(s, s.swP[idx], s.swI[idx]) + "," + Jb("taken", taken) + (taken ? "," + Ji("taken_bars_ago", Ago(s, takenAt)) : ""))));
        }
      else A_Push(f, Jnull("inducement"));
     }
   // i. trendline through the last two swing lows (uptrend) or highs (downtrend)
   int want = r.trend >= 0 ? -1 : 1, p2 = -1, p1 = -1;
   for(int k = ns - 1; k >= 0; k--) if(s.swK[k] == want) { if(p2 < 0) p2 = k; else { p1 = k; break; } }
   if(p1 >= 0 && p2 >= 0 && s.swI[p2] > s.swI[p1])
     {
      double slope = (s.swP[p2] - s.swP[p1]) / (s.swI[p2] - s.swI[p1]);
      bool valid = want == -1 ? slope > 0 : slope < 0;
      if(valid)
        {
         int touches = 0;
         for(int k = 0; k < ns; k++)
            if(s.swK[k] == want && s.swI[k] >= s.swI[p1] && MathAbs(s.swP[k] - (s.swP[p1] + slope * (s.swI[k] - s.swI[p1]))) <= 0.1 * a) touches++;
         int brokeAt = -1;
         for(int j = s.swI[p2] + 1; j <= lc; j++)
           {
            double line = s.swP[p1] + slope * (j - s.swI[p1]);
            if(want == -1 ? s.c[j] < line - 0.1 * a : s.c[j] > line + 0.1 * a) { brokeAt = j; break; }
           }
         double lineNow = s.swP[p1] + slope * (lc - s.swI[p1]);
         A_Push(f, Jr("trendline", Obj(J("kind", want == -1 ? "rising (through lows)" : "falling (through highs)") + "," + Lv(s, lineNow, px) + "," +
                                       Ji("touches", touches) + "," + Jb("broken", brokeAt >= 0) + (brokeAt >= 0 ? "," + Ji("broken_bars_ago", Ago(s, brokeAt)) : ""))));
        }
     }
   // j. legs between external swings (last 5) + pullback depth
   string legs[];
   int ne = ArraySize(s.exI);
   double lastImpulse = 0; int lastImpulseDir = 0;
   for(int k = MathMax(1, ne - 5); k < ne; k++)
     {
      if(s.exK[k] == s.exK[k - 1]) continue;
      double size = s.exP[k] - s.exP[k - 1];
      bool impulse = false;
      for(int q = k - 2; q >= 0; q--) if(s.exK[q] == s.exK[k]) { impulse = s.exK[k] == 1 ? s.exP[k] > s.exP[q] : s.exP[k] < s.exP[q]; break; }
      if(impulse) { lastImpulse = size; lastImpulseDir = size > 0 ? 1 : -1; }
      A_Push(legs, Obj(J("dir", size > 0 ? "up" : "down") + "," + Jn("from", s.exP[k - 1], s.digits) + "," + Jn("to", s.exP[k], s.digits) + "," +
                       Jn("size_atr", a > 0 ? MathAbs(size) / a : 0, 2) + "," + Ji("bars", s.exI[k] - s.exI[k - 1]) + "," +
                       J("type", impulse ? "impulse (broke structure)" : "pullback") + "," + Ji("ended_bars_ago", Ago(s, s.exI[k]))));
     }
   A_Push(f, Jr("legs", Arr(legs)));
   if(ne > 0 && lastImpulse != 0)
     {
      double end = s.exP[ne - 1];
      double depth = lastImpulseDir > 0 ? (end - LowestL(s, s.exI[ne - 1], lc)) : (HighestH(s, s.exI[ne - 1], lc) - end);
      A_Push(f, Jn("pullback_depth_pct_of_last_impulse", MathAbs(lastImpulse) > 0 ? depth / MathAbs(lastImpulse) * 100 : 0, 1));
     }
   // k. higher timeframe (only if MT5 already has it)
   CSlot *hs = GetSlot(s.sym, HigherTf(s.tf), 0);
   A_Push(f, Jr("higher_tf", StructureBrief(hs)));
   // l-s. APA
   string apa[];
   A_Push(apa, Jn("validation", r.validation, s.digits));
   A_Push(apa, r.invalidation > 0 ? Jr("shift_point", Obj(Lv(s, r.invalidation, px) + "," + J("rule", "a candle CLOSE beyond it = shift"))) : Jnull("shift_point"));
   A_Push(apa, Jb("shifted", r.shiftAt >= 0));
   if(r.shiftAt >= 0)
     {
      A_Push(apa, J("shift_to", SideName(r.shiftSide)));
      A_Push(apa, Ji("shift_bars_ago", Ago(s, r.shiftAt)));
      A_Push(apa, Jb("transition", r.transition));
      A_Push(apa, J("shift_type", r.shiftType == 1 ? "inside formation" : r.shiftType == 2 ? "outside formation" : r.shiftType == 3 ? "inside and outside formation" : "no new formation yet"));
      A_Push(apa, Jr("reclaim_point", Obj(Lv(s, r.reclaim, px) + "," + Jb("reclaimed", r.reclaimed) + (r.reclaimAt >= 0 ? "," + Ji("reclaimed_bars_ago", Ago(s, r.reclaimAt)) : ""))));
     }
   A_Push(apa, J("trend_kind", r.lastBos < 0 ? "none" : r.returnedIntoAol ? "different (price came back into the area of liquidity)" : "pure (price did not come back)"));
   A_Push(apa, Jn("return_depth_pct", r.returnDepthPct, 1));
   if(r.lastBos >= 0) A_Push(apa, Jr("confirm_level", Obj(Lv(s, r.validation, px))));
   A_Push(f, Jr("apa", Obj(A_Join(apa))));
   return Obj(A_Join(f));
  }

//+------------------------------------------------------------------+
//| 4. get_liquidity                                                  |
//+------------------------------------------------------------------+
// first candle after swing k that trades beyond it (-1 = untaken)
int TakenAt(CSlot *s, int k)
  {
   for(int j = s.swI[k] + 3; j <= s.lc; j++)
      if(s.swK[k] == 1 ? s.h[j] > s.swP[k] : s.l[j] < s.swP[k]) return j;
   return -1;
  }

string C_Liquidity(CSlot *s)
  {
   MsRead r; ReadStructure(s, r);
   int lc = s.lc, ns = ArraySize(s.swI);
   double px = s.c[lc], a = Atr(s);
   double tol = Syn(s) ? MathMax(3 * (SymbolInfoDouble(s.sym, SYMBOL_ASK) - SymbolInfoDouble(s.sym, SYMBOL_BID)), 0.05 * a) : 0.1 * a;
   string f[];
   A_Push(f, J("rules", "pools = confirmed swing highs (buy-side, BSL) / lows (sell-side, SSL); taken = a later wick traded beyond; equal = within " + (Syn(s) ? "3 x spread" : "0.1 ATR") + "; sweep = wick beyond then a CLOSE back inside within 3 candles"));
   // a. pools above / below, untaken, nearest first (3 each)
   string bsl[], ssl[];
   for(int pass = 0; pass < 2; pass++)
     {
      int kind = pass == 0 ? 1 : -1;
      int idx[]; double dist[];
      for(int k = ns - 1; k >= 0 && k >= ns - 60; k--)
        {
         if(s.swK[k] != kind || TakenAt(s, k) >= 0) continue;
         int m = ArraySize(idx); ArrayResize(idx, m + 1); ArrayResize(dist, m + 1);
         idx[m] = k; dist[m] = MathAbs(s.swP[k] - px);
        }
      for(int x = 0; x < ArraySize(idx) - 1; x++)
         for(int y = x + 1; y < ArraySize(idx); y++)
            if(dist[y] < dist[x]) { double t = dist[x]; dist[x] = dist[y]; dist[y] = t; int ti = idx[x]; idx[x] = idx[y]; idx[y] = ti; }
      for(int x = 0; x < ArraySize(idx) && x < 3; x++)
        {
         int k = idx[x], touches = 0;
         for(int q = 0; q < ns; q++) if(s.swK[q] == kind && MathAbs(s.swP[q] - s.swP[k]) <= tol) touches++;
         string row = Obj(LvAt(s, s.swP[k], s.swI[k]) + "," + Ji("touches", touches) + "," + Jb("taken", false));
         if(kind == 1) A_Push(bsl, row); else A_Push(ssl, row);
        }
     }
   A_Push(f, Jr("buy_side_above", Arr(bsl)));
   A_Push(f, Jr("sell_side_below", Arr(ssl)));
   // b. equal highs / lows (2+ swings within tolerance, last 40 swings)
   string eqh[], eql[];
   for(int k = ns - 1; k >= MathMax(0, ns - 40); k--)
     {
      int cnt = 1;
      for(int q = k - 1; q >= MathMax(0, ns - 40); q--) if(s.swK[q] == s.swK[k] && MathAbs(s.swP[q] - s.swP[k]) <= tol) cnt++;
      if(cnt < 2) continue;
      string row = Obj(LvAt(s, s.swP[k], s.swI[k]) + "," + Ji("count", cnt) + "," + Jb("taken", TakenAt(s, k) >= 0));
      if(s.swK[k] == 1) { if(ArraySize(eqh) < 3) A_Push(eqh, row); }
      else { if(ArraySize(eql) < 3) A_Push(eql, row); }
     }
   A_Push(f, Jr("equal_highs", Arr(eqh)));
   A_Push(f, Jr("equal_lows", Arr(eql)));
   // c. untouched old highs/lows (external swings never traded through)
   string old[];
   for(int k = ArraySize(s.exI) - 1; k >= 0 && ArraySize(old) < 4; k--)
     {
      bool taken = false;
      for(int j = s.exI[k] + 6; j <= lc; j++) if(s.exK[k] == 1 ? s.h[j] > s.exP[k] : s.l[j] < s.exP[k]) { taken = true; break; }
      if(taken) continue;
      int tests = 0;
      for(int q = 0; q < ns; q++) if(s.swK[q] == s.exK[k] && s.swI[q] > s.exI[k] && MathAbs(s.swP[q] - s.exP[k]) <= 0.25 * a) tests++;
      A_Push(old, Obj(J("kind", s.exK[k] == 1 ? "high" : "low") + "," + LvAt(s, s.exP[k], s.exI[k]) + "," + Ji("tests", tests)));
     }
   A_Push(f, Jr("untouched_old_levels", Arr(old)));
   // d. sweeps (last 3) + e. side swept today
   string sw[]; bool buyToday = false, sellToday = false;
   MqlDateTime nd; TimeToStruct(s.t[lc], nd);
   datetime dayStart = s.t[lc] - (nd.hour * 3600 + nd.min * 60 + nd.sec);
   int lastSweepK = -1, lastSweepAt = -1;
   for(int k = 0; k < ns; k++)
     {
      int j = TakenAt(s, k);
      if(j < 0) continue;
      bool back = false;
      for(int q = j; q <= MathMin(lc, j + 2) && !back; q++) back = s.swK[k] == 1 ? s.c[q] < s.swP[k] : s.c[q] > s.swP[k];
      if(!back) continue;
      if(j > lastSweepAt) { lastSweepAt = j; lastSweepK = k; }
      if(s.t[j] >= dayStart) { if(s.swK[k] == 1) buyToday = true; else sellToday = true; }
     }
   for(int k = ns - 1; k >= 0 && ArraySize(sw) < 3; k--)
     {
      int j = TakenAt(s, k);
      if(j < 0) continue;
      bool back = false;
      for(int q = j; q <= MathMin(lc, j + 2) && !back; q++) back = s.swK[k] == 1 ? s.c[q] < s.swP[k] : s.c[q] > s.swP[k];
      if(!back) continue;
      double after = s.swK[k] == 1 ? s.swP[k] - LowestL(s, j, lc) : HighestH(s, j, lc) - s.swP[k];
      A_Push(sw, Obj(J("pool", s.swK[k] == 1 ? "buy-side (high)" : "sell-side (low)") + "," + LvAt(s, s.swP[k], j) + "," + Jn("move_after_atr", a > 0 ? after / a : 0, 2)));
     }
   A_Push(f, Jr("sweeps", Arr(sw)));
   A_Push(f, J("swept_today", buyToday && sellToday ? "both" : buyToday ? "buy-side" : sellToday ? "sell-side" : "none"));
   // f. day / week levels taken (owned by get_price; only the flags here)
   double pdh = 0, pdl = 0;
   CSlot *d1 = GetSlot(s.sym, PERIOD_D1, 0);
   if(d1 != NULL && d1.n >= 3)
     {
      pdh = d1.h[d1.n - 2]; pdl = d1.l[d1.n - 2];
      A_Push(f, Jr("previous_day", Obj(Jn("pdh", pdh, s.digits) + "," + Jb("pdh_taken", d1.h[d1.n - 1] > pdh) + "," + Jn("pdl", pdl, s.digits) + "," + Jb("pdl_taken", d1.l[d1.n - 1] < pdl))));
     }
   // g. draw on liquidity: nearest untaken pool in the higher-timeframe (else own) trend direction
   CSlot *hs = GetSlot(s.sym, HigherTf(s.tf), 0);
   int bias = r.trend;
   if(hs != NULL) { MsRead hr; ReadStructure(hs, hr); if(hr.trend != 0) bias = hr.trend; }
   ReadStructure(s, r); // restore this timeframe's break list
   int best = -1; double bestD = DBL_MAX;
   for(int k = 0; k < ns; k++)
     {
      if(bias == 0 || s.swK[k] != bias || TakenAt(s, k) >= 0) continue;
      double d = bias == 1 ? s.swP[k] - px : px - s.swP[k];
      if(d > 0 && d < bestD) { bestD = d; best = k; }
     }
   A_Push(f, best >= 0 ? Jr("draw_on_liquidity", Obj(J("direction", bias == 1 ? "up" : "down") + "," + LvAt(s, s.swP[best], s.swI[best]) + "," +
                                                       J("rule", "nearest untaken pool in the " + (hs != NULL ? "higher-timeframe" : "own") + " trend direction")))
                       : Jnull("draw_on_liquidity"));
   // h-n. APA liquidity engineering (book p.12-14): level, thrust candle, FMD, CHoCH
   if(lastSweepK >= 0)
     {
      int k = lastSweepK, j = lastSweepAt;
      bool bullish = s.swK[k] == -1; // sell-side swept = early sellers taken = buy setup
      // CHoCH after the thrust: close beyond the last opposite swing before the sweep
      int opp = -1;
      for(int q = ns - 1; q >= 0; q--) if(s.swI[q] < j && s.swK[q] == (bullish ? 1 : -1)) { opp = q; break; }
      int chochAt = -1;
      if(opp >= 0) for(int q = j + 1; q <= lc; q++) if(bullish ? s.c[q] > s.swP[opp] : s.c[q] < s.swP[opp]) { chochAt = q; break; }
      int fmdEnd = chochAt >= 0 ? chochAt : lc;
      double fmd = bullish ? LowestL(s, j, fmdEnd) : HighestH(s, j, fmdEnd);
      bool nearInv = r.invalidation > 0 && MathAbs(s.swP[k] - r.invalidation) <= 0.5 * a;
      string missing = chochAt < 0 ? "CHoCH" : "";
      A_Push(f, Jr("liquidity_engineering", Obj(
         J("side", bullish ? "bullish (early sellers swept)" : "bearish (early buyers swept)") + "," +
         Jr("level", Obj(LvAt(s, s.swP[k], s.swI[k]))) + "," +
         Jr("thrust_candle", Obj(LvAt(s, bullish ? s.l[j] : s.h[j], j) + "," + Jn("close", s.c[j], s.digits))) + "," +
         Jr("fmd", Obj(Lv(s, fmd, px) + "," + J("note", "stop goes beyond this"))) + "," +
         (chochAt >= 0 ? Jr("choch", Obj(LvAt(s, s.swP[opp], chochAt))) : Jnull("choch")) + "," +
         Jb("complete", chochAt >= 0) + "," + J("missing", missing) + "," +
         Jb("near_aol_invalidation", nearInv))));
     }
   else A_Push(f, Jnull("liquidity_engineering"));
   return Obj(A_Join(f));
  }

//+------------------------------------------------------------------+
//| 5. get_zones                                                      |
//+------------------------------------------------------------------+
#define ZK_OB      1
#define ZK_BREAKER 2
#define ZK_FVG     3
#define ZK_IFVG    4
#define ZK_BPR     5
#define ZK_AOL     6
#define ZK_T1      7
#define ZK_T2      8
#define ZK_T3      9
#define ZK_T4      10
#define ZK_NDOG    11
#define ZK_NWOG    12
struct Zone
  {
   int    kind;
   int    side;       // +1 demand / bullish, -1 supply / bearish
   double lo, hi;
   int    at;         // candle that formed it
   double valid;      // validation line (0 = n/a)
   double invalid;    // invalidation price (0 = n/a)
   bool   swept;      // breaker: the order block's move swept liquidity first
   int    lowerOk;    // Type 4: 1 yes / 0 no / -1 unknown
  };
Zone g_z[];

string ZName(int k)
  {
   switch(k)
     {
      case ZK_OB: return "order_block"; case ZK_BREAKER: return "breaker"; case ZK_FVG: return "fvg"; case ZK_IFVG: return "ifvg";
      case ZK_BPR: return "bpr"; case ZK_AOL: return "aol"; case ZK_T1: return "aol_type1_engulfing"; case ZK_T2: return "aol_type2";
      case ZK_T3: return "aol_type3"; case ZK_T4: return "aol_type4_wick_overlap"; case ZK_NDOG: return "ndog"; case ZK_NWOG: return "nwog";
     }
   return "zone";
  }
void AddZone(int kind, int side, double lo, double hi, int at, double valid, double invalid)
  {
   if(hi < lo) { double t = hi; hi = lo; lo = t; }
   int n = ArraySize(g_z); ArrayResize(g_z, n + 1);
   g_z[n].kind = kind; g_z[n].side = side; g_z[n].lo = lo; g_z[n].hi = hi; g_z[n].at = at;
   g_z[n].valid = valid; g_z[n].invalid = invalid; g_z[n].swept = false; g_z[n].lowerOk = -1;
  }
// how far into the zone price has traded since it formed (APA: consumed at 50%)
double ConsumedPct(CSlot *s, Zone &z)
  {
   double w = z.hi - z.lo;
   if(w <= 0) return 0;
   double deepest = 0;
   for(int j = z.at + 1; j <= s.lc; j++)
     {
      double pen = z.side == 1 ? z.hi - s.l[j] : s.h[j] - z.lo;
      deepest = MathMax(deepest, pen);
     }
   return MathMin(100, MathMax(0, deepest / w * 100));
  }
int Touches(CSlot *s, Zone &z)
  {
   int t = 0; bool inside = false;
   for(int j = z.at + 1; j <= s.lc; j++)
     {
      bool in = s.l[j] <= z.hi && s.h[j] >= z.lo;
      if(in && !inside) t++;
      inside = in;
     }
   return t;
  }
int ClosedThrough(CSlot *s, Zone &z)
  {
   for(int j = z.at + 1; j <= s.lc; j++)
      if(z.side == 1 ? s.c[j] < z.lo : s.c[j] > z.hi) return j;
   return -1;
  }

// APA area-of-liquidity candle types on candles i-1 (candle 1) and i (candle 2)
void FindApaTypes(CSlot *s, int from)
  {
   bool weekPlus = s.tf == PERIOD_W1 || s.tf == PERIOD_MN1;
   for(int i = MathMax(1, from); i <= s.lc; i++)
     {
      double o1 = s.o[i - 1], c1 = s.c[i - 1], h1 = s.h[i - 1], l1 = s.l[i - 1];
      double o2 = s.o[i], c2 = s.c[i], h2 = s.h[i], l2 = s.l[i];
      bool g1 = c1 > o1, r1 = c1 < o1, g2 = c2 > o2, r2 = c2 < o2;
      double rng2 = h2 - l2;
      // Type 1: same colour, candle 2 sweeps candle 1's extreme and closes beyond, engulfing it
      if(r1 && r2 && h2 > h1 && c2 < l1) AddZone(ZK_T1, -1, c2, h2, i, l1, h2);
      if(g1 && g2 && l2 < l1 && c2 > h1) AddZone(ZK_T1, 1, l2, c2, i, h1, l2);
      // Type 2: opposite colours, candle 2 SWEEPS candle 1's extreme, closes beyond candle 1's other end
      if(g1 && r2 && h2 > h1 && c2 < l1) AddZone(ZK_T2, -1, MathMin(o2, c1), h2, i, o2, h2);
      if(r1 && g2 && l2 < l1 && c2 > h1) AddZone(ZK_T2, 1, l2, MathMax(o2, c1), i, o2, l2);
      // Type 3: opposite colours, NO sweep, minor/no wick on candle 2's open side (<=15%), closes beyond candle 1
      if(g1 && r2 && h2 <= h1 && rng2 > 0 && (h2 - o2) <= 0.15 * rng2 && c2 < l1) AddZone(ZK_T3, -1, l1, h1, i, l1, h1);
      if(r1 && g2 && l2 >= l1 && rng2 > 0 && (o2 - l2) <= 0.15 * rng2 && c2 > h1) AddZone(ZK_T3, 1, l1, h1, i, h1, l1);
      // Type 4 (wick overlap, W1/MN1 only): same colour, bodies apart, wicks overlap
      if(weekPlus)
        {
         if(g1 && g2 && MathMin(o2, c2) > MathMax(o1, c1) && l2 < h1) AddZone(ZK_T4, 1, l2, h1, i, h1, l2);
         if(r1 && r2 && MathMax(o2, c2) < MathMin(o1, c1) && h2 > l1) AddZone(ZK_T4, -1, l1, h2, i, l1, h2);
        }
     }
  }

void BuildZones(CSlot *s, MsRead &r)
  {
   ArrayFree(g_z);
   int lc = s.lc; double a = Atr(s);
   // order blocks (last opposite candle within 15 before each break) -> breakers when closed through
   for(int q = MathMax(0, ArraySize(g_brAt) - 12); q < ArraySize(g_brAt); q++)
     {
      int at = g_brAt[q], side = g_brSide[q];
      for(int j = at - 1; j >= MathMax(1, at - 15); j--)
        {
         if(side == 1 ? s.c[j] < s.o[j] : s.c[j] > s.o[j])
           {
            AddZone(ZK_OB, side, s.l[j], s.h[j], j, 0, side == 1 ? s.l[j] : s.h[j]);
            int zi = ArraySize(g_z) - 1;
            // did the move into this block sweep a swing first?
            bool swept = false;
            for(int k = 0; k < ArraySize(s.swI); k++)
               if(s.swI[k] < j && s.swK[k] == -side && (side == 1 ? LowestL(s, j - 3, j) < s.swP[k] : HighestH(s, j - 3, j) > s.swP[k]) && s.swI[k] > j - 30) { swept = true; break; }
            g_z[zi].swept = swept;
            int ct = ClosedThrough(s, g_z[zi]);
            if(ct >= 0) { g_z[zi].kind = ZK_BREAKER; g_z[zi].side = -side; g_z[zi].at = ct; }
            break;
           }
        }
     }
   // FVG / IFVG (last 200 closed candles, >= 0.1 ATR)
   for(int i = MathMax(2, lc - 200); i <= lc; i++)
     {
      double gapUp = s.l[i] - s.h[i - 2], gapDn = s.l[i - 2] - s.h[i];
      if(gapUp >= 0.1 * a) AddZone(ZK_FVG, 1, s.h[i - 2], s.l[i], i, 0, s.h[i - 2]);
      else if(gapDn >= 0.1 * a) AddZone(ZK_FVG, -1, s.h[i], s.l[i - 2], i, 0, s.l[i - 2]);
      else continue;
      int zi = ArraySize(g_z) - 1;
      int ct = ClosedThrough(s, g_z[zi]);
      if(ct >= 0) { g_z[zi].kind = ZK_IFVG; g_z[zi].side = -g_z[zi].side; g_z[zi].at = ct; }
     }
   // BPR: overlap of a fresh bullish and bearish FVG
   int nz = ArraySize(g_z);
   for(int x = 0; x < nz; x++)
      for(int y = x + 1; y < nz; y++)
        {
         if(g_z[x].kind != ZK_FVG || g_z[y].kind != ZK_FVG || g_z[x].side == g_z[y].side) continue;
         double lo = MathMax(g_z[x].lo, g_z[y].lo), hi = MathMin(g_z[x].hi, g_z[y].hi);
         if(hi > lo && MathAbs(g_z[x].at - g_z[y].at) <= 20) AddZone(ZK_BPR, g_z[y].side, lo, hi, MathMax(g_z[x].at, g_z[y].at), 0, 0);
        }
   // APA area of liquidity: between validation and invalidation of the last break
   if(r.lastBos >= 0 && r.invalidation > 0)
      AddZone(ZK_AOL, g_brSide[r.lastBos], MathMin(r.validation, r.invalidation), MathMax(r.validation, r.invalidation), g_brAt[r.lastBos], r.validation, r.invalidation);
   // APA candle types (last 150 candles)
   FindApaTypes(s, lc - 150);
   // opening gaps (forex only): daily and weekly close -> open
   if(!Is247(s.sym))
     {
      CSlot *d1 = GetSlot(s.sym, PERIOD_D1, 0);
      if(d1 != NULL && d1.n >= 2 && MathAbs(d1.o[d1.n - 1] - d1.c[d1.n - 2]) > 0)
         AddZone(ZK_NDOG, d1.o[d1.n - 1] > d1.c[d1.n - 2] ? 1 : -1, MathMin(d1.o[d1.n - 1], d1.c[d1.n - 2]), MathMax(d1.o[d1.n - 1], d1.c[d1.n - 2]), lc, 0, 0);
      CSlot *w1 = GetSlot(s.sym, PERIOD_W1, 0);
      if(w1 != NULL && w1.n >= 2 && MathAbs(w1.o[w1.n - 1] - w1.c[w1.n - 2]) > 0)
         AddZone(ZK_NWOG, w1.o[w1.n - 1] > w1.c[w1.n - 2] ? 1 : -1, MathMin(w1.o[w1.n - 1], w1.c[w1.n - 2]), MathMax(w1.o[w1.n - 1], w1.c[w1.n - 2]), lc, 0, 0);
     }
  }

string ZoneJson(CSlot *s, Zone &z, double px)
  {
   double a = Atr(s), w = z.hi - z.lo, cons = ConsumedPct(s, z);
   int touches = Touches(s, z), ct = ClosedThrough(s, z);
   double mid = (z.lo + z.hi) / 2;
   string f = J("kind", ZName(z.kind)) + "," + J("side", z.side == 1 ? "demand (bullish)" : "supply (bearish)") + "," +
              Jn("top", z.hi, s.digits) + "," + Jn("bottom", z.lo, s.digits) + "," +
              Jn("width_atr", a > 0 ? w / a : 0, 2) + "," + Jn("width_pips", ToPips(s, w), 1) + "," +
              Jn("dist_atr", a > 0 ? (px > z.hi ? px - z.hi : px < z.lo ? z.lo - px : 0) / a : 0, 2) + "," +
              J("position", px > z.hi ? "price above" : px < z.lo ? "price below" : "price inside") + "," +
              Ji("age_bars", Ago(s, z.at)) + "," + J("formed", BarIso(s, z.at)) + "," +
              Ji("touches", touches) + "," + Jb("fresh", touches == 0) + "," +
              Jn("consumed_pct", cons, 0) + "," + Jb("consumed", cons >= 50) + "," +
              Jb("closed_through", ct >= 0);
   if(z.valid > 0) f += "," + Jn("validation", z.valid, s.digits);
   if(z.invalid > 0) f += "," + Jn("invalidation", z.invalid, s.digits) + "," + Jn("sl_size_pips", ToPips(s, MathAbs(z.invalid - (z.side == 1 ? z.hi : z.lo))), 1) +
                          "," + Jn("sl_size_atr", a > 0 ? MathAbs(z.invalid - (z.side == 1 ? z.hi : z.lo)) / a : 0, 2);
   if(z.kind == ZK_BREAKER) f += "," + Jb("swept_before", z.swept) + "," + J("note", z.swept ? "breaker" : "no sweep before it = mitigation-block case");
   if(z.kind == ZK_T4) f += "," + (z.lowerOk < 0 ? Jnull("lower_tf_formation_found") : Jb("lower_tf_formation_found", z.lowerOk == 1));
   // other zones overlapping it
   string ov = "";
   for(int k = 0; k < ArraySize(g_z); k++)
     {
      if(g_z[k].kind == z.kind && g_z[k].at == z.at) continue;
      if(g_z[k].lo <= z.hi && g_z[k].hi >= z.lo) ov += (ov == "" ? "" : ",") + "\"" + ZName(g_z[k].kind) + "\"";
     }
   f += "," + Jr("overlaps", "[" + ov + "]");
   return Obj(f);
  }

string C_Zones(CSlot *s)
  {
   MsRead r; ReadStructure(s, r);
   BuildZones(s, r);
   int lc = s.lc; double px = s.c[lc];
   // Type 4 needs structure inside it on the next lower timeframe
   CSlot *lower = NULL;
   bool hasT4 = false;
   for(int k = 0; k < ArraySize(g_z); k++) if(g_z[k].kind == ZK_T4) hasT4 = true;
   if(hasT4) lower = GetSlot(s.sym, LowerTf(s.tf), 0);
   if(lower != NULL)
      for(int k = 0; k < ArraySize(g_z); k++)
        {
         if(g_z[k].kind != ZK_T4) continue;
         g_z[k].lowerOk = 0;
         for(int q = 0; q < ArraySize(lower.swI); q++)
            if(lower.t[lower.swI[q]] >= s.t[g_z[k].at] && lower.swP[q] >= g_z[k].lo && lower.swP[q] <= g_z[k].hi) { g_z[k].lowerOk = 1; break; }
        }
   // nearest first, not invalidated; 3 demand + 3 supply in the main list, the rest in detail (cap 12)
   int order[]; double dist[];
   for(int k = 0; k < ArraySize(g_z); k++)
     {
      if(ClosedThrough(s, g_z[k]) >= 0) continue;
      int m = ArraySize(order); ArrayResize(order, m + 1); ArrayResize(dist, m + 1);
      order[m] = k; dist[m] = px > g_z[k].hi ? px - g_z[k].hi : px < g_z[k].lo ? g_z[k].lo - px : 0;
     }
   for(int x = 0; x < ArraySize(order) - 1; x++)
      for(int y = x + 1; y < ArraySize(order); y++)
         if(dist[y] < dist[x]) { double t = dist[x]; dist[x] = dist[y]; dist[y] = t; int ti = order[x]; order[x] = order[y]; order[y] = ti; }
   string dem[], sup[], more[], apa[];
   for(int x = 0; x < ArraySize(order); x++)
     {
      Zone z = g_z[order[x]];
      string js = ZoneJson(s, z, px);
      bool isApa = z.kind == ZK_AOL || z.kind == ZK_T1 || z.kind == ZK_T2 || z.kind == ZK_T3 || z.kind == ZK_T4;
      if(isApa && ArraySize(apa) < 6) A_Push(apa, js);
      if(z.side == 1 && ArraySize(dem) < 3) A_Push(dem, js);
      else if(z.side == -1 && ArraySize(sup) < 3) A_Push(sup, js);
      else if(ArraySize(more) < 6) A_Push(more, js);
     }
   bool insideAol = false;
   for(int k = 0; k < ArraySize(g_z); k++) if(g_z[k].kind == ZK_AOL && px >= g_z[k].lo && px <= g_z[k].hi) insideAol = true;
   // refinement: fresh zones of the next lower timeframe lying inside this timeframe's AOL
   string refine[];
   int aolK = -1;
   for(int k = 0; k < ArraySize(g_z); k++) if(g_z[k].kind == ZK_AOL) aolK = k;
   if(aolK >= 0)
     {
      double alo = g_z[aolK].lo, ahi = g_z[aolK].hi;
      CSlot *ls = GetSlot(s.sym, LowerTf(s.tf), 0);
      if(ls != NULL)
        {
         Zone keep[]; ArrayResize(keep, ArraySize(g_z));
         for(int k = 0; k < ArraySize(g_z); k++) keep[k] = g_z[k];
         MsRead lr; ReadStructure(ls, lr); BuildZones(ls, lr);
         for(int k = 0; k < ArraySize(g_z) && ArraySize(refine) < 3; k++)
            if(g_z[k].lo >= alo && g_z[k].hi <= ahi && ConsumedPct(ls, g_z[k]) < 50 && ClosedThrough(ls, g_z[k]) < 0)
               A_Push(refine, Obj(J("tf", TfName(ls.tf)) + "," + J("kind", ZName(g_z[k].kind)) + "," + Jn("top", g_z[k].hi, s.digits) + "," + Jn("bottom", g_z[k].lo, s.digits)));
         ArrayResize(g_z, ArraySize(keep));
         for(int k = 0; k < ArraySize(keep); k++) g_z[k] = keep[k];
        }
     }
   return Obj(J("rules", "order block = last opposite candle before a break; breaker = order block closed through; FVG = 3-candle gap >= 0.1 ATR; IFVG = FVG closed through; consumed = 50% traded through (APA); AOL = between the last break's validation and invalidation; APA types per the book (1 same colour+sweep+engulf, 2 opposite+sweep+close beyond, 3 opposite+no sweep+no/minor wick (<=15%)+close beyond, 4 W1/MN1 wick overlap); sorted by distance; invalidated zones left out") + "," +
              Jr("demand", Arr(dem)) + "," + Jr("supply", Arr(sup)) + "," +
              Jr("apa_areas", Arr(apa)) + "," + Jb("price_inside_aol", insideAol) + "," +
              Jr("refinement_inside_aol", Arr(refine)) + "," + Jr("more", Arr(more)));
  }

//+------------------------------------------------------------------+
//| 2. get_candles                                                    |
//+------------------------------------------------------------------+
string PatternAt(CSlot *s, int i)
  {
   if(i < 2 || i > s.lc) return "";
   double rng = s.h[i] - s.l[i], body = MathAbs(s.c[i] - s.o[i]);
   if(rng <= 0) return "";
   double up = s.h[i] - MathMax(s.o[i], s.c[i]), dn = MathMin(s.o[i], s.c[i]) - s.l[i];
   string p = "";
   if(body <= 0.1 * rng) p = "doji";
   else if(dn >= 2.0 / 3 * rng && body <= rng / 3 && MathMin(s.o[i], s.c[i]) >= s.l[i] + 2.0 / 3 * rng) p = "pin_bar_bullish";
   else if(up >= 2.0 / 3 * rng && body <= rng / 3 && MathMax(s.o[i], s.c[i]) <= s.h[i] - 2.0 / 3 * rng) p = "pin_bar_bearish";
   double pb = MathAbs(s.c[i - 1] - s.o[i - 1]);
   bool twoOppBefore = (s.c[i - 1] < s.o[i - 1] && s.c[i - 2] < s.o[i - 2]) || (s.c[i - 1] > s.o[i - 1] && s.c[i - 2] > s.o[i - 2]);
   if(twoOppBefore && body > pb && MathMax(s.o[i], s.c[i]) >= MathMax(s.o[i - 1], s.c[i - 1]) && MathMin(s.o[i], s.c[i]) <= MathMin(s.o[i - 1], s.c[i - 1]))
     {
      if(s.c[i] > s.o[i] && s.c[i - 1] < s.o[i - 1]) p = "engulfing_bullish";
      if(s.c[i] < s.o[i] && s.c[i - 1] > s.o[i - 1]) p = "engulfing_bearish";
     }
   if(p == "" && s.h[i] <= s.h[i - 1] && s.l[i] >= s.l[i - 1]) p = "inside_bar";
   if(p == "" && s.h[i] > s.h[i - 1] && s.l[i] < s.l[i - 1]) p = "outside_bar";
   // morning / evening star on i-2, i-1, i
   double b2 = MathAbs(s.c[i - 2] - s.o[i - 2]), b1 = MathAbs(s.c[i - 1] - s.o[i - 1]);
   double mid2 = (s.o[i - 2] + s.c[i - 2]) / 2;
   if(b2 > 0 && b1 <= 0.3 * b2)
     {
      if(s.c[i - 2] < s.o[i - 2] && s.c[i] > s.o[i] && s.c[i] > mid2) p = "morning_star";
      if(s.c[i - 2] > s.o[i - 2] && s.c[i] < s.o[i] && s.c[i] < mid2) p = "evening_star";
     }
   return p;
  }

string C_Candles(CSlot *s, int count)
  {
   if(count < 1) count = 21;
   if(count > 300) count = 300;
   int last = s.n - 1;
   string rows[];
   for(int i = last; i >= 0 && i > last - count; i--)
     {
      double rng = s.h[i] - s.l[i], body = MathAbs(s.c[i] - s.o[i]);
      double prevAtr = i >= 1 ? s.atr[i - 1] : 0;
      bool closed = i <= s.lc;
      string row = J("t", BarIso(s, i)) + "," + Jb("closed", closed) + "," +
                   Jn("o", s.o[i], s.digits) + "," + Jn("h", s.h[i], s.digits) + "," + Jn("l", s.l[i], s.digits) + "," + Jn("c", s.c[i], s.digits) + "," +
                   Ji("v", s.v[i]) + "," + J("dir", s.c[i] > s.o[i] ? "bull" : s.c[i] < s.o[i] ? "bear" : "flat") + "," +
                   Jn("body", body, s.digits) + "," + Jn("upper_wick", s.h[i] - MathMax(s.o[i], s.c[i]), s.digits) + "," + Jn("lower_wick", MathMin(s.o[i], s.c[i]) - s.l[i], s.digits) + "," +
                   Jn("size_vs_atr", prevAtr > 0 ? rng / prevAtr : 0, 2) + "," + Jn("close_pos_pct", rng > 0 ? (s.c[i] - s.l[i]) / rng * 100 : 50, 0);
      if(i >= 1 && MathAbs(s.o[i] - s.c[i - 1]) > 0.1 * (prevAtr > 0 ? prevAtr : rng)) row += "," + J("gap", s.o[i] > s.c[i - 1] ? "up" : "down");
      if(closed) { string p = PatternAt(s, i); if(p != "") row += "," + J("pattern", p); }
      if(!closed) row += "," + Ji("seconds_left", MathMax((long)0, (long)PeriodSeconds(s.tf) - (long)(TimeTradeServer() - s.t[i])));
      A_Push(rows, Obj(row));
     }
   // run of same-direction closes ending at the last closed candle
   int run = 0, dir = s.c[s.lc] > s.o[s.lc] ? 1 : s.c[s.lc] < s.o[s.lc] ? -1 : 0;
   for(int i = s.lc; i >= 0 && dir != 0; i--) { int d = s.c[i] > s.o[i] ? 1 : s.c[i] < s.o[i] ? -1 : 0; if(d != dir) break; run++; }
   // APA Type 1 engulfing on the last 3 closed candles
   ArrayFree(g_z);
   FindApaTypes(s, s.lc - 2);
   string t1 = "null";
   for(int k = 0; k < ArraySize(g_z); k++) if(g_z[k].kind == ZK_T1) t1 = Obj(J("side", g_z[k].side == 1 ? "bullish" : "bearish") + "," + Ji("bars_ago", Ago(s, g_z[k].at)));
   return Obj(J("order", "newest_first") + "," + J("times", "UTC") + "," + J("volume_is", "tick volume (number of price changes)") + "," +
              J("patterns_rule", "closed candles only: doji body<=10%; pin bar wick>=2/3, body<=1/3, close in outer third; engulfing body over prior body after 2 opposite closes; inside/outside bar; morning/evening star") + "," +
              Jr("same_direction_run", Obj(J("dir", dir > 0 ? "bull" : dir < 0 ? "bear" : "flat") + "," + Ji("candles", run))) + "," +
              Jr("apa_type1_engulfing_recent", t1) + "," +
              Jr("candles", Arr(rows)));
  }

//+------------------------------------------------------------------+
//| 6. get_trend                                                      |
//+------------------------------------------------------------------+
string MaJson(CSlot *s, string name, const double &ma[], double px)
  {
   int lc = s.lc; double a = Atr(s);
   double v = ma[lc];
   if(v <= 0) return Jwhy(name, "not enough candles");
   double slope = lc >= 5 && a > 0 ? (ma[lc] - ma[lc - 5]) / a : 0;
   return Jr(name, Obj(Jn("value", v, s.digits) + "," + J("price", px > v ? "above" : px < v ? "below" : "at") + "," + Jn("slope_atr_per_5", slope, 3)));
  }

string C_Trend(CSlot *s)
  {
   int lc = s.lc; double px = s.c[lc], a = Atr(s);
   string f[];
   A_Push(f, J("rules", "closed candles; EMA seeded with SMA; SMMA = Wilder; ADX/DI Wilder 14 (same as MT5 iADXWilder, not iADX); Supertrend(10,3) on ATR10; Ichimoku 9/26/52; slope = MA change over 5 candles in ATR"));
   A_Push(f, MaJson(s, "ema20", s.ema20, px)); A_Push(f, MaJson(s, "ema50", s.ema50, px)); A_Push(f, MaJson(s, "ema200", s.ema200, px));
   A_Push(f, MaJson(s, "smma6", s.smma6, px)); A_Push(f, MaJson(s, "smma20", s.smma20, px)); A_Push(f, MaJson(s, "smma100", s.smma100, px));
   double sma50 = SmaAt(s.c, lc, 50), sma200 = SmaAt(s.c, lc, 200);
   A_Push(f, sma200 > 0 ? Jr("sma200", Obj(Jn("value", sma200, s.digits) + "," + J("price", px > sma200 ? "above" : "below"))) : Jwhy("sma200", "fewer than 200 candles"));
   // golden / death cross: last SMA50 x SMA200 cross
   if(sma200 > 0)
     {
      int crossAt = -1; int kind = 0;
      for(int i = lc; i >= 201 && crossAt < 0; i--)
        {
         double a1 = SmaAt(s.c, i, 50) - SmaAt(s.c, i, 200), a0 = SmaAt(s.c, i - 1, 50) - SmaAt(s.c, i - 1, 200);
         if(a1 > 0 && a0 <= 0) { crossAt = i; kind = 1; }
         if(a1 < 0 && a0 >= 0) { crossAt = i; kind = -1; }
        }
      A_Push(f, crossAt >= 0 ? Jr("sma50_200_cross", Obj(J("type", kind > 0 ? "golden" : "death") + "," + Ji("bars_ago", Ago(s, crossAt)))) : Jnull("sma50_200_cross"));
     }
   A_Push(f, Jn("dist_from_ema20_atr", a > 0 && s.ema20[lc] > 0 ? (px - s.ema20[lc]) / a : 0, 2));
   // ADX / DI
   int diCross = -1;
   for(int i = lc; i > 15 && diCross < 0; i--) if((s.pdi[i] - s.mdi[i]) * (s.pdi[i - 1] - s.mdi[i - 1]) < 0) diCross = i;
   A_Push(f, Jr("adx", Obj(Jn("adx", s.adx[lc], 1) + "," + Jn("plus_di", s.pdi[lc], 1) + "," + Jn("minus_di", s.mdi[lc], 1) + "," +
                           Jb("rising", lc >= 5 && s.adx[lc] > s.adx[lc - 5]) + "," + J("di_on_top", s.pdi[lc] >= s.mdi[lc] ? "plus" : "minus") + "," +
                           (diCross >= 0 ? Ji("di_cross_bars_ago", Ago(s, diCross)) : Jnull("di_cross_bars_ago")))));
   // Supertrend
   int flip = -1;
   for(int i = lc; i > 11 && flip < 0; i--) if(s.stDir[i] != s.stDir[i - 1]) flip = i;
   A_Push(f, Jr("supertrend", Obj(J("dir", s.stDir[lc] > 0 ? "up" : "down") + "," + Lv(s, s.st[lc], px) + "," + (flip >= 0 ? Ji("flip_bars_ago", Ago(s, flip)) : Jnull("flip_bars_ago")))));
   // Ichimoku (short): cloud at the current candle = spans computed 26 candles ago
   if(lc >= 52 + 26)
     {
      int b = lc - 26;
      double tenB = (HighestH(s, b - 8, b) + LowestL(s, b - 8, b)) / 2, kijB = (HighestH(s, b - 25, b) + LowestL(s, b - 25, b)) / 2;
      double spanA = (tenB + kijB) / 2, spanB = (HighestH(s, b - 51, b) + LowestL(s, b - 51, b)) / 2;
      double ten = (HighestH(s, lc - 8, lc) + LowestL(s, lc - 8, lc)) / 2, kij = (HighestH(s, lc - 25, lc) + LowestL(s, lc - 25, lc)) / 2;
      int tkCross = -1;
      for(int i = lc; i > lc - 60 && i > 26 && tkCross < 0; i--)
        {
         double t1 = (HighestH(s, i - 8, i) + LowestL(s, i - 8, i)) / 2, k1 = (HighestH(s, i - 25, i) + LowestL(s, i - 25, i)) / 2;
         double t0 = (HighestH(s, i - 9, i - 1) + LowestL(s, i - 9, i - 1)) / 2, k0 = (HighestH(s, i - 26, i - 1) + LowestL(s, i - 26, i - 1)) / 2;
         if((t1 - k1) * (t0 - k0) < 0) tkCross = i;
        }
      double top = MathMax(spanA, spanB), bot = MathMin(spanA, spanB);
      A_Push(f, Jr("ichimoku", Obj(J("price_vs_cloud", px > top ? "above" : px < bot ? "below" : "inside") + "," +
                                   J("cloud_colour", spanA >= spanB ? "bullish" : "bearish") + "," + Jn("cloud_top", top, s.digits) + "," + Jn("cloud_bottom", bot, s.digits) + "," +
                                   J("tenkan_vs_kijun", ten >= kij ? "tenkan above" : "tenkan below") + "," + (tkCross >= 0 ? Ji("tk_cross_bars_ago", Ago(s, tkCross)) : Jnull("tk_cross_bars_ago")))));
     }
   // linear regression slope (20) and efficiency ratio (10)
   if(lc >= 20)
     {
      double sx = 0, sy = 0, sxy = 0, sxx = 0;
      for(int k = 0; k < 20; k++) { double x = k, y = s.c[lc - 19 + k]; sx += x; sy += y; sxy += x * y; sxx += x * x; }
      double slope = (20 * sxy - sx * sy) / (20 * sxx - sx * sx);
      A_Push(f, Jn("regression_slope_atr_per_bar", a > 0 ? slope / a : 0, 3));
     }
   double er = 0;
   if(lc >= 10)
     {
      double path = 0;
      for(int k = lc - 9; k <= lc; k++) path += MathAbs(s.c[k] - s.c[k - 1]);
      er = path > 0 ? MathAbs(s.c[lc] - s.c[lc - 10]) / path : 0;
     }
   A_Push(f, Jn("efficiency_ratio_10", er, 2));
   // higher timeframe EMA200
   CSlot *hs = GetSlot(s.sym, HigherTf(s.tf), 0);
   if(hs != NULL && hs.ema200[hs.lc] > 0)
      A_Push(f, Jr("higher_tf_ema200", Obj(J("tf", TfName(hs.tf)) + "," + J("price", hs.c[hs.lc] > hs.ema200[hs.lc] ? "above" : "below") + "," +
                                           Jn("slope_atr_per_5", hs.lc >= 5 && Atr(hs) > 0 ? (hs.ema200[hs.lc] - hs.ema200[hs.lc - 5]) / Atr(hs) : 0, 3))));
   else A_Push(f, Jwhy("higher_tf_ema200", "higher timeframe not loaded yet"));
   string regime = s.adx[lc] > 25 && er > 0.3 ? "trending" : s.adx[lc] < 20 ? "ranging" : "mixed";
   A_Push(f, Jr("regime", Obj(J("label", regime) + "," + J("rule", "trending = ADX>25 and ER>0.3; ranging = ADX<20; else mixed"))));
   return Obj(A_Join(f));
  }

//+------------------------------------------------------------------+
//| 7. get_momentum                                                   |
//+------------------------------------------------------------------+
string C_Momentum(CSlot *s)
  {
   int lc = s.lc;
   string f[];
   A_Push(f, J("rules", "closed candles only; RSI 14 Wilder; MACD 12/26/9; Stochastic 14/3/3; ROC 10; z-score (close-SMA20)/StdDev20; divergence only between two CONFIRMED swings 5-60 candles apart"));
   string last5 = "";
   for(int i = lc - 4; i <= lc; i++) last5 += (last5 == "" ? "" : ",") + DoubleToString(s.rsi[i], 1);
   int ob = -1, os = -1;
   for(int i = lc; i > 14 && (ob < 0 || os < 0); i--) { if(ob < 0 && s.rsi[i] > 70) ob = i; if(os < 0 && s.rsi[i] < 30) os = i; }
   string rsi = Jn("value", s.rsi[lc], 1) + "," + Jr("last5_closed", "[" + last5 + "]") + "," +
                (ob >= 0 ? Ji("bars_since_above_70", Ago(s, ob)) : Jnull("bars_since_above_70")) + "," +
                (os >= 0 ? Ji("bars_since_below_30", Ago(s, os)) : Jnull("bars_since_below_30"));
   CSlot *hs = GetSlot(s.sym, HigherTf(s.tf), 0);
   if(hs != NULL) rsi += "," + Jr("higher_tf", Obj(J("tf", TfName(hs.tf)) + "," + Jn("rsi", hs.rsi[hs.lc], 1)));
   A_Push(f, Jr("rsi", Obj(rsi)));
   int mx = -1, mxDir = 0;
   for(int i = lc; i > 35 && mx < 0; i--)
     {
      double d1 = s.macd[i] - s.macdSig[i], d0 = s.macd[i - 1] - s.macdSig[i - 1];
      if(d1 * d0 < 0) { mx = i; mxDir = d1 > 0 ? 1 : -1; }
     }
   A_Push(f, Jr("macd", Obj(Jn("main", s.macd[lc], s.digits + 1) + "," + Jn("signal", s.macdSig[lc], s.digits + 1) + "," + Jn("histogram", s.macd[lc] - s.macdSig[lc], s.digits + 1) + "," +
                            Jb("histogram_growing", MathAbs(s.macd[lc] - s.macdSig[lc]) > MathAbs(s.macd[lc - 1] - s.macdSig[lc - 1])) + "," +
                            (mx >= 0 ? Jr("last_cross", Obj(J("dir", mxDir > 0 ? "up" : "down") + "," + Ji("bars_ago", Ago(s, mx)))) : Jnull("last_cross")))));
   int sx = -1;
   for(int i = lc; i > 18 && sx < 0; i--) if((s.stK[i] - s.stD[i]) * (s.stK[i - 1] - s.stD[i - 1]) < 0) sx = i;
   A_Push(f, Jr("stochastic", Obj(Jn("k", s.stK[lc], 1) + "," + Jn("d", s.stD[lc], 1) + "," + (sx >= 0 ? Ji("cross_bars_ago", Ago(s, sx)) : Jnull("cross_bars_ago")))));
   A_Push(f, Jn("roc_10_pct", lc >= 10 && s.c[lc - 10] > 0 ? (s.c[lc] - s.c[lc - 10]) / s.c[lc - 10] * 100 : 0, 3));
   double sd = StdAt(s.c, lc, 20);
   A_Push(f, Jn("zscore_20", sd > 0 ? (s.c[lc] - SmaAt(s.c, lc, 20)) / sd : 0, 2));
   // divergence: latest between the last two confirmed swing highs / lows
   string div = "null"; int bestAt = -1;
   for(int kind = 1; kind >= -1; kind -= 2)
     {
      int k2 = -1, k1 = -1;
      for(int k = ArraySize(s.swI) - 1; k >= 0; k--) if(s.swK[k] == kind) { if(k2 < 0) k2 = k; else { k1 = k; break; } }
      if(k1 < 0) continue;
      int i1 = s.swI[k1], i2 = s.swI[k2], gap = i2 - i1;
      if(gap < 5 || gap > 60 || i2 <= bestAt) continue;
      double p1 = s.swP[k1], p2 = s.swP[k2];
      string osc[] = {"rsi", "macd_histogram", "stochastic_k"};
      for(int o = 0; o < 3; o++)
        {
         double v1 = o == 0 ? s.rsi[i1] : o == 1 ? s.macd[i1] - s.macdSig[i1] : s.stK[i1];
         double v2 = o == 0 ? s.rsi[i2] : o == 1 ? s.macd[i2] - s.macdSig[i2] : s.stK[i2];
         string type = "";
         if(kind == 1 && p2 > p1 && v2 < v1) type = "regular bearish";
         if(kind == 1 && p2 < p1 && v2 > v1) type = "hidden bearish";
         if(kind == -1 && p2 < p1 && v2 > v1) type = "regular bullish";
         if(kind == -1 && p2 > p1 && v2 < v1) type = "hidden bullish";
         if(type == "") continue;
         bestAt = i2;
         div = Obj(J("type", type) + "," + J("oscillator", osc[o]) + "," + Jn("price_1", p1, s.digits) + "," + Jn("price_2", p2, s.digits) + "," +
                   Jn("osc_1", v1, 3) + "," + Jn("osc_2", v2, 3) + "," + Ji("bars_ago", Ago(s, i2)));
         break;
        }
     }
   A_Push(f, Jr("divergence_latest", div));
   return Obj(A_Join(f));
  }

//+------------------------------------------------------------------+
//| 8. get_volatility                                                 |
//+------------------------------------------------------------------+
int MinutesToSessionEnd(string sym)
  {
   datetime now = TimeGMT();
   if(Is247(sym)) { MqlDateTime d; TimeToStruct(now, d); return 1440 - (d.hour * 60 + d.min); }
   int ny = LocalMinuteOfDay(TZ_NEWYORK, now);
   int left = 17 * 60 - ny;
   return left > 0 ? left : left + 1440;
  }

string C_Volatility(CSlot *s)
  {
   int lc = s.lc; double a = Atr(s), px = s.c[lc];
   string f[];
   A_Push(f, J("rules", "ATR 14 Wilder; Bollinger 20/2; Keltner EMA20 +- 1.5 x ATR10; squeeze = Bollinger inside Keltner; Donchian 20 on closed candles"));
   double atrs[]; int m = 0;
   for(int i = MathMax(14, lc - 199); i <= lc; i++) { ArrayResize(atrs, m + 1); atrs[m++] = s.atr[i]; }
   double sorted[]; ArrayCopy(sorted, atrs); ArraySort(sorted);
   double med = m > 0 ? sorted[m / 2] : a;
   int below = 0; for(int i = 0; i < m; i++) if(atrs[i] < a) below++;
   A_Push(f, Jr("atr", Obj(Jn("value", a, s.digits) + "," + Jn("pips", ToPips(s, a), 1) + "," + Jn("vs_median_200", med > 0 ? a / med : 0, 2) + "," +
                           Jn("percentile_200", m > 0 ? (double)below / m * 100 : 50, 0) + "," +
                           Jn("vs_20_bars_ago", lc >= 20 && s.atr[lc - 20] > 0 ? a / s.atr[lc - 20] : 0, 2))));
   double mid = SmaAt(s.c, lc, 20), sd = StdAt(s.c, lc, 20);
   double bu = mid + 2 * sd, bl = mid - 2 * sd;
   double ku = s.ema20[lc] + 1.5 * s.atr10[lc], kl = s.ema20[lc] - 1.5 * s.atr10[lc];
   A_Push(f, Jr("bollinger", Obj(Jn("upper", bu, s.digits) + "," + Jn("middle", mid, s.digits) + "," + Jn("lower", bl, s.digits) + "," +
                                 Jn("width_atr", a > 0 ? (bu - bl) / a : 0, 2) + "," + Jn("percent_b", bu > bl ? (px - bl) / (bu - bl) : 0.5, 2))));
   A_Push(f, Jr("keltner", Obj(Jn("upper", ku, s.digits) + "," + Jn("lower", kl, s.digits))));
   // squeeze history
   int len = 0, released = -1;
   for(int i = lc; i > 40; i--)
     {
      double m2 = SmaAt(s.c, i, 20), sd2 = StdAt(s.c, i, 20);
      bool sq = (m2 + 2 * sd2) < (s.ema20[i] + 1.5 * s.atr10[i]) && (m2 - 2 * sd2) > (s.ema20[i] - 1.5 * s.atr10[i]);
      if(i == lc && !sq) { // find when the last squeeze ended
         for(int j = lc - 1; j > 40; j--)
           {
            double m3 = SmaAt(s.c, j, 20), sd3 = StdAt(s.c, j, 20);
            if((m3 + 2 * sd3) < (s.ema20[j] + 1.5 * s.atr10[j]) && (m3 - 2 * sd3) > (s.ema20[j] - 1.5 * s.atr10[j])) { released = j + 1; break; }
           }
         break;
        }
      if(!sq) break;
      len++;
     }
   A_Push(f, Jr("squeeze", Obj(Jb("on", len > 0) + "," + Ji("length_bars", len) + "," + (released >= 0 ? Ji("released_bars_ago", Ago(s, released)) : Jnull("released_bars_ago")))));
   A_Push(f, Jr("donchian_20", Obj(Jn("high", HighestH(s, lc - 19, lc), s.digits) + "," + Jn("low", LowestL(s, lc - 19, lc), s.digits))));
   // historical volatility (annualised stdev of log returns, 20)
   double rets[]; ArrayResize(rets, 20);
   for(int k = 0; k < 20; k++) rets[k] = s.c[lc - k - 1] > 0 ? MathLog(s.c[lc - k] / s.c[lc - k - 1]) : 0;
   double mr = 0; for(int k = 0; k < 20; k++) mr += rets[k]; mr /= 20;
   double vr = 0; for(int k = 0; k < 20; k++) vr += (rets[k] - mr) * (rets[k] - mr); vr /= 19;
   double perYear = Is247(s.sym) ? 365.0 * 86400 / PeriodSeconds(s.tf) : 252.0 * 86400 / PeriodSeconds(s.tf);
   if(s.tf == PERIOD_W1) perYear = 52;
   if(s.tf == PERIOD_MN1) perYear = 12;
   A_Push(f, Jn("historical_vol_annual_pct", MathSqrt(vr * perYear) * 100, 2));
   A_Push(f, J("state", lc >= 20 && s.atr[lc - 20] > 0 ? (a > 1.1 * s.atr[lc - 20] ? "expanding" : a < 0.9 * s.atr[lc - 20] ? "contracting" : "steady") : "unknown"));
   int minsLeft = MinutesToSessionEnd(s.sym);
   double barsLeft = (double)minsLeft * 60 / PeriodSeconds(s.tf);
   A_Push(f, Jr("expected_move_to_session_end", Obj(Jn("price", barsLeft > 0 ? a * MathSqrt(barsLeft) : 0, s.digits) + "," + Jn("pips", ToPips(s, barsLeft > 0 ? a * MathSqrt(barsLeft) : 0), 1) + "," +
                                                   Ji("minutes_left", minsLeft) + "," + J("rule", (Is247(s.sym) ? "to 00:00 UTC" : "to 17:00 New York") + "; ATR x sqrt(candles left)"))));
   return Obj(A_Join(f));
  }

//+------------------------------------------------------------------+
//| 9. get_volume (tick-based -- MT5 has no buyer/seller side here)   |
//+------------------------------------------------------------------+
string C_Volume(CSlot *s)
  {
   int lc = s.lc; double a = Atr(s);
   string f[];
   A_Push(f, J("honesty", "MT5 forex/synthetic feeds have no buy/sell (aggressor) flags; volume = tick count (number of price changes). Buy/sell pressure below is an ESTIMATE from tick direction."));
   double vv[]; ArrayResize(vv, s.n);
   for(int i = 0; i < s.n; i++) vv[i] = (double)s.v[i];
   double avg20 = SmaAt(vv, lc, 20);
   // same hour-of-day average (intraday only)
   double hourAvg = 0; int hn = 0;
   if(PeriodSeconds(s.tf) < 86400)
     {
      MqlDateTime d0; TimeToStruct(s.t[lc], d0);
      for(int i = lc - 1; i >= 0 && hn < 20; i--) { MqlDateTime d; TimeToStruct(s.t[i], d); if(d.hour == d0.hour && d.min == d0.min) { hourAvg += vv[i]; hn++; } }
      if(hn > 0) hourAvg /= hn;
     }
   A_Push(f, Jr("tick_volume", Obj(Ji("last_closed", s.v[lc]) + "," + Jn("avg_20", avg20, 0) + "," + Jn("vs_avg_20", avg20 > 0 ? vv[lc] / avg20 : 0, 2) + "," +
                                   (hn > 0 ? Jn("vs_same_time_of_day", hourAvg > 0 ? vv[lc] / hourAvg : 0, 2) : Jnull("vs_same_time_of_day")))));
   string sp[];
   for(int i = lc; i > lc - 50 && i > 20 && ArraySize(sp) < 3; i--)
     {
      double av = SmaAt(vv, i - 1, 20);
      if(av <= 0 || vv[i] < 2 * av) continue;
      bool extreme = s.h[i] >= HighestH(s, i - 19, i) || s.l[i] <= LowestL(s, i - 19, i);
      A_Push(sp, Obj(Ji("bars_ago", Ago(s, i)) + "," + Jn("x_avg", vv[i] / av, 1) + "," + Jb("climax", vv[i] >= 3 * av && extreme) + "," + J("dir", s.c[i] > s.o[i] ? "bull" : "bear")));
     }
   A_Push(f, Jr("spikes", Arr(sp)));
   // tick buffer (MT5 keeps the last 4096 ticks in memory; asked only when the symbol is synchronized)
   MqlTick tk[];
   int got = SymbolIsSynchronized(s.sym) ? CopyTicks(s.sym, tk, COPY_TICKS_INFO, 0, 1000) : 0;
   int upT = 0, dnT = 0, last60 = 0; double lastP = 0;
   long nowMsc = got > 0 ? tk[got - 1].time_msc : 0;
   for(int i = 0; i < got; i++)
     {
      double p = tk[i].bid;
      if(lastP > 0) { if(p > lastP) upT++; else if(p < lastP) dnT++; }
      lastP = p;
      if(nowMsc - tk[i].time_msc <= 60000) last60++;
     }
   double spanSec = got > 1 ? (double)(tk[got - 1].time_msc - tk[0].time_msc) / 1000.0 : 0;
   A_Push(f, Jr("estimated_pressure", Obj(J("basis", "estimated_from_tick_direction") + "," + Ji("ticks", got) + "," + Ji("up_ticks", upT) + "," + Ji("down_ticks", dnT) + "," +
                                          Ji("delta", upT - dnT) + "," + Jn("up_pct", upT + dnT > 0 ? (double)upT / (upT + dnT) * 100 : 50, 1))));
   A_Push(f, Jr("tick_speed", Obj(Jn("ticks_per_sec_last_60s", last60 / 60.0, 2) + "," + Jn("ticks_per_sec_buffer", spanSec > 0 ? got / spanSec : 0, 2))));
   // leg participation: tick volume per bar on the last up-leg vs down-leg (external swings)
   int ne = ArraySize(s.exI);
   if(ne >= 2)
     {
      int i0 = s.exI[ne - 2], i1 = s.exI[ne - 1];
      double legV = 0, pbV = 0; int legN = 0, pbN = 0;
      for(int i = i0 + 1; i <= i1; i++) { legV += vv[i]; legN++; }
      for(int i = i1 + 1; i <= lc; i++) { pbV += vv[i]; pbN++; }
      A_Push(f, Jr("leg_participation", Obj(J("last_leg", s.exP[ne - 1] > s.exP[ne - 2] ? "up" : "down") + "," + Jn("avg_tick_vol_last_leg", legN > 0 ? legV / legN : 0, 0) + "," +
                                            Jn("avg_tick_vol_since", pbN > 0 ? pbV / pbN : 0, 0))));
     }
   // OBV (tick volume)
   double obv = 0, obv20 = 0;
   for(int i = 1; i <= lc; i++) { obv += s.c[i] > s.c[i - 1] ? vv[i] : s.c[i] < s.c[i - 1] ? -vv[i] : 0; if(i == lc - 20) obv20 = obv; }
   A_Push(f, Jr("obv", Obj(Jn("value", obv, 0) + "," + J("vs_20_bars_ago", obv > obv20 ? "higher" : obv < obv20 ? "lower" : "same"))));
   // tick VWAP + profile over today's candles (intraday) or the last 50
   MqlDateTime nd; TimeToStruct(s.t[s.n - 1], nd);
   datetime dayStart = s.t[s.n - 1] - (nd.hour * 3600 + nd.min * 60 + nd.sec);
   int from = PeriodSeconds(s.tf) < 86400 ? s.n - 1 : MathMax(0, lc - 49);
   if(PeriodSeconds(s.tf) < 86400) while(from > 0 && s.t[from - 1] >= dayStart) from--;
   double pv = 0, vs = 0, pv2 = 0;
   for(int i = from; i <= lc; i++) { double tp = (s.h[i] + s.l[i] + s.c[i]) / 3; pv += tp * vv[i]; pv2 += tp * tp * vv[i]; vs += vv[i]; }
   if(vs > 0)
     {
      double vw = pv / vs, vsd = MathSqrt(MathMax(0, pv2 / vs - vw * vw));
      A_Push(f, Jr("tick_vwap", Obj(J("anchor", PeriodSeconds(s.tf) < 86400 ? "day open (server day)" : "last 50 candles") + "," + Lv(s, vw, s.c[lc]) + "," +
                                    Jn("band1_up", vw + vsd, s.digits) + "," + Jn("band1_down", vw - vsd, s.digits) + "," + Jn("band2_up", vw + 2 * vsd, s.digits) + "," + Jn("band2_down", vw - 2 * vsd, s.digits))));
      double hi = HighestH(s, from, lc), lo = LowestL(s, from, lc);
      double bin = MathMax(a * 0.1, (hi - lo) / 60);
      if(bin > 0 && hi > lo)
        {
         int nb = (int)MathCeil((hi - lo) / bin) + 1;
         if(nb > 200) nb = 200;
         double prof[]; ArrayResize(prof, nb); ArrayInitialize(prof, 0);
         for(int i = from; i <= lc; i++)
           {
            int b0 = (int)((s.l[i] - lo) / bin), b1 = (int)((s.h[i] - lo) / bin);
            b0 = MathMax(0, MathMin(nb - 1, b0)); b1 = MathMax(0, MathMin(nb - 1, b1));
            double share = vv[i] / (b1 - b0 + 1);
            for(int b = b0; b <= b1; b++) prof[b] += share;
           }
         int poc = 0; double tot = 0;
         for(int b = 0; b < nb; b++) { tot += prof[b]; if(prof[b] > prof[poc]) poc = b; }
         int lo_b = poc, hi_b = poc; double acc = prof[poc];
         while(acc < 0.7 * tot && (lo_b > 0 || hi_b < nb - 1))
           {
            double dn = lo_b > 0 ? prof[lo_b - 1] : -1, up = hi_b < nb - 1 ? prof[hi_b + 1] : -1;
            if(up >= dn) { hi_b++; acc += prof[hi_b]; } else { lo_b--; acc += prof[lo_b]; }
           }
         A_Push(f, Jr("tick_profile", Obj(Jn("poc", lo + (poc + 0.5) * bin, s.digits) + "," + Jn("value_area_high", lo + (hi_b + 1) * bin, s.digits) + "," +
                                          Jn("value_area_low", lo + lo_b * bin, s.digits) + "," + J("basis", "tick count at price, not traded volume"))));
        }
     }
   return Obj(A_Join(f));
  }

//+------------------------------------------------------------------+
//| 10. get_levels                                                    |
//+------------------------------------------------------------------+
string g_lvSrc[]; double g_lvPx[];
void AddLv(double px, string src) { if(px <= 0) return; int n = ArraySize(g_lvPx); ArrayResize(g_lvPx, n + 1); ArrayResize(g_lvSrc, n + 1); g_lvPx[n] = px; g_lvSrc[n] = src; }

string PivotJson(CSlot *ref, string name, int digits)
  {
   if(ref == NULL || ref.n < 2) return Jwhy(name, "that timeframe is not loaded yet");
   int i = ref.n - 2;
   double H = ref.h[i], L = ref.l[i], C = ref.c[i], P = (H + L + C) / 3;
   return Jr(name, Obj(Jn("p", P, digits) + "," + Jn("r1", 2 * P - L, digits) + "," + Jn("s1", 2 * P - H, digits) + "," +
                       Jn("r2", P + (H - L), digits) + "," + Jn("s2", P - (H - L), digits) + "," + Jn("r3", H + 2 * (P - L), digits) + "," + Jn("s3", L - 2 * (H - P), digits)));
  }

string C_Levels(CSlot *s)
  {
   int lc = s.lc; double px = s.c[lc], a = Atr(s);
   ArrayFree(g_lvSrc); ArrayFree(g_lvPx);
   string f[];
   A_Push(f, J("rules", "pivots from the previous CLOSED D1/W1/MN1 candle; fib on the last confirmed external leg; ladder merges levels within 0.25 ATR"));
   CSlot *d1 = GetSlot(s.sym, PERIOD_D1, 0);
   CSlot *w1 = GetSlot(s.sym, PERIOD_W1, 0);
   CSlot *mn = GetSlot(s.sym, PERIOD_MN1, 0);
   A_Push(f, PivotJson(d1, "pivots_daily", s.digits)); A_Push(f, PivotJson(w1, "pivots_weekly", s.digits)); A_Push(f, PivotJson(mn, "pivots_monthly", s.digits));
   if(d1 != NULL && d1.n >= 2)
     {
      int i = d1.n - 2; double H = d1.h[i], L = d1.l[i], C = d1.c[i], R = H - L;
      A_Push(f, Jr("camarilla_daily", Obj(Jn("r1", C + R * 1.1 / 12, s.digits) + "," + Jn("r2", C + R * 1.1 / 6, s.digits) + "," + Jn("r3", C + R * 1.1 / 4, s.digits) + "," + Jn("r4", C + R * 1.1 / 2, s.digits) + "," +
                                          Jn("s1", C - R * 1.1 / 12, s.digits) + "," + Jn("s2", C - R * 1.1 / 6, s.digits) + "," + Jn("s3", C - R * 1.1 / 4, s.digits) + "," + Jn("s4", C - R * 1.1 / 2, s.digits))));
      double P = (H + L + C) / 3;
      AddLv(P, "daily pivot"); AddLv(2 * P - L, "R1"); AddLv(2 * P - H, "S1"); AddLv(P + R, "R2"); AddLv(P - R, "S2");
      AddLv(H, "previous day high"); AddLv(L, "previous day low");
     }
   if(w1 != NULL && w1.n >= 2) { AddLv(w1.h[w1.n - 2], "previous week high"); AddLv(w1.l[w1.n - 2], "previous week low"); }
   // round numbers
   double step;
   if(!IsSynthetic(s.sym)) step = s.digits == 3 || s.digits == 2 ? 0.5 : 0.005;
   else step = MathPow(10, MathFloor(MathLog10(MathMax(px, 1e-9))) - 2);
   if(step <= 0) step = s.pip * 50;
   double base = MathFloor(px / step) * step;
   string rn[];
   for(int k = -2; k <= 3; k++) { double lv = base + k * step; A_Push(rn, DoubleToString(lv, s.digits)); AddLv(lv, "round number"); }
   A_Push(f, Jr("round_numbers", Obj(Jn("step", step, s.digits) + "," + Jr("levels", "[" + A_Join(rn) + "]"))));
   // fibonacci on the last external leg
   int ne = ArraySize(s.exI);
   if(ne >= 2 && s.exK[ne - 1] != s.exK[ne - 2])
     {
      double p0 = s.exP[ne - 2], p1 = s.exP[ne - 1], rngL = p1 - p0;
      double rr[] = {0.236, 0.382, 0.5, 0.618, 0.786};
      double ex[] = {1.27, 1.618};
      string fr[];
      for(int k = 0; k < 5; k++) { double lv = p1 - rngL * rr[k]; A_Push(fr, Jn(StringFormat("r%.1f", rr[k] * 100), lv, s.digits)); AddLv(lv, StringFormat("fib %.1f", rr[k] * 100)); }
      for(int k = 0; k < 2; k++) { double lv = p0 + rngL * ex[k]; A_Push(fr, Jn(StringFormat("e%.1f", ex[k] * 100), lv, s.digits)); }
      A_Push(f, Jr("fibonacci", Obj(Jn("anchor_from", p0, s.digits) + "," + Jn("anchor_to", p1, s.digits) + "," + J("leg", rngL > 0 ? "up" : "down") + "," + A_Join(fr))));
     }
   // ladder: cluster within 0.25 ATR, 3 nearest above and below
   int nl = ArraySize(g_lvPx);
   bool used[]; ArrayResize(used, nl);
   for(int i = 0; i < nl; i++) used[i] = false;
   string above[], below[];
   double cpx[]; string csrc[]; int ccnt[];
   for(int i = 0; i < nl; i++)
     {
      if(used[i]) continue;
      double sum = g_lvPx[i]; int cnt = 1; string src = g_lvSrc[i]; used[i] = true;
      for(int j = i + 1; j < nl; j++) if(!used[j] && MathAbs(g_lvPx[j] - g_lvPx[i]) <= 0.25 * a) { used[j] = true; sum += g_lvPx[j]; cnt++; if(StringFind(src, g_lvSrc[j]) < 0) src += " + " + g_lvSrc[j]; }
      int m = ArraySize(cpx); ArrayResize(cpx, m + 1); ArrayResize(csrc, m + 1); ArrayResize(ccnt, m + 1);
      cpx[m] = sum / cnt; csrc[m] = src; ccnt[m] = cnt;
     }
   for(int pass = 0; pass < 2; pass++)
     {
      for(int t = 0; t < 3; t++)
        {
         int best = -1; double bd = DBL_MAX;
         for(int m = 0; m < ArraySize(cpx); m++)
           {
            double d = pass == 0 ? cpx[m] - px : px - cpx[m];
            if(d <= 0 || d >= bd) continue;
            bd = d; best = m;
           }
         if(best < 0) break;
         string row = Obj(Lv(s, cpx[best], px) + "," + Js("what", csrc[best]) + "," + Ji("count", ccnt[best]));
         if(pass == 0) A_Push(above, row); else A_Push(below, row);
         cpx[best] = pass == 0 ? -DBL_MAX : DBL_MAX; // used
        }
     }
   A_Push(f, Jr("ladder_above", Arr(above)));
   A_Push(f, Jr("ladder_below", Arr(below)));
   // APA flip levels (H4 and above): a level touched by MORE THAN 2 swing points, then closed through
   bool h4plus = PeriodSeconds(s.tf) >= PeriodSeconds(PERIOD_H4);
   string flips[];
   int ns = ArraySize(s.swI);
   if(h4plus)
     {
      for(int k = ns - 1; k >= 0 && ArraySize(flips) < 3; k--)
        {
         int touches = 0, lastTouch = s.swI[k];
         for(int q = 0; q < ns; q++) if(MathAbs(s.swP[q] - s.swP[k]) <= 0.1 * a) { touches++; lastTouch = MathMax(lastTouch, s.swI[q]); }
         if(touches <= 2) continue;
         double lvl = s.swP[k];
         int broke = -1, dir = 0;
         for(int j = lastTouch + 1; j <= lc; j++)
           {
            if(s.c[j] > lvl + 0.1 * a) { broke = j; dir = 1; break; }
            if(s.c[j] < lvl - 0.1 * a) { broke = j; dir = -1; break; }
           }
         string row = Lv(s, lvl, px) + "," + Ji("touches", touches) + "," + J("tf", TfName(s.tf)) + "," + Jb("flip_confirmed", broke >= 0);
         if(broke >= 0)
            row += "," + Ji("broken_bars_ago", Ago(s, broke)) + "," + J("now_acts_as", dir > 0 ? "support" : "resistance") + "," +
                   Jr("single_candle_structure", Obj(Jn("high", s.h[broke - 1], s.digits) + "," + Jn("low", s.l[broke - 1], s.digits) + "," + J("time", BarIso(s, broke - 1))));
         bool dupe = false;
         for(int q = 0; q < ArraySize(flips); q++) if(StringFind(flips[q], DoubleToString(lvl, s.digits)) >= 0) dupe = true;
         if(!dupe) A_Push(flips, Obj(row));
        }
     }
   A_Push(f, h4plus ? Jr("apa_flip_levels", Arr(flips)) : Jwhy("apa_flip_levels", "flip levels are read on H4 and above only (APA)"));
   // APA flip entry type 2: flip zone (touch or near-touch with reaction) + multiple candle structure + breakout + return + higher-tf wick overlap
   string ft2 = "null";
   for(int k = ns - 1; k >= 0 && ft2 == "null"; k--)
     {
      double lvl = s.swP[k];
      int reacts = 0, lastI = 0;
      for(int q = 0; q < ns; q++)
        {
         if(MathAbs(s.swP[q] - lvl) > 0.25 * a) continue;
         int i = s.swI[q];
         double away = s.swK[q] == 1 ? s.swP[q] - LowestL(s, i, MathMin(lc, i + 10)) : HighestH(s, i, MathMin(lc, i + 10)) - s.swP[q];
         if(away >= a) { reacts++; lastI = MathMax(lastI, i); }
        }
      if(reacts < 3) continue;
      // breakout candle after the last reaction
      int bo = -1, dir = 0;
      for(int j = lastI + 3; j <= lc; j++)
        {
         if(s.c[j] > lvl + 0.1 * a && s.c[j - 1] <= lvl + 0.1 * a) { bo = j; dir = 1; break; }
         if(s.c[j] < lvl - 0.1 * a && s.c[j - 1] >= lvl - 0.1 * a) { bo = j; dir = -1; break; }
        }
      if(bo < 4) continue;
      double bh = HighestH(s, bo - 3, bo - 1), bl = LowestL(s, bo - 3, bo - 1);
      bool base = bh - bl <= 1.5 * a && (dir > 0 ? bh <= lvl + 0.5 * a : bl >= lvl - 0.5 * a);
      if(!base) continue;
      bool returned = false; int retAt = -1;
      for(int j = bo + 1; j <= lc; j++) if(dir > 0 ? s.l[j] <= bh : s.h[j] >= bl) { returned = true; retAt = j; break; }
      // one higher timeframe: same-colour candles whose wicks overlap at the base
      int wol = -1;
      CSlot *hs = GetSlot(s.sym, HigherTf(s.tf), 0);
      if(hs != NULL)
        {
         wol = 0;
         for(int i = MathMax(1, hs.lc - 20); i <= hs.lc; i++)
           {
            bool g1 = hs.c[i - 1] > hs.o[i - 1], g2 = hs.c[i] > hs.o[i], r1 = hs.c[i - 1] < hs.o[i - 1], r2 = hs.c[i] < hs.o[i];
            double olo = 0, ohi = 0;
            if(g1 && g2 && MathMin(hs.o[i], hs.c[i]) > MathMax(hs.o[i - 1], hs.c[i - 1]) && hs.l[i] < hs.h[i - 1]) { olo = hs.l[i]; ohi = hs.h[i - 1]; }
            if(r1 && r2 && MathMax(hs.o[i], hs.c[i]) < MathMin(hs.o[i - 1], hs.c[i - 1]) && hs.h[i] > hs.l[i - 1]) { olo = hs.l[i - 1]; ohi = hs.h[i]; }
            if(ohi > olo && olo <= bh && ohi >= bl) { wol = 1; break; }
           }
        }
      ft2 = Obj(Jr("flip_zone", Obj(Lv(s, lvl, px) + "," + Ji("reactions", reacts))) + "," +
                Jr("multiple_candle_structure", Obj(Jn("high", bh, s.digits) + "," + Jn("low", bl, s.digits) + "," + Ji("candles", 3))) + "," +
                Jr("breakout", Obj(J("dir", dir > 0 ? "up" : "down") + "," + Ji("bars_ago", Ago(s, bo)))) + "," +
                Jb("returned_into_structure", returned) + (retAt >= 0 ? "," + Ji("returned_bars_ago", Ago(s, retAt)) : "") + "," +
                (wol < 0 ? Jnull("higher_tf_wick_overlap") : Jb("higher_tf_wick_overlap", wol == 1)));
     }
   A_Push(f, Jr("apa_flip_entry_type2", ft2));
   return Obj(A_Join(f));
  }

//+------------------------------------------------------------------+
//| 14. get_chart_patterns (external swings only, max 2)              |
//+------------------------------------------------------------------+
string C_ChartPatterns(CSlot *s)
  {
   int lc = s.lc, ne = ArraySize(s.exI); double a = Atr(s), px = s.c[lc];
   string out[];
   // double top / bottom
   for(int kind = 1; kind >= -1 && ArraySize(out) < 2; kind -= 2)
     {
      int k2 = -1, k1 = -1;
      for(int k = ne - 1; k >= 0; k--) if(s.exK[k] == kind) { if(k2 < 0) k2 = k; else { k1 = k; break; } }
      if(k1 < 0 || MathAbs(s.exP[k2] - s.exP[k1]) > 0.25 * a) continue;
      double neck = kind == 1 ? LowestL(s, s.exI[k1], s.exI[k2]) : HighestH(s, s.exI[k1], s.exI[k2]);
      int broke = -1;
      for(int j = s.exI[k2] + 1; j <= lc; j++) if(kind == 1 ? s.c[j] < neck : s.c[j] > neck) { broke = j; break; }
      double height = MathAbs((s.exP[k1] + s.exP[k2]) / 2 - neck);
      A_Push(out, Obj(J("name", kind == 1 ? "double top" : "double bottom") + "," + Jn("peak_1", s.exP[k1], s.digits) + "," + Jn("peak_2", s.exP[k2], s.digits) + "," +
                      Jn("neckline", neck, s.digits) + "," + Jn("height", height, s.digits) + "," + J("status", broke >= 0 ? "broken" : "forming") + "," +
                      (broke >= 0 ? Ji("broken_bars_ago", Ago(s, broke)) : Jnull("broken_bars_ago")) + "," +
                      Jn("measured_target", kind == 1 ? neck - height : neck + height, s.digits)));
     }
   // head and shoulders (last 3 external highs / lows)
   for(int kind = 1; kind >= -1 && ArraySize(out) < 2; kind -= 2)
     {
      int ks[3]; int got = 0;
      for(int k = ne - 1; k >= 0 && got < 3; k--) if(s.exK[k] == kind) ks[2 - got++] = k;
      if(got < 3) continue;
      double ls = s.exP[ks[0]], hd = s.exP[ks[1]], rs = s.exP[ks[2]];
      bool ok = kind == 1 ? (hd > ls && hd > rs) : (hd < ls && hd < rs);
      if(!ok || MathAbs(ls - rs) > 0.5 * a) continue;
      double n1 = kind == 1 ? LowestL(s, s.exI[ks[0]], s.exI[ks[1]]) : HighestH(s, s.exI[ks[0]], s.exI[ks[1]]);
      double n2 = kind == 1 ? LowestL(s, s.exI[ks[1]], s.exI[ks[2]]) : HighestH(s, s.exI[ks[1]], s.exI[ks[2]]);
      double neck = (n1 + n2) / 2;
      int broke = -1;
      for(int j = s.exI[ks[2]] + 1; j <= lc; j++) if(kind == 1 ? s.c[j] < neck : s.c[j] > neck) { broke = j; break; }
      double height = MathAbs(hd - neck);
      A_Push(out, Obj(J("name", kind == 1 ? "head and shoulders" : "inverse head and shoulders") + "," + Jn("left_shoulder", ls, s.digits) + "," + Jn("head", hd, s.digits) + "," +
                      Jn("right_shoulder", rs, s.digits) + "," + Jn("neckline", neck, s.digits) + "," + Jn("height", height, s.digits) + "," +
                      J("status", broke >= 0 ? "broken" : "forming") + "," + (broke >= 0 ? Ji("broken_bars_ago", Ago(s, broke)) : Jnull("broken_bars_ago")) + "," +
                      Jn("measured_target", kind == 1 ? neck - height : neck + height, s.digits)));
     }
   // triangle / wedge from the last 3 highs and 3 lows
   if(ArraySize(out) < 2)
     {
      int hi[3], lo[3]; int gh = 0, gl = 0;
      for(int k = ne - 1; k >= 0 && (gh < 3 || gl < 3); k--)
        {
         if(s.exK[k] == 1 && gh < 3) hi[2 - gh++] = k;
         if(s.exK[k] == -1 && gl < 3) lo[2 - gl++] = k;
        }
      if(gh == 3 && gl == 3)
        {
         double sh = (s.exP[hi[2]] - s.exP[hi[0]]) / MathMax(1, s.exI[hi[2]] - s.exI[hi[0]]);
         double sl = (s.exP[lo[2]] - s.exP[lo[0]]) / MathMax(1, s.exI[lo[2]] - s.exI[lo[0]]);
         double w0 = s.exP[hi[0]] - s.exP[lo[0]], w2 = s.exP[hi[2]] - s.exP[lo[2]];
         if(w2 < w0 * 0.8)
           {
            string name = (sh < 0 && sl > 0) ? "symmetrical triangle" : (MathAbs(sh) < 0.05 * a && sl > 0) ? "ascending triangle" :
                          (MathAbs(sl) < 0.05 * a && sh < 0) ? "descending triangle" : (sh > 0 && sl > 0) ? "rising wedge" : (sh < 0 && sl < 0) ? "falling wedge" : "";
            if(name != "")
              {
               double upNow = s.exP[hi[2]] + sh * (lc - s.exI[hi[2]]), dnNow = s.exP[lo[2]] + sl * (lc - s.exI[lo[2]]);
               string st = px > upNow ? "broken up" : px < dnNow ? "broken down" : "forming";
               A_Push(out, Obj(J("name", name) + "," + Jn("upper_line_now", upNow, s.digits) + "," + Jn("lower_line_now", dnNow, s.digits) + "," +
                               Jn("height", w0, s.digits) + "," + J("status", st)));
              }
           }
        }
     }
   // harmonics (H1 and above, completed only)
   if(ArraySize(out) < 2 && PeriodSeconds(s.tf) >= 3600 && ne >= 5)
     {
      bool alt = true;
      for(int k = ne - 4; k < ne; k++) if(s.exK[k] == s.exK[k - 1]) alt = false;
      if(alt)
        {
         double X = s.exP[ne - 5], A = s.exP[ne - 4], B = s.exP[ne - 3], C = s.exP[ne - 2], D = s.exP[ne - 1];
         double XA = MathAbs(A - X), AB = MathAbs(B - A), BC = MathAbs(C - B), CD = MathAbs(D - C), AD = MathAbs(D - A);
         if(XA > 0 && AB > 0 && BC > 0)
           {
            double ab = AB / XA, ad = AD / XA, bc = BC / AB, cd = CD / BC;
            string nm = ""; double err = 0;
            if(MathAbs(ab - 0.618) <= 0.05 && MathAbs(ad - 0.786) <= 0.05) { nm = "gartley"; err = MathAbs(ab - 0.618) + MathAbs(ad - 0.786); }
            else if(ab >= 0.382 && ab <= 0.5 && MathAbs(ad - 0.886) <= 0.05) { nm = "bat"; err = MathAbs(ad - 0.886); }
            else if(MathAbs(ab - 0.786) <= 0.05 && ad >= 1.27 && ad <= 1.618) { nm = "butterfly"; err = MathAbs(ab - 0.786); }
            else if(ab >= 0.382 && ab <= 0.618 && MathAbs(ad - 1.618) <= 0.08) { nm = "crab"; err = MathAbs(ad - 1.618); }
            if(nm != "")
               A_Push(out, Obj(J("name", nm + (D < C ? " (bullish)" : " (bearish)")) + "," + Jn("x", X, s.digits) + "," + Jn("a", A, s.digits) + "," + Jn("b", B, s.digits) + "," +
                               Jn("c", C, s.digits) + "," + Jn("d", D, s.digits) + "," + Jn("ab_xa", ab, 3) + "," + Jn("bc_ab", bc, 3) + "," + Jn("cd_bc", cd, 3) + "," +
                               Jn("ad_xa", ad, 3) + "," + Jn("ratio_error", err, 3) + "," + J("status", "completed")));
           }
        }
     }
   return Obj(J("rules", "external swings (fractal 5/5) only; double top/bottom peaks within 0.25 ATR; H&S shoulders within 0.5 ATR; broken = CLOSE through the neckline; harmonics H1+ completed only") + "," +
              Jr("patterns", Arr(out)));
  }

//+------------------------------------------------------------------+
//| 1. get_price (live part every request + day/week/month levels)    |
//+------------------------------------------------------------------+
double g_sprBuf[]; string g_sprSym = "";
string C_Price(string sym)
  {
   MqlTick tk; SymbolInfoTick(sym, tk);
   int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double pt = SymbolInfoDouble(sym, SYMBOL_POINT), pip = PipOf(sym);
   double spr = tk.ask - tk.bid;
   long qAge = tk.time > 0 ? (long)TimeTradeServer() - (long)tk.time : -1;
   // normal spread = median over the recent ticks in MT5's memory
   MqlTick tt[];
   int got = SymbolIsSynchronized(sym) ? CopyTicks(sym, tt, COPY_TICKS_INFO, 0, 500) : 0;
   double sp[]; ArrayResize(sp, got);
   for(int i = 0; i < got; i++) sp[i] = tt[i].ask - tt[i].bid;
   ArraySort(sp);
   double med = got > 0 ? sp[got / 2] : spr;
   bool open = MarketOpenNow(sym);
   string f[];
   A_Push(f, Jn("bid", tk.bid, dg)); A_Push(f, Jn("ask", tk.ask, dg)); A_Push(f, Jn("mid", (tk.bid + tk.ask) / 2, dg));
   A_Push(f, Jr("spread", Obj(Jn("now_points", pt > 0 ? spr / pt : 0, 0) + "," + Jn("now_pips", spr / pip, 2) + "," + Jn("normal_points", pt > 0 ? med / pt : 0, 0) + "," +
                              Jn("vs_normal", med > 0 ? spr / med : 1, 2) + "," + Ji("ticks_used", got))));
   A_Push(f, J("quote_time_utc", SrvToIso((datetime)tk.time))); A_Push(f, Ji("quote_age_sec", qAge));
   A_Push(f, Jb("market_open", open));
   A_Push(f, Jb("feed_frozen", open && qAge > 60));
   double chg = SymbolInfoDouble(sym, SYMBOL_PRICE_CHANGE);
   CSlot *d1 = GetSlot(sym, PERIOD_D1, 0);
   CSlot *w1 = GetSlot(sym, PERIOD_W1, 0);
   CSlot *mn = GetSlot(sym, PERIOD_MN1, 0);
   if(d1 != NULL && d1.n >= 16)
     {
      int t = d1.n - 1, y = d1.n - 2;
      if(chg == 0 && d1.c[y] > 0) chg = (tk.bid - d1.c[y]) / d1.c[y] * 100;
      A_Push(f, Jr("today", Obj(Jn("open", d1.o[t], dg) + "," + Jn("high", MathMax(d1.h[t], tk.bid), dg) + "," + Jn("low", MathMin(d1.l[t], tk.bid), dg) + "," +
                                Jn("position_pct", d1.h[t] > d1.l[t] ? (tk.bid - d1.l[t]) / (d1.h[t] - d1.l[t]) * 100 : 50, 0))));
      A_Push(f, Jr("yesterday", Obj(Jn("pdo", d1.o[y], dg) + "," + Jn("pdh", d1.h[y], dg) + "," + Jn("pdl", d1.l[y], dg) + "," + Jn("pdc", d1.c[y], dg))));
      // ADR 14: closed days, skipping Sunday stubs (< 20% of the median range)
      double rg[]; int m = 0;
      for(int i = y; i >= 1 && i > y - 20; i--) { ArrayResize(rg, m + 1); rg[m++] = d1.h[i] - d1.l[i]; }
      double srt[]; ArrayCopy(srt, rg); ArraySort(srt);
      double medR = m > 0 ? srt[m / 2] : 0, sum = 0; int cnt = 0;
      for(int i = 0; i < m && cnt < 14; i++) if(rg[i] >= 0.2 * medR) { sum += rg[i]; cnt++; }
      double adr = cnt > 0 ? sum / cnt : 0;
      A_Push(f, Jr("adr14", Obj(Jn("price", adr, dg) + "," + Jn("pips", adr / pip, 1) + "," + Jn("today_used_pct", adr > 0 ? (d1.h[t] - d1.l[t]) / adr * 100 : 0, 0))));
     }
   else A_Push(f, Jwhy("today", "daily candles not loaded yet"));
   A_Push(f, Jn("change_vs_prev_close_pct", chg, 3));
   if(w1 != NULL && w1.n >= 2)
      A_Push(f, Jr("week", Obj(Jn("high", w1.h[w1.n - 1], dg) + "," + Jn("low", w1.l[w1.n - 1], dg) + "," + Jn("pwh", w1.h[w1.n - 2], dg) + "," + Jn("pwl", w1.l[w1.n - 2], dg) + "," +
                               Jn("position_pct", w1.h[w1.n - 1] > w1.l[w1.n - 1] ? (tk.bid - w1.l[w1.n - 1]) / (w1.h[w1.n - 1] - w1.l[w1.n - 1]) * 100 : 50, 0))));
   if(mn != NULL && mn.n >= 2)
      A_Push(f, Jr("month", Obj(Jn("high", mn.h[mn.n - 1], dg) + "," + Jn("low", mn.l[mn.n - 1], dg) + "," + Jn("prev_high", mn.h[mn.n - 2], dg) + "," + Jn("prev_low", mn.l[mn.n - 2], dg))));
   if(w1 != NULL && w1.n >= 53 && !IsSynthetic(sym))
      A_Push(f, Jr("week52", Obj(Jn("high", HighestH(w1, w1.n - 52, w1.n - 1), dg) + "," + Jn("low", LowestL(w1, w1.n - 52, w1.n - 1), dg))));
   else if(IsSynthetic(sym)) A_Push(f, Jwhy("week52", "synthetic index: generated price, a 52-week range means nothing"));
   CSlot *m15 = GetSlot(sym, PERIOD_M15, 0);
   CSlot *h1 = GetSlot(sym, PERIOD_H1, 0);
   A_Push(f, Jr("spread_vs_atr", Obj((m15 != NULL ? Jn("m15", Atr(m15) > 0 ? spr / Atr(m15) : 0, 3) : Jnull("m15")) + "," + (h1 != NULL ? Jn("h1", Atr(h1) > 0 ? spr / Atr(h1) : 0, 3) : Jnull("h1")))));
   long stl = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL), frz = SymbolInfoInteger(sym, SYMBOL_TRADE_FREEZE_LEVEL);
   A_Push(f, Jr("broker_limits", Obj(Jn("stops_level_price", stl * pt, dg) + "," + Jn("freeze_level_price", frz * pt, dg) + "," +
                                     J("note", stl == 0 ? "stops level 0 = floating: keep stops at least 3 x spread away" : "SL/TP/pending must be at least this far from price"))));
   return Obj(A_Join(f));
  }

bool MarketOpenNow(string sym)
  {
   MqlDateTime sd; datetime nowSrv = TimeTradeServer(); TimeToStruct(nowSrv, sd);
   int secOfDay = sd.hour * 3600 + sd.min * 60 + sd.sec;
   bool any = false, inS = false;
   for(uint k = 0; k < 10; k++)
     {
      datetime from, to;
      if(!SymbolInfoSessionTrade(sym, (ENUM_DAY_OF_WEEK)sd.day_of_week, k, from, to)) break;
      any = true;
      int a = (int)from, b = (int)to;
      if(secOfDay >= a && secOfDay < (b == 0 ? 86400 : b)) inS = true;
     }
   long qAge = (long)nowSrv - SymbolInfoInteger(sym, SYMBOL_TIME);
   bool tradeable = SymbolInfoInteger(sym, SYMBOL_TRADE_MODE) != SYMBOL_TRADE_MODE_DISABLED;
   return tradeable && (!any || inS) && qAge < 600;
  }

//+------------------------------------------------------------------+
//| 11. get_session                                                   |
//+------------------------------------------------------------------+
bool WindowHL(CSlot *m, datetime fromUtc, datetime toUtc, double &hi, double &lo, double &op)
  {
   hi = 0; lo = 0; op = 0;
   if(m == NULL) return false;
   bool any = false;
   for(int i = 0; i < m.n; i++)
     {
      datetime u = (datetime)((long)m.t[i] - g_srvOffset);
      if(u < fromUtc || u >= toUtc) continue;
      if(!any) { hi = m.h[i]; lo = m.l[i]; op = m.o[i]; any = true; }
      else { hi = MathMax(hi, m.h[i]); lo = MathMin(lo, m.l[i]); }
     }
   return any;
  }
string WinJson(CSlot *m, string name, datetime fromUtc, datetime toUtc, int dg)
  {
   double hi, lo, op;
   if(!WindowHL(m, fromUtc, toUtc, hi, lo, op)) return Jnull(name);
   return Jr(name, Obj(Jn("high", hi, dg) + "," + Jn("low", lo, dg) + "," + Jn("open", op, dg) + "," + J("from_utc", IsoUtc(fromUtc)) + "," + J("to_utc", IsoUtc(toUtc))));
  }

string C_Session(string sym)
  {
   datetime now = TimeGMT();
   int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   MqlDateTime u; TimeToStruct(now, u);
   string f[];
   A_Push(f, J("utc_now", IsoUtc(now)));
   A_Push(f, J("london_time", HHMM(LocalMinuteOfDay(TZ_LONDON, now)))); A_Push(f, J("new_york_time", HHMM(LocalMinuteOfDay(TZ_NEWYORK, now))));
   A_Push(f, J("dst_rule", "UK: last Sunday March - last Sunday October; US: 2nd Sunday March - 1st Sunday November"));
   if(Is247(sym))
     {
      A_Push(f, J("sessions", "24/7 -- no forex sessions for this symbol"));
      A_Push(f, Ji("minutes_to_utc_midnight", 1440 - (u.hour * 60 + u.min)));
      return Obj(A_Join(f));
     }
   int lon = LocalMinuteOfDay(TZ_LONDON, now), ny = LocalMinuteOfDay(TZ_NEWYORK, now), tky = LocalMinuteOfDay(TZ_TOKYO, now), syd = LocalMinuteOfDay(TZ_SYDNEY, now);
   bool sydO = syd >= 7 * 60 && syd < 16 * 60, tkyO = tky >= 9 * 60 && tky < 18 * 60, lonO = lon >= 8 * 60 && lon < 17 * 60, nyO = ny >= 8 * 60 && ny < 17 * 60;
   string open = "";
   if(sydO) open += "Sydney ";
   if(tkyO) open += "Tokyo ";
   if(lonO) open += "London ";
   if(nyO) open += "New York ";
   StringTrimRight(open);
   A_Push(f, J("open_now", open == "" ? "none" : open));
   A_Push(f, Jb("london_new_york_overlap", lonO && nyO));
   A_Push(f, Ji("minutes_to_london_open", lon < 480 ? 480 - lon : 1440 - lon + 480));
   A_Push(f, Ji("minutes_to_new_york_open", ny < 480 ? 480 - ny : 1440 - ny + 480));
   A_Push(f, Ji("minutes_to_tokyo_open", tky < 540 ? 540 - tky : 1440 - tky + 540));
   bool kzL = ny >= 120 && ny < 300, kzN = ny >= 420 && ny < 600, sb = ny >= 600 && ny < 660;
   A_Push(f, Jr("killzones_ny_time", Obj(Jb("london_02_05", kzL) + "," + Jb("new_york_am_07_10", kzN) + "," + Jb("silver_bullet_10_11", sb) + "," + Jb("in_killzone", kzL || kzN))));
   CSlot *m5 = GetSlot(sym, PERIOD_M5, 0);
   if(m5 == NULL) { A_Push(f, Jwhy("ranges", "M5 candles not loaded yet")); return Obj(A_Join(f)); }
   // Asian range 19:00-00:00 NY (the evening before today's NY date)
   datetime asiaFrom = UtcOfLocal(TZ_NEWYORK, now, 19, 0, ny >= 19 * 60 ? 0 : -1), asiaTo = asiaFrom + 5 * 3600;
   A_Push(f, WinJson(m5, "asian_range", asiaFrom, asiaTo, dg));
   datetime lonOpen = UtcOfLocal(TZ_LONDON, now, 8, 0, 0), nyOpen = UtcOfLocal(TZ_NEWYORK, now, 9, 30, 0);
   A_Push(f, WinJson(m5, "london_opening_range_30m", lonOpen, lonOpen + 1800, dg));
   A_Push(f, WinJson(m5, "london_opening_range_60m", lonOpen, lonOpen + 3600, dg));
   A_Push(f, WinJson(m5, "new_york_opening_range_30m", nyOpen, nyOpen + 1800, dg));
   A_Push(f, WinJson(m5, "new_york_opening_range_60m", nyOpen, nyOpen + 3600, dg));
   for(int d = 0; d >= -1; d--)
     {
      string tag = d == 0 ? "today" : "yesterday";
      datetime lf = UtcOfLocal(TZ_LONDON, now, 8, 0, d), nf = UtcOfLocal(TZ_NEWYORK, now, 8, 0, d);
      datetime af = UtcOfLocal(TZ_NEWYORK, now, 19, 0, d - 1);
      A_Push(f, WinJson(m5, "asia_" + tag, af, af + 5 * 3600, dg));
      A_Push(f, WinJson(m5, "london_" + tag, lf, lf + 9 * 3600, dg));
      A_Push(f, WinJson(m5, "new_york_" + tag, nf, nf + 9 * 3600, dg));
     }
   double ah, al, ao, lh, ll, lo2;
   bool asiaOk = WindowHL(m5, asiaFrom, asiaTo, ah, al, ao);
   bool lonOk = WindowHL(m5, lonOpen, lonOpen + 9 * 3600, lh, ll, lo2);
   if(asiaOk && lonOk)
     {
      A_Push(f, Jb("london_swept_asia_high", lh > ah)); A_Push(f, Jb("london_swept_asia_low", ll < al));
      // Judas: one side of Asia swept, then price back beyond the London open on the other side
      double bid = SymbolInfoDouble(sym, SYMBOL_BID);
      A_Push(f, Jb("judas_swing", (lh > ah && bid < lo2) || (ll < al && bid > lo2)));
     }
   datetime midnight = UtcOfLocal(TZ_NEWYORK, now, 0, 0, 0);
   double mh, ml, mo;
   if(WindowHL(m5, midnight, midnight + 300, mh, ml, mo)) A_Push(f, Jn("midnight_open_ny", mo, dg));
   if(WindowHL(m5, lonOpen, lonOpen + 300, mh, ml, mo)) A_Push(f, Jn("london_open_price", mo, dg));
   if(WindowHL(m5, nyOpen, nyOpen + 300, mh, ml, mo)) A_Push(f, Jn("new_york_open_price", mo, dg));
   datetime cb = UtcOfLocal(TZ_NEWYORK, now, 14, 0, ny >= 20 * 60 ? 0 : -1);
   A_Push(f, WinJson(m5, "cbdr_14_20_ny", cb, cb + 6 * 3600, dg));
   // holiday today, rollover, calendar flags
   A_Push(f, Jb("bank_holiday_today", HolidayToday(sym)));
   MqlDateTime sd; TimeToStruct(TimeTradeServer(), sd);
   A_Push(f, Ji("minutes_to_rollover_server_midnight", 1440 - (sd.hour * 60 + sd.min)));
   int dim = DaysInMonth(u.year, u.mon), wdLeft = 0;
   for(int d = u.day + 1; d <= dim; d++) { int w = DowOf(u.year, u.mon, d); if(w != 0 && w != 6) wdLeft++; }
   A_Push(f, Jb("month_end_window", wdLeft <= 1));
   A_Push(f, Jb("friday_late", u.day_of_week == 5 && u.hour >= 18));
   A_Push(f, Jb("sunday_monday_open", (u.day_of_week == 0 && u.hour >= 21) || (u.day_of_week == 1 && u.hour < 1)));
   return Obj(A_Join(f));
  }

//+------------------------------------------------------------------+
//| 12. get_news (economic calendar, server time, cached 10 min)      |
//+------------------------------------------------------------------+
MqlCalendarValue g_calVals[];
datetime g_calAt = 0, g_calRetryAt = 0;
bool g_calOk = false;
bool CalendarSnapshot(datetime nowSrv, MqlCalendarValue &out[])
  {
   datetime nowLocal = TimeLocal();
   if((g_calAt == 0 || nowLocal - g_calAt > 600) && nowLocal >= g_calRetryAt)
     {
      uint started = GetTickCount();
      MqlCalendarValue fresh[];
      if(CalendarValueHistory(fresh, nowSrv - 30 * 3600, nowSrv + 36 * 3600, NULL, NULL))
        {
         ArrayFree(g_calVals);
         ArrayCopy(g_calVals, fresh);
         g_calOk = true;
         g_calAt = nowLocal;
        }
      if(GetTickCount() - started > 3000) g_calRetryAt = nowLocal + 3600;
      else if(!g_calOk) g_calRetryAt = nowLocal + 300;
     }
   ArrayFree(out);
   if(g_calOk) ArrayCopy(out, g_calVals);
   return g_calOk;
  }
void PairCurrencies(string sym, string &base, string &quote)
  {
   base = SymbolInfoString(sym, SYMBOL_CURRENCY_BASE); quote = SymbolInfoString(sym, SYMBOL_CURRENCY_PROFIT);
   if(base == "" || quote == "") { base = StringSubstr(sym, 0, 3); quote = StringSubstr(sym, 3, 3); }
   if(base == quote) base = "USD"; // gold / indices quoted in USD: USD news matters
  }
bool HolidayToday(string sym)
  {
   MqlCalendarValue vals[];
   datetime nowSrv = TimeTradeServer();
   if(!CalendarSnapshot(nowSrv, vals)) return false;
   string base, quote; PairCurrencies(sym, base, quote);
   MqlDateTime d; TimeToStruct(nowSrv, d);
   datetime day0 = nowSrv - (d.hour * 3600 + d.min * 60 + d.sec);
   for(int i = 0; i < ArraySize(vals); i++)
     {
      if(vals[i].time < day0 || vals[i].time >= day0 + 86400) continue;
      MqlCalendarEvent ev; if(!CalendarEventById(vals[i].event_id, ev)) continue;
      if(ev.type != CALENDAR_TYPE_HOLIDAY) continue;
      MqlCalendarCountry co; if(!CalendarCountryById(ev.country_id, co)) continue;
      if(co.currency == base || co.currency == quote) return true;
     }
   return false;
  }
string CalNum(string k, long raw)
  {
   if(raw == LONG_MIN) return Jnull(k);
   return Jn(k, (double)raw / 1000000.0, 4);
  }

string C_News(string sym)
  {
   if(IsSynthetic(sym)) return Obj(J("news", "not news-driven (synthetic index)"));
   MqlCalendarValue vals[];
   string base, quote; PairCurrencies(sym, base, quote);
   datetime nowSrv = TimeTradeServer();
   bool ok = CalendarSnapshot(nowSrv, vals);
   string f[];
   A_Push(f, Jb("calendar_available", ok));
   A_Push(f, J("currencies", base + "," + quote));
   if(!ok) return Obj(A_Join(f));
   string up[]; long nextHigh = -1; int blackout = 0;
   string lastRel[];
   for(int i = 0; i < ArraySize(vals); i++)
     {
      MqlCalendarEvent ev; if(!CalendarEventById(vals[i].event_id, ev)) continue;
      if(ev.importance == CALENDAR_IMPORTANCE_NONE || ev.type == CALENDAR_TYPE_HOLIDAY) continue;
      MqlCalendarCountry co; if(!CalendarCountryById(ev.country_id, co)) continue;
      if(co.currency != base && co.currency != quote) continue;
      long mins = (long)((vals[i].time - nowSrv) / 60);
      bool high = ev.importance == CALENDAR_IMPORTANCE_HIGH;
      string nm = ev.name;
      string nmL = nm; StringToLower(nmL);
      bool major = StringFind(nmL, "interest rate") >= 0 || StringFind(nmL, "nonfarm") >= 0 || StringFind(nmL, "non-farm") >= 0 || StringFind(nmL, "cpi") >= 0;
      int win = major ? 30 : 15;
      if(high && MathAbs(mins) <= win) blackout = MathMax(blackout, win);
      if(mins >= 0 && mins <= 1440 && ArraySize(up) < 12)
         A_Push(up, Obj(J("time_utc", SrvToIso(vals[i].time)) + "," + Ji("minutes_from_now", mins) + "," + J("currency", co.currency) + "," + Js("event", nm) + "," +
                        J("importance", high ? "high" : ev.importance == CALENDAR_IMPORTANCE_MODERATE ? "moderate" : "low")));
      if(high && mins >= 0 && (nextHigh < 0 || mins < nextHigh)) nextHigh = mins;
     }
   // latest released HIGH event per currency (scan newest first)
   for(int pass = 0; pass < 2; pass++)
     {
      string cur = pass == 0 ? base : quote;
      for(int i = ArraySize(vals) - 1; i >= 0; i--)
        {
         if(vals[i].time > nowSrv || vals[i].actual_value == LONG_MIN) continue;
         MqlCalendarEvent ev; if(!CalendarEventById(vals[i].event_id, ev)) continue;
         if(ev.importance != CALENDAR_IMPORTANCE_HIGH) continue;
         MqlCalendarCountry co; if(!CalendarCountryById(ev.country_id, co)) continue;
         if(co.currency != cur) continue;
         string row = J("currency", cur) + "," + Js("event", ev.name) + "," + J("time_utc", SrvToIso(vals[i].time)) + "," +
                      CalNum("actual", vals[i].actual_value) + "," + CalNum("forecast", vals[i].forecast_value) + "," +
                      CalNum("previous", vals[i].prev_value) + "," + CalNum("revised_previous", vals[i].revised_prev_value);
         if(vals[i].forecast_value != LONG_MIN)
           {
            double sur = (double)(vals[i].actual_value - vals[i].forecast_value) / 1000000.0;
            double fc = MathAbs((double)vals[i].forecast_value / 1000000.0);
            row += "," + Jn("surprise", sur, 4) + "," + (fc > 0 ? Jn("surprise_pct_of_forecast", sur / fc * 100, 1) : Jnull("surprise_pct_of_forecast"));
           }
         int imp = (int)vals[i].impact_type;
         row += "," + J("impact_for_currency", imp == 1 ? "positive" : imp == 2 ? "negative" : "n/a");
         // price reaction: move over the 15 M1 candles after the release, in M15 ATR
         CSlot *m1 = GetSlot(sym, PERIOD_M1, 0);
         CSlot *m15 = GetSlot(sym, PERIOD_M15, 0);
         if(m1 != NULL && m15 != NULL)
           {
            int k = -1;
            for(int q = 0; q < m1.n; q++) if(m1.t[q] >= vals[i].time) { k = q; break; }
            if(k >= 0 && k + 1 < m1.n)
              {
               int e = MathMin(m1.n - 1, k + 15);
               double mv = m1.c[e] - m1.o[k], at = Atr(m15);
               row += "," + Jn("reaction_15m_atr_m15", at > 0 ? mv / at : 0, 2);
              }
           }
         A_Push(lastRel, Obj(row));
         break;
        }
     }
   A_Push(f, Jr("upcoming_24h", Arr(up)));
   A_Push(f, nextHigh >= 0 ? Ji("minutes_to_next_high", nextHigh) : Jnull("minutes_to_next_high"));
   A_Push(f, Jb("blackout_now", blackout > 0));
   A_Push(f, J("blackout_rule", "+-15 min around a high-impact event, +-30 min for rate decisions / NFP / CPI"));
   A_Push(f, Jr("last_high_impact_release", Arr(lastRel)));
   A_Push(f, Ji("calendar_age_min", (long)(TimeLocal() - g_calAt) / 60));
   return Obj(A_Join(f));
  }

//+------------------------------------------------------------------+
//| 13. get_intermarket (recomputed once per H1 candle)               |
//+------------------------------------------------------------------+
string g_ccy[] = {"USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF"};
string g_imCache = ""; datetime g_imBar = 0; int g_imPairs = 0;
// % change of a cross over `bars` CLOSED H1 candles (false = not loaded)
bool PairChange(string base, int bars, double &chg)
  {
   chg = 0;
   string nm = ResolvedName(base);
   if(nm == "" || !SeriesReady(nm, PERIOD_H1)) return false;
   double c[];
   if(CopyClose(nm, PERIOD_H1, 1, bars + 1, c) != bars + 1 || c[0] <= 0) return false;
   chg = (c[bars] - c[0]) / c[0] * 100;
   return true;
  }
double Corr(const double &x[], const double &y[], int n)
  {
   if(n < 5) return 0;
   double mx = 0, my = 0;
   for(int i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
   mx /= n; my /= n;
   double sxy = 0, sxx = 0, syy = 0;
   for(int i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) * (x[i] - mx); syy += (y[i] - my) * (y[i] - my); }
   return sxx > 0 && syy > 0 ? sxy / MathSqrt(sxx * syy) : 0;
  }
// log returns of two symbols aligned on candle time (H1, last `n`+1 closed candles)
bool AlignedReturns(string a, string b, int n, double &ra[], double &rb[], int &m)
  {
   m = 0;
   if(!SeriesReady(a, PERIOD_H1) || !SeriesReady(b, PERIOD_H1)) return false;
   MqlRates x[], y[];
   int gx = CopyRates(a, PERIOD_H1, 1, n + 40, x), gy = CopyRates(b, PERIOD_H1, 1, n + 40, y);
   if(gx < 10 || gy < 10) return false;
   ArrayResize(ra, gx); ArrayResize(rb, gx);
   int j = 0;
   for(int i = 1; i < gx; i++)
     {
      while(j < gy && y[j].time < x[i].time) j++;
      if(j >= gy || j < 1 || y[j].time != x[i].time || y[j - 1].time != x[i - 1].time) continue;
      if(x[i - 1].close <= 0 || y[j - 1].close <= 0) continue;
      ra[m] = MathLog(x[i].close / x[i - 1].close); rb[m] = MathLog(y[j].close / y[j - 1].close); m++;
     }
   return m >= 10;
  }

string C_Intermarket(string sym)
  {
   if(IsSynthetic(sym)) return Obj(Jwhy("intermarket", "synthetic index: no real-market correlation"));
   datetime h1bar = iTime(_Symbol, PERIOD_H1, 0);
   string key = sym + "|" + IntegerToString((long)h1bar);
   if(g_imCache != "" && StringFind(g_imCache, "\"_key\":\"" + key + "\"") >= 0) return g_imCache;
   string f[];
   A_Push(f, J("_key", key));
   // currency strength: average % change of the 28 crosses over 1, 5, 20 H1 candles -> rank
   int wins[] = {1, 5, 20};
   string ranks[];
   int pairsUsed = 0;
   for(int w = 0; w < 3; w++)
     {
      double score[8]; int cnt[8];
      ArrayInitialize(score, 0); ArrayInitialize(cnt, 0);
      for(int a = 0; a < 8; a++)
         for(int b = 0; b < 8; b++)
           {
            if(a == b) continue;
            double chg;
            if(!PairChange(g_ccy[a] + g_ccy[b], wins[w], chg)) continue;
            score[a] += chg; cnt[a]++; score[b] -= chg; cnt[b]++;
            if(w == 0) pairsUsed++;
           }
      double avg[8]; int idx[8];
      for(int k = 0; k < 8; k++) { avg[k] = cnt[k] > 0 ? score[k] / cnt[k] : 0; idx[k] = k; }
      for(int x = 0; x < 7; x++) for(int y = x + 1; y < 8; y++) if(avg[idx[y]] > avg[idx[x]]) { int t = idx[x]; idx[x] = idx[y]; idx[y] = t; }
      string row = "";
      for(int k = 0; k < 8; k++) row += (k > 0 ? "," : "") + "\"" + g_ccy[idx[k]] + "\"";
      A_Push(ranks, Jr("strongest_to_weakest_" + IntegerToString(wins[w]) + "h", "[" + row + "]"));
     }
   A_Push(f, Jr("currency_strength", Obj(A_Join(ranks) + "," + Ji("pairs_used", pairsUsed))));
   // correlation with majors and gold (H1 log returns, 50 and 20 vs 100 for a break)
   string cor[];
   string refs[] = {"EURUSD", "GBPUSD", "USDJPY", "XAUUSD"};
   for(int k = 0; k < 4; k++)
     {
      string nm = ResolvedName(refs[k]);
      if(nm == "" || nm == sym) continue;
      double ra[], rb[]; int m;
      if(!AlignedReturns(sym, nm, 100, ra, rb, m)) { A_Push(cor, Obj(J("with", refs[k]) + "," + Jnull("corr_50") + "," + J("why", "not loaded yet"))); continue; }
      double c50 = Corr(ra, rb, MathMin(50, m));
      // last 20 vs the 100 window
      double ta[], tb[]; ArrayResize(ta, 20); ArrayResize(tb, 20);
      int st = MathMax(0, m - 20);
      for(int q = 0; q < 20 && st + q < m; q++) { ta[q] = ra[st + q]; tb[q] = rb[st + q]; }
      double c20 = Corr(ta, tb, MathMin(20, m)), c100 = Corr(ra, rb, m);
      A_Push(cor, Obj(J("with", refs[k]) + "," + Jn("corr_50", c50, 2) + "," + Jn("corr_20", c20, 2) + "," + Jn("corr_100", c100, 2) + "," + Jb("correlation_break", MathAbs(c20 - c100) > 0.5)));
     }
   A_Push(f, Jr("correlation_h1", Arr(cor)));
   // DXY proxy (published weights) from daily closes
   double w[] = {-0.576, 0.136, -0.119, 0.091, 0.042, 0.036};
   string pr[] = {"EURUSD", "USDJPY", "GBPUSD", "USDCAD", "USDSEK", "USDCHF"};
   double lnNow = 0, ln1 = 0, ln5 = 0, wsum = 0;
   for(int k = 0; k < 6; k++)
     {
      string nm = ResolvedName(pr[k]);
      if(nm == "" || !SeriesReady(nm, PERIOD_D1)) continue;
      double c[];
      if(CopyClose(nm, PERIOD_D1, 0, 7, c) != 7 || c[0] <= 0) continue;
      lnNow += w[k] * MathLog(c[6]); ln1 += w[k] * MathLog(c[5]); ln5 += w[k] * MathLog(c[1]); wsum += MathAbs(w[k]);
     }
   if(wsum > 0.5)
      A_Push(f, Jr("dxy_proxy", Obj(Jn("change_1d_pct", (MathExp(lnNow - ln1) - 1) * 100, 3) + "," + Jn("change_5d_pct", (MathExp(lnNow - ln5) - 1) * 100, 3) + "," + Jn("weights_available", wsum, 3))));
   else A_Push(f, Jwhy("dxy_proxy", "dollar pairs not loaded yet"));
   string gold = ResolvedName("XAUUSD"), uj = ResolvedName("USDJPY");
   double c[];
   if(gold != "" && SeriesReady(gold, PERIOD_D1) && CopyClose(gold, PERIOD_D1, 0, 6, c) == 6 && c[0] > 0) A_Push(f, Jn("gold_5d_pct", (c[5] - c[0]) / c[0] * 100, 2));
   if(uj != "" && SeriesReady(uj, PERIOD_D1) && CopyClose(uj, PERIOD_D1, 0, 6, c) == 6 && c[0] > 0) A_Push(f, Jn("usdjpy_5d_pct", (c[5] - c[0]) / c[0] * 100, 2));
   g_imCache = Obj(A_Join(f));
   return g_imCache;
  }

//+------------------------------------------------------------------+
//| 15. get_summary (reads the other timeframes' memory)              |
//+------------------------------------------------------------------+
string CycleTf(string sym, ENUM_TIMEFRAMES tf, double px, int &trend, bool &shifted, bool &transition)
  {
   trend = 0; shifted = false; transition = false;
   CSlot *s = GetSlot(sym, tf, 0);
   if(s == NULL) return Obj(J("tf", TfName(tf)) + "," + J("state", "not loaded yet (loading in the background)"));
   MsRead r; ReadStructure(s, r);
   trend = r.trend; shifted = r.shiftAt >= 0; transition = r.transition;
   bool inAol = r.invalidation > 0 && px >= MathMin(r.validation, r.invalidation) && px <= MathMax(r.validation, r.invalidation);
   return Obj(J("tf", TfName(tf)) + "," + J("trend", SideName(r.trend)) + "," +
              (r.lastBos >= 0 ? J("last_break", (g_brChoch[r.lastBos] ? "CHoCH " : "BOS ") + SideName(g_brSide[r.lastBos])) + "," + Ji("last_break_bars_ago", Ago(s, g_brAt[r.lastBos])) : Jnull("last_break")) + "," +
              Jb("shifted", shifted) + "," + (shifted ? J("shift_to", SideName(r.shiftSide)) + "," + Ji("shift_bars_ago", Ago(s, r.shiftAt)) + "," : "") + Jb("transition_only", shifted && transition) + "," +
              Jb("price_inside_aol", inAol));
  }

string C_Summary(CSlot *s)
  {
   string sym = s.sym;
   double px = s.c[s.lc], a = Atr(s);
   double spread = SymbolInfoDouble(sym, SYMBOL_ASK) - SymbolInfoDouble(sym, SYMBOL_BID);
   string f[];
   // a. multi-timeframe bias from STRUCTURE (D1 4, H4 3, H1 2, M15 1)
   ENUM_TIMEFRAMES mt[] = {PERIOD_D1, PERIOD_H4, PERIOD_H1, PERIOD_M15};
   int wt[] = {4, 3, 2, 1};
   string votes[]; int score = 0, maxScore = 0;
   int trends[4];
   for(int k = 0; k < 4; k++)
     {
      CSlot *t = GetSlot(sym, mt[k], 0);
      trends[k] = 0;
      if(t == NULL) { A_Push(votes, Obj(J("tf", TfName(mt[k])) + "," + J("trend", "not loaded yet"))); continue; }
      MsRead r; ReadStructure(t, r);
      trends[k] = r.trend; score += r.trend * wt[k]; maxScore += wt[k];
      A_Push(votes, Obj(J("tf", TfName(mt[k])) + "," + J("trend", SideName(r.trend)) + "," + Ji("weight", wt[k]) + "," + Ji("vote", r.trend * wt[k])));
     }
   int bias = score > 0 ? 1 : score < 0 ? -1 : 0;
   A_Push(f, Jr("mtf_structure", Obj(Jr("votes", Arr(votes)) + "," + Ji("score", score) + "," + Ji("max", maxScore) + "," + J("bias", SideName(bias)))));
   // b. confluence for THIS timeframe, every factor shown
   MsRead r; ReadStructure(s, r);
   int lc = s.lc;
   string fac[]; int tot = 0;
   int v1 = r.trend; tot += v1; A_Push(fac, Obj(J("factor", "structure trend") + "," + Ji("vote", v1)));
   int v2 = s.ema200[lc] > 0 ? (px > s.ema200[lc] ? 1 : -1) : 0; tot += v2; A_Push(fac, Obj(J("factor", "price vs EMA200") + "," + Ji("vote", v2)));
   int v3 = s.adx[lc] > 20 ? (s.pdi[lc] > s.mdi[lc] ? 1 : -1) : 0; tot += v3; A_Push(fac, Obj(J("factor", "ADX>20 with DI side") + "," + Ji("vote", v3)));
   int v4 = s.rsi[lc] > 55 ? 1 : s.rsi[lc] < 45 ? -1 : 0; tot += v4; A_Push(fac, Obj(J("factor", "RSI >55 / <45") + "," + Ji("vote", v4)));
   int v5 = s.macd[lc] > s.macdSig[lc] ? 1 : -1; tot += v5; A_Push(fac, Obj(J("factor", "MACD above/below signal") + "," + Ji("vote", v5)));
   int v6 = s.stDir[lc]; tot += v6; A_Push(fac, Obj(J("factor", "Supertrend") + "," + Ji("vote", v6)));
   A_Push(f, Jr("confluence", Obj(Jr("factors", Arr(fac)) + "," + Ji("total", tot) + "," + Ji("of", 6))));
   // c. ATR sizes
   double minStop = MathMax(SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * SymbolInfoDouble(sym, SYMBOL_POINT) + spread, spread * 3);
   A_Push(f, Jr("atr_sizes", Obj(Jn("sl_1atr", MathMax(a, minStop), s.digits) + "," + Jn("sl_1_5atr", MathMax(1.5 * a, minStop), s.digits) + "," + Jn("sl_2atr", MathMax(2 * a, minStop), s.digits) + "," +
                                 Jn("broker_min_stop", minStop, s.digits) + "," + Jn("atr_pips", ToPips(s, a), 1))));
   // d. trade plan from structure (facts from the other chains)
   if(bias != 0)
     {
      MsRead hr; ReadStructure(s, hr);
      BuildZones(s, hr);
      int best = -1; double bd = DBL_MAX;
      for(int k = 0; k < ArraySize(g_z); k++)
        {
         if(g_z[k].side != bias || ClosedThrough(s, g_z[k]) >= 0 || ConsumedPct(s, g_z[k]) >= 50) continue;
         double d = bias == 1 ? px - g_z[k].hi : g_z[k].lo - px;
         if(d < -(g_z[k].hi - g_z[k].lo)) continue; // zone on the wrong side of price
         if(MathAbs(d) < bd) { bd = MathAbs(d); best = k; }
        }
      if(best >= 0)
        {
         Zone z = g_z[best];
         bool inside = px >= z.lo && px <= z.hi;
         double entry = inside ? px : (bias == 1 ? z.hi : z.lo);
         double inv = z.invalid > 0 ? z.invalid : (bias == 1 ? z.lo : z.hi);
         double buffer = MathMax(0.1 * a, 2 * spread);
         double sl = bias == 1 ? inv - buffer : inv + buffer;
         if(MathAbs(entry - sl) < minStop) sl = bias == 1 ? entry - minStop : entry + minStop;
         // targets: nearest untaken pools in the bias direction
         double tps[2]; int nt = 0;
         for(int pass = 0; pass < 2; pass++)
           {
            double bestP = 0, bestD = DBL_MAX;
            for(int k = 0; k < ArraySize(s.swI); k++)
              {
               if(s.swK[k] != bias || TakenAt(s, k) >= 0) continue;
               double d = bias == 1 ? s.swP[k] - entry : entry - s.swP[k];
               if(d <= 0 || d >= bestD || (nt > 0 && MathAbs(s.swP[k] - tps[0]) < 0.1 * a)) continue;
               bestD = d; bestP = s.swP[k];
              }
            if(bestP > 0) tps[nt++] = bestP;
           }
         double risk = MathAbs(entry - sl);
         string plan = J("bias", SideName(bias)) + "," + J("entry_type", inside ? "market (price inside the zone)" : "limit at the zone edge") + "," +
                       J("zone", ZName(z.kind)) + "," + Jn("entry", entry, s.digits) + "," + Jn("sl", sl, s.digits) + "," +
                       J("sl_rule", "beyond the zone's invalidation + max(0.1 ATR, 2 x spread), never inside the broker minimum") + "," +
                       (nt > 0 ? Jn("tp1", tps[0], s.digits) + "," + Jn("rr_tp1_net_of_spread", risk > 0 ? (MathAbs(tps[0] - entry) - spread) / (risk + spread) : 0, 2) : Jnull("tp1")) + "," +
                       (nt > 1 ? Jn("tp2", tps[1], s.digits) : Jnull("tp2")) + "," +
                       (r.invalidation > 0 ? Jn("cancel_if_close_beyond", r.invalidation, s.digits) : Jnull("cancel_if_close_beyond")) + "," + Ji("valid_for_bars", 20);
         A_Push(f, Jr("trade_plan", Obj(plan)));
        }
      else A_Push(f, Jwhy("trade_plan", "no fresh zone on the bias side of price"));
     }
   else A_Push(f, Jwhy("trade_plan", "timeframes do not agree on a direction"));
   // e. reasons against
   string ag[];
   for(int k = 0; k < 2; k++) if(trends[k] != 0 && bias != 0 && trends[k] != bias) A_Push(ag, "\"" + TfName(mt[k]) + " structure is " + SideName(trends[k]) + "\"");
   if(spread > 0 && a > 0 && spread > 0.2 * a) A_Push(ag, "\"spread is more than 20% of ATR\"");
   string nw = C_News(sym);
   if(StringFind(nw, "\"blackout_now\":true") >= 0) A_Push(ag, "\"high-impact news blackout now\"");
   A_Push(f, Jr("reasons_against", "[" + A_Join(ag) + "]"));
   // f-j. APA cycles, coordination, FTA, entry modules
   ENUM_TIMEFRAMES mc[] = {PERIOD_MN1, PERIOD_D1, PERIOD_H1, PERIOD_M15, PERIOD_M3};
   ENUM_TIMEFRAMES wc[] = {PERIOD_W1, PERIOD_H4, PERIOD_M30, PERIOD_M5, PERIOD_M3};
   string mrow[], wrow[]; string agreeBull = "", agreeBear = "";
   int tr; bool sh, trn;
   bool h1Shift = false, h4Shift = false, h4Trans = false;
   for(int k = 0; k < 5; k++)
     {
      A_Push(mrow, CycleTf(sym, mc[k], px, tr, sh, trn));
      if(tr > 0) agreeBull += (agreeBull == "" ? "" : ",") + "\"" + TfName(mc[k]) + "\"";
      if(tr < 0) agreeBear += (agreeBear == "" ? "" : ",") + "\"" + TfName(mc[k]) + "\"";
      if(mc[k] == PERIOD_H1) h1Shift = sh && !trn;
     }
   for(int k = 0; k < 5; k++)
     {
      A_Push(wrow, CycleTf(sym, wc[k], px, tr, sh, trn));
      if(k < 4 && wc[k] != PERIOD_M3)
        {
         if(tr > 0 && StringFind(agreeBull, TfName(wc[k])) < 0) agreeBull += (agreeBull == "" ? "" : ",") + "\"" + TfName(wc[k]) + "\"";
         if(tr < 0 && StringFind(agreeBear, TfName(wc[k])) < 0) agreeBear += (agreeBear == "" ? "" : ",") + "\"" + TfName(wc[k]) + "\"";
        }
      if(wc[k] == PERIOD_H4) { h4Shift = sh && !trn; h4Trans = sh && trn; }
     }
   A_Push(f, Jr("apa_monthly_cycle", "[" + A_Join(mrow) + "]"));
   A_Push(f, Jr("apa_weekly_cycle", "[" + A_Join(wrow) + "]"));
   A_Push(f, Jr("timeframes_agreeing", Obj(Jr("bullish", "[" + agreeBull + "]") + "," + Jr("bearish", "[" + agreeBear + "]") + "," + J("rule", "the book: trade only when at least two timeframes agree"))));
   // FTA: nearest fresh opposite-side zone of the FTA timeframes between price and the bias direction
   ENUM_TIMEFRAMES fta[] = {PERIOD_W1, PERIOD_H4, PERIOD_D1, PERIOD_H1};
   string ftaRow = "null"; double ftaD = DBL_MAX;
   if(bias != 0)
      for(int k = 0; k < 4; k++)
        {
         CSlot *t = GetSlot(sym, fta[k], 0);
         if(t == NULL) continue;
         MsRead tr2; ReadStructure(t, tr2); BuildZones(t, tr2);
         for(int q = 0; q < ArraySize(g_z); q++)
           {
            if(g_z[q].side != -bias || ClosedThrough(t, g_z[q]) >= 0 || ConsumedPct(t, g_z[q]) >= 50) continue;
            double d = bias == 1 ? g_z[q].lo - px : px - g_z[q].hi;
            if(d <= 0 || d >= ftaD) continue;
            ftaD = d;
            ftaRow = Obj(J("tf", TfName(t.tf)) + "," + J("kind", ZName(g_z[q].kind)) + "," + Jn("top", g_z[q].hi, s.digits) + "," + Jn("bottom", g_z[q].lo, s.digits) + "," +
                         Jn("dist_atr", a > 0 ? d / a : 0, 2) + "," + J("fta_tf_state", tr2.shiftAt >= 0 ? (tr2.transition ? "transition only" : "shifted") : "not shifted"));
           }
        }
   A_Push(f, Jr("fta_ahead", ftaRow));
   A_Push(f, J("fta_rule", "monthly cycle: W1 and H4 are FTAs; weekly cycle: D1 and H1 are FTAs; FTA = take or lock profit there"));
   // entry modules: which parts are present
   string em = Jb("shift_entry_htf_aol_plus_ltf_shift", r.shiftAt >= 0 && !r.transition) + "," +
               Jb("fta_entry_h1_shift", h1Shift) + "," + J("fta_entry_h4", h4Shift ? "shifted (validates)" : h4Trans ? "transition only (caution)" : "no shift") + "," +
               J("flip_type1", "see get_levels apa_flip_levels (H4+)") + "," + J("flip_type2", "see get_levels apa_flip_entry_type2") + "," +
               J("liquidity_engineering", "see get_liquidity liquidity_engineering on the situational timeframes");
   A_Push(f, Jr("apa_entry_modules", Obj(em)));
   return Obj(A_Join(f));
  }

//+------------------------------------------------------------------+
//| Account tools                                                     |
//+------------------------------------------------------------------+
double A_RoundLots(string sym, double raw)
  {
   double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   if(step <= 0) step = 0.01;
   double lots = MathFloor(raw / step + 1e-9) * step;
   double vmax = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   if(vmax > 0 && lots > vmax) lots = vmax;
   return NormalizeDouble(lots, 2);
  }
string A_TradeModeName(string sym)
  {
   long m = SymbolInfoInteger(sym, SYMBOL_TRADE_MODE);
   if(m == SYMBOL_TRADE_MODE_DISABLED) return "disabled";
   if(m == SYMBOL_TRADE_MODE_LONGONLY) return "long only";
   if(m == SYMBOL_TRADE_MODE_SHORTONLY) return "short only";
   if(m == SYMBOL_TRADE_MODE_CLOSEONLY) return "close only";
   return "full";
  }

string A_PositionSize(string sym, string obj)
  {
   string side = JsonGetString(obj, "side"); StringToLower(side);
   if(side != "sell") side = "buy";
   bool buy = side == "buy";
   double sl = JsonGetNumber(obj, "sl", 0), entry = JsonGetNumber(obj, "entry", 0);
   double riskPct = JsonGetNumber(obj, "risk_pct", 0), riskMoney = JsonGetNumber(obj, "risk_money", 0);
   int dg = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   MqlTick tk; SymbolInfoTick(sym, tk);
   if(entry <= 0) entry = buy ? tk.ask : tk.bid;
   if(sl <= 0) { g_aErr = "a stop loss price (sl) is needed to size the trade"; return ""; }
   if(entry <= 0) { g_aErr = "no price for " + sym + " right now"; return ""; }
   if((buy && sl >= entry) || (!buy && sl <= entry)) { g_aErr = "the stop loss is on the wrong side of the entry for a " + side; return ""; }
   double bal = AccountInfoDouble(ACCOUNT_BALANCE);
   if(riskMoney <= 0) { if(riskPct <= 0) riskPct = 1.0; riskMoney = bal * riskPct / 100.0; }
   else riskPct = bal > 0 ? riskMoney / bal * 100.0 : 0;
   ENUM_ORDER_TYPE ot = buy ? ORDER_TYPE_BUY : ORDER_TYPE_SELL;
   double lossPerLot = 0;
   if(!OrderCalcProfit(ot, sym, 1.0, entry, sl, lossPerLot)) { g_aErr = "MT5 could not calculate the loss for " + sym; return ""; }
   lossPerLot = MathAbs(lossPerLot);
   if(lossPerLot <= 0) { g_aErr = "the stop is too close to the entry to size a trade"; return ""; }
   double vmin = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), vmax = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX), vstep = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP);
   double raw = riskMoney / lossPerLot, lots = A_RoundLots(sym, raw);
   bool belowMin = lots < vmin;
   double sized = belowMin ? 0 : lots, margin = 0;
   OrderCalcMargin(ot, sym, belowMin ? vmin : lots, entry, margin);
   double freeM = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   double stopsLevel = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * SymbolInfoDouble(sym, SYMBOL_POINT);
   // risk already open (to each position's stop) and currency exposure
   double openRisk = 0; int noStop = 0; string expo = "";
   string base, quote; PairCurrencies(sym, base, quote);
   double expBase = 0, expQuote = 0;
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong t = PositionGetTicket(i); if(t == 0) continue;
      string ps = PositionGetString(POSITION_SYMBOL);
      bool pb = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY;
      double pv = PositionGetDouble(POSITION_VOLUME), pop = PositionGetDouble(POSITION_PRICE_OPEN), psl = PositionGetDouble(POSITION_SL);
      if(psl > 0) { double pl = 0; if(OrderCalcProfit(pb ? ORDER_TYPE_BUY : ORDER_TYPE_SELL, ps, pv, pop, psl, pl)) openRisk += MathMax(0, -pl); }
      else noStop++;
      string pbse, pq; PairCurrencies(ps, pbse, pq);
      double sgn = pb ? 1 : -1;
      if(pbse == base) expBase += sgn * pv; if(pq == base) expBase -= sgn * pv;
      if(pbse == quote) expQuote += sgn * pv; if(pq == quote) expQuote -= sgn * pv;
     }
   string f[];
   A_Push(f, Js("symbol", sym)); A_Push(f, J("side", side));
   A_Push(f, Jn("entry", entry, dg)); A_Push(f, Jn("sl", sl, dg));
   A_Push(f, Jn("sl_distance_pips", MathAbs(entry - sl) / PipOf(sym), 1));
   A_Push(f, Jb("sl_inside_broker_min_distance", stopsLevel > 0 && MathAbs(entry - sl) < stopsLevel));
   A_Push(f, J("account_currency", AccountInfoString(ACCOUNT_CURRENCY)));
   A_Push(f, Jn("balance", bal, 2)); A_Push(f, Jn("risk_pct", riskPct, 2)); A_Push(f, Jn("risk_money_target", riskMoney, 2));
   A_Push(f, Jn("loss_per_1_lot", lossPerLot, 2)); A_Push(f, Jn("lots", sized, 2)); A_Push(f, Jn("raw_lots", raw, 4));
   A_Push(f, Jn("actual_risk_money", sized * lossPerLot, 2)); A_Push(f, Jb("below_min_lot", belowMin));
   A_Push(f, Jn("min_lot", vmin, 2)); A_Push(f, Jn("max_lot", vmax, 2)); A_Push(f, Jn("lot_step", vstep, 2));
   A_Push(f, Jn("risk_at_min_lot", vmin * lossPerLot, 2));
   A_Push(f, Jn("margin_required", margin, 2)); A_Push(f, Jn("free_margin", freeM, 2)); A_Push(f, Jn("free_margin_after", freeM - margin, 2));
   A_Push(f, Jb("fits_free_margin", margin <= freeM));
   A_Push(f, Jn("open_risk_to_stops", openRisk, 2)); A_Push(f, Ji("open_positions_without_stop", noStop));
   A_Push(f, Jr("currency_exposure_lots_before", Obj(Jn(base, expBase, 2) + "," + Jn(quote, expQuote, 2))));
   A_Push(f, Jb("adds_to_existing_exposure", (buy && (expBase > 0 || expQuote < 0)) || (!buy && (expBase < 0 || expQuote > 0))));
   A_Push(f, J("method", "MT5 OrderCalcProfit (exact loss per lot at the stop) and OrderCalcMargin"));
   return Obj(A_Join(f));
  }

string A_SymbolInfo(string sym)
  {
   if(SymbolInfoDouble(sym, SYMBOL_POINT) <= 0) { g_aErr = "\"" + sym + "\" isn't on this broker"; return ""; }
   MqlTick tk; SymbolInfoTick(sym, tk);
   datetime nowSrv = TimeTradeServer();
   long qAge = tk.time > 0 ? (long)nowSrv - (long)tk.time : -1;
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(sym, SYMBOL_POINT), pip = PipOf(sym);
   double mBuy = 0, mSell = 0;
   OrderCalcMargin(ORDER_TYPE_BUY, sym, 1.0, tk.ask, mBuy);
   OrderCalcMargin(ORDER_TYPE_SELL, sym, 1.0, tk.bid, mSell);
   MqlDateTime sd; TimeToStruct(nowSrv, sd);
   string sess[];
   for(uint k = 0; k < 10; k++)
     {
      datetime from, to;
      if(!SymbolInfoSessionTrade(sym, (ENUM_DAY_OF_WEEK)sd.day_of_week, k, from, to)) break;
      int a = (int)from, b = (int)to;
      int au = (int)(((a - g_srvOffset) % 86400 + 86400) % 86400), bu = (int)(((b - g_srvOffset) % 86400 + 86400) % 86400);
      A_Push(sess, Obj(J("from_utc", StringFormat("%02d:%02d", au / 3600, (au % 3600) / 60)) + "," + J("to_utc", StringFormat("%02d:%02d", bu / 3600, (bu % 3600) / 60))));
     }
   long fill = SymbolInfoInteger(sym, SYMBOL_FILLING_MODE);
   long sl = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL);
   string f[];
   A_Push(f, Js("symbol", sym)); A_Push(f, Js("description", SymbolInfoString(sym, SYMBOL_DESCRIPTION))); A_Push(f, Js("path", SymbolInfoString(sym, SYMBOL_PATH)));
   A_Push(f, J("currency_base", SymbolInfoString(sym, SYMBOL_CURRENCY_BASE))); A_Push(f, J("currency_profit", SymbolInfoString(sym, SYMBOL_CURRENCY_PROFIT)));
   A_Push(f, J("currency_margin", SymbolInfoString(sym, SYMBOL_CURRENCY_MARGIN)));
   A_Push(f, Jb("synthetic_24_7", IsSynthetic(sym)));
   A_Push(f, Ji("digits", digits)); A_Push(f, Jn("point", point, 8)); A_Push(f, Jn("pip", pip, 8));
   A_Push(f, Jn("contract_size", SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE), 2));
   A_Push(f, Jn("tick_size", SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE), 8)); A_Push(f, Jn("tick_value", SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE), 6));
   A_Push(f, Jn("pip_value_per_lot", SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE) > 0 ? SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE) * pip / SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE) : 0, 4));
   A_Push(f, Jn("min_lot", SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), 2)); A_Push(f, Jn("max_lot", SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX), 2));
   A_Push(f, Jn("lot_step", SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP), 2)); A_Push(f, Jn("volume_limit", SymbolInfoDouble(sym, SYMBOL_VOLUME_LIMIT), 2));
   A_Push(f, Jn("margin_per_lot_buy", mBuy, 2)); A_Push(f, Jn("margin_per_lot_sell", mSell, 2));
   A_Push(f, J("account_currency", AccountInfoString(ACCOUNT_CURRENCY)));
   A_Push(f, Ji("stops_level_points", sl)); A_Push(f, Jn("stops_level_price", sl * point, digits));
   A_Push(f, Ji("freeze_level_points", SymbolInfoInteger(sym, SYMBOL_TRADE_FREEZE_LEVEL)));
   if(sl == 0) A_Push(f, J("stops_note", "0 = floating: keep stops at least 3 x spread away"));
   A_Push(f, Ji("spread_points", SymbolInfoInteger(sym, SYMBOL_SPREAD))); A_Push(f, Jb("spread_floating", SymbolInfoInteger(sym, SYMBOL_SPREAD_FLOAT) != 0));
   A_Push(f, Jn("swap_long", SymbolInfoDouble(sym, SYMBOL_SWAP_LONG), 4)); A_Push(f, Jn("swap_short", SymbolInfoDouble(sym, SYMBOL_SWAP_SHORT), 4));
   A_Push(f, J("swap_mode", EnumToString((ENUM_SYMBOL_SWAP_MODE)SymbolInfoInteger(sym, SYMBOL_SWAP_MODE))));
   A_Push(f, J("triple_swap_day", EnumToString((ENUM_DAY_OF_WEEK)SymbolInfoInteger(sym, SYMBOL_SWAP_ROLLOVER3DAYS))));
   A_Push(f, J("trade_mode", A_TradeModeName(sym)));
   A_Push(f, J("execution_mode", EnumToString((ENUM_SYMBOL_TRADE_EXECUTION)SymbolInfoInteger(sym, SYMBOL_TRADE_EXEMODE))));
   A_Push(f, J("calc_mode", EnumToString((ENUM_SYMBOL_CALC_MODE)SymbolInfoInteger(sym, SYMBOL_TRADE_CALC_MODE))));
   A_Push(f, Jb("fill_fok", (fill & SYMBOL_FILLING_FOK) != 0)); A_Push(f, Jb("fill_ioc", (fill & SYMBOL_FILLING_IOC) != 0));
   A_Push(f, Jr("sessions_today_utc", Arr(sess)));
   A_Push(f, J("quote_time_utc", SrvToIso((datetime)tk.time))); A_Push(f, Ji("quote_age_sec", qAge));
   A_Push(f, Jb("market_open_now", MarketOpenNow(sym)));
   A_Push(f, Jn("bid", tk.bid, digits)); A_Push(f, Jn("ask", tk.ask, digits));
   A_Push(f, J("ea_version", EA_VERSION));
   return Obj(A_Join(f));
  }

string A_History(string obj, string symFilter)
  {
   int days = (int)JsonGetNumber(obj, "days", 7);
   if(days < 1) days = 1;
   if(days > 90) days = 90;
   datetime to = TimeTradeServer() + 60, from = to - days * 86400;
   if(!HistorySelect(from, to)) { g_aErr = "MT5 could not load the trade history"; return ""; }
   int n = HistoryDealsTotal();
   ulong ids[]; string syms[], types[], reasons[]; double vols[], opx[], cpx[], prof[], swp[], com[]; datetime ot[], ct[]; long mag[];
   double deposits = 0, withdrawals = 0;
   for(int d = 0; d < n; d++)
     {
      ulong dt = HistoryDealGetTicket(d);
      if(dt == 0) continue;
      long dtype = HistoryDealGetInteger(dt, DEAL_TYPE);
      if(dtype == DEAL_TYPE_BALANCE) { double amt = HistoryDealGetDouble(dt, DEAL_PROFIT); if(amt > 0) deposits += amt; else withdrawals += -amt; continue; }
      if(dtype != DEAL_TYPE_BUY && dtype != DEAL_TYPE_SELL) continue;
      string s = HistoryDealGetString(dt, DEAL_SYMBOL);
      if(symFilter != "" && StringFind(s, symFilter) != 0) continue;
      ulong pid = (ulong)HistoryDealGetInteger(dt, DEAL_POSITION_ID);
      int k = -1;
      for(int i = 0; i < ArraySize(ids); i++) if(ids[i] == pid) { k = i; break; }
      if(k < 0)
        {
         k = ArraySize(ids);
         ArrayResize(ids, k + 1); ArrayResize(syms, k + 1); ArrayResize(types, k + 1); ArrayResize(reasons, k + 1);
         ArrayResize(vols, k + 1); ArrayResize(opx, k + 1); ArrayResize(cpx, k + 1); ArrayResize(prof, k + 1);
         ArrayResize(swp, k + 1); ArrayResize(com, k + 1); ArrayResize(ot, k + 1); ArrayResize(ct, k + 1); ArrayResize(mag, k + 1);
         ids[k] = pid; syms[k] = s; types[k] = ""; reasons[k] = ""; vols[k] = 0; opx[k] = 0; cpx[k] = 0; prof[k] = 0; swp[k] = 0; com[k] = 0; ot[k] = 0; ct[k] = 0; mag[k] = 0;
        }
      long entry = HistoryDealGetInteger(dt, DEAL_ENTRY);
      prof[k] += HistoryDealGetDouble(dt, DEAL_PROFIT);
      swp[k]  += HistoryDealGetDouble(dt, DEAL_SWAP);
      com[k]  += HistoryDealGetDouble(dt, DEAL_COMMISSION) + HistoryDealGetDouble(dt, DEAL_FEE);
      if(entry == DEAL_ENTRY_IN)
        {
         types[k] = dtype == DEAL_TYPE_BUY ? "buy" : "sell";
         opx[k] = HistoryDealGetDouble(dt, DEAL_PRICE); ot[k] = (datetime)HistoryDealGetInteger(dt, DEAL_TIME);
         mag[k] = HistoryDealGetInteger(dt, DEAL_MAGIC);
        }
      else
        {
         vols[k] += HistoryDealGetDouble(dt, DEAL_VOLUME);
         cpx[k] = HistoryDealGetDouble(dt, DEAL_PRICE); ct[k] = (datetime)HistoryDealGetInteger(dt, DEAL_TIME);
         long r = HistoryDealGetInteger(dt, DEAL_REASON);
         reasons[k] = r == DEAL_REASON_TP ? "tp" : r == DEAL_REASON_SL ? "sl" : r == DEAL_REASON_SO ? "stopout" :
                      (r == DEAL_REASON_EXPERT ? (HistoryDealGetInteger(dt, DEAL_MAGIC) == MagicNumber ? "dave" : "expert") : "manual");
         if(types[k] == "") types[k] = dtype == DEAL_TYPE_BUY ? "sell" : "buy";
        }
     }
   string rows[]; int wins = 0, losses = 0, closedN = 0; double net = 0, grossWin = 0, grossLoss = 0, totCom = 0, totSwap = 0;
   MqlDateTime nd; datetime nowSrv = TimeTradeServer(); TimeToStruct(nowSrv, nd);
   datetime day0 = nowSrv - (nd.hour * 3600 + nd.min * 60 + nd.sec);
   datetime week0 = day0 - ((nd.day_of_week + 6) % 7) * 86400;
   double today = 0, week = 0;
   int streak = 0, streakDir = 0; bool streakDone = false;
   // newest first (ids are in deal order, oldest first)
   int order[]; ArrayResize(order, ArraySize(ids));
   for(int i = 0; i < ArraySize(ids); i++) order[i] = i;
   for(int x = 0; x < ArraySize(order) - 1; x++)
      for(int y = x + 1; y < ArraySize(order); y++)
         if(ct[order[y]] > ct[order[x]]) { int t = order[x]; order[x] = order[y]; order[y] = t; }
   for(int oi = 0; oi < ArraySize(order); oi++)
     {
      int i = order[oi];
      if(vols[i] <= 0) continue;
      closedN++;
      double pnl = prof[i] + swp[i] + com[i];
      net += pnl; totCom += com[i]; totSwap += swp[i];
      if(pnl > 0) { wins++; grossWin += pnl; } else if(pnl < 0) { losses++; grossLoss += -pnl; }
      if(ct[i] >= day0) today += pnl;
      if(ct[i] >= week0) week += pnl;
      int d = pnl > 0 ? 1 : pnl < 0 ? -1 : 0;
      if(!streakDone && d != 0) { if(streakDir == 0 || streakDir == d) { streakDir = d; streak++; } else streakDone = true; }
      if(ArraySize(rows) >= 100) continue;
      int dg = (int)SymbolInfoInteger(syms[i], SYMBOL_DIGITS);
      A_Push(rows, Obj(J("ticket", IntegerToString((long)ids[i])) + "," + Js("symbol", syms[i]) + "," + J("type", types[i]) + "," +
             Jn("volume", vols[i], 2) + "," + (opx[i] > 0 ? Jn("open_price", opx[i], dg) : Jnull("open_price")) + "," + Jn("close_price", cpx[i], dg) + "," +
             J("open_time", ot[i] > 0 ? SrvToIso(ot[i]) : "") + "," + J("close_time", SrvToIso(ct[i])) + "," +
             Jn("profit", prof[i], 2) + "," + Jn("swap", swp[i], 2) + "," + Jn("commission", com[i], 2) + "," + Jn("net", pnl, 2) + "," +
             J("reason", reasons[i]) + "," + Jb("by_dave", mag[i] == MagicNumber) + "," + Jb("opened_before_window", ot[i] == 0)));
     }
   double avgW = wins > 0 ? grossWin / wins : 0, avgL = losses > 0 ? grossLoss / losses : 0;
   double wr = closedN > 0 ? (double)wins / closedN : 0;
   return Obj(Ji("days", days) + "," + J("account_currency", AccountInfoString(ACCOUNT_CURRENCY)) + "," +
              Jr("summary", Obj(Ji("closed_trades", closedN) + "," + Ji("wins", wins) + "," + Ji("losses", losses) + "," +
                  Jn("win_rate_pct", wr * 100, 1) + "," + Jn("net", net, 2) + "," + Jn("gross_profit", grossWin, 2) + "," + Jn("gross_loss", grossLoss, 2) + "," +
                  Jn("profit_factor", grossLoss > 0 ? grossWin / grossLoss : 0, 2) + "," + Jn("avg_win", avgW, 2) + "," + Jn("avg_loss", avgL, 2) + "," +
                  Jn("expectancy_per_trade", wr * avgW - (1 - wr) * avgL, 2) + "," +
                  J("current_streak", streakDir > 0 ? IntegerToString(streak) + " wins" : streakDir < 0 ? IntegerToString(streak) + " losses" : "none") + "," +
                  Jn("today_net", today, 2) + "," + Jn("this_week_net", week, 2) + "," +
                  Jn("commissions", totCom, 2) + "," + Jn("swaps", totSwap, 2) + "," + Jn("deposits", deposits, 2) + "," + Jn("withdrawals", withdrawals, 2))) + "," +
              J("order", "newest_first") + "," + J("times", "UTC") + "," + Jr("trades", Arr(rows)));
  }

string A_OpenTrades()
  {
   string rows[];
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong t = PositionGetTicket(i); if(t == 0) continue;
      string ps = PositionGetString(POSITION_SYMBOL);
      bool buy = PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY;
      double lots = PositionGetDouble(POSITION_VOLUME), op = PositionGetDouble(POSITION_PRICE_OPEN), sl = PositionGetDouble(POSITION_SL), tp = PositionGetDouble(POSITION_TP);
      datetime otime = (datetime)PositionGetInteger(POSITION_TIME);
      long posId = PositionGetInteger(POSITION_IDENTIFIER);
      double prof = PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP);
      int dg = (int)SymbolInfoInteger(ps, SYMBOL_DIGITS);
      double px = buy ? SymbolInfoDouble(ps, SYMBOL_BID) : SymbolInfoDouble(ps, SYMBOL_ASK);
      // the stop the trade opened with (from its opening order)
      double sl0 = 0;
      if(HistorySelectByPosition(posId))
         for(int k = 0; k < HistoryOrdersTotal(); k++) { ulong ot = HistoryOrderGetTicket(k); if(ot > 0) { sl0 = HistoryOrderGetDouble(ot, ORDER_SL); if(sl0 > 0) break; } }
      if(sl0 <= 0) sl0 = sl;
      double risk = sl0 > 0 ? MathAbs(op - sl0) : 0;
      double move = buy ? px - op : op - px;
      // best / worst since entry (M1 if loaded, else M5)
      double best = 0, worst = 0; bool mm = false;
      ENUM_TIMEFRAMES mtf = SeriesReady(ps, PERIOD_M1) ? PERIOD_M1 : PERIOD_M5;
      if(SeriesReady(ps, mtf))
        {
         MqlRates r[];
         int got = CopyRates(ps, mtf, otime, TimeTradeServer(), r);
         if(got > 0 && got <= 5000)
           {
            double hi = r[0].high, lo = r[0].low;
            for(int q = 1; q < got; q++) { hi = MathMax(hi, r[q].high); lo = MathMin(lo, r[q].low); }
            best = buy ? hi - op : op - lo; worst = buy ? op - lo : hi - op; mm = true;
           }
        }
      long frz = SymbolInfoInteger(ps, SYMBOL_TRADE_FREEZE_LEVEL), stl = SymbolInfoInteger(ps, SYMBOL_TRADE_STOPS_LEVEL);
      double pt = SymbolInfoDouble(ps, SYMBOL_POINT);
      bool beOk = move > 0 && MathAbs(px - op) > MathMax(frz, stl) * pt;
      CSlot *h1 = GetSlot(ps, PERIOD_H1, 0);
      string bars = h1 != NULL ? Ji("bars_open_h1", iBarShift(ps, PERIOD_H1, otime)) : Jnull("bars_open_h1");
      // invalidation of the H1 area of liquidity the trade sits in, and the H1 FMD if any
      string apa = "null";
      if(h1 != NULL)
        {
         MsRead r; ReadStructure(h1, r);
         if(r.invalidation > 0)
           {
            bool closedThrough = false;
            for(int j = h1.lc; j >= 0 && h1.t[j] >= otime; j--) if(buy ? h1.c[j] < r.invalidation : h1.c[j] > r.invalidation) { closedThrough = true; break; }
            apa = Obj(Jn("h1_invalidation", r.invalidation, dg) + "," + Jb("closed_through_since_entry", closedThrough));
           }
        }
      A_Push(rows, Obj(J("ticket", IntegerToString((long)t)) + "," + Js("symbol", ps) + "," + J("side", buy ? "buy" : "sell") + "," + Jn("lots", lots, 2) + "," +
                       Jn("entry", op, dg) + "," + Jn("sl", sl, dg) + "," + Jn("tp", tp, dg) + "," + Jn("opening_sl", sl0, dg) + "," + Jn("price", px, dg) + "," +
                       Jn("profit_money", prof, 2) + "," + (risk > 0 ? Jn("profit_r", move / risk, 2) : Jnull("profit_r")) + "," +
                       (mm && risk > 0 ? Jn("best_r", best / risk, 2) + "," + Jn("worst_r", -worst / risk, 2) : Jnull("best_r")) + "," +
                       (sl > 0 ? Jn("to_sl_pips", MathAbs(px - sl) / PipOf(ps), 1) : Jnull("to_sl_pips")) + "," +
                       (tp > 0 ? Jn("to_tp_pips", MathAbs(tp - px) / PipOf(ps), 1) : Jnull("to_tp_pips")) + "," +
                       Jb("breakeven_allowed", beOk) + "," + bars + "," + J("opened_utc", SrvToIso(otime)) + "," +
                       Jb("by_dave", PositionGetInteger(POSITION_MAGIC) == MagicNumber) + "," + Jr("apa", apa)));
     }
   string pend[];
   for(int i = 0; i < OrdersTotal(); i++)
     {
      ulong t = OrderGetTicket(i); if(t == 0) continue;
      string os = OrderGetString(ORDER_SYMBOL);
      int dg = (int)SymbolInfoInteger(os, SYMBOL_DIGITS);
      double op = OrderGetDouble(ORDER_PRICE_OPEN), cur = SymbolInfoDouble(os, SYMBOL_BID);
      A_Push(pend, Obj(J("ticket", IntegerToString((long)t)) + "," + Js("symbol", os) + "," + J("type", OrderTypeToString((ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE))) + "," +
                       Jn("price", op, dg) + "," + Jn("sl", OrderGetDouble(ORDER_SL), dg) + "," + Jn("tp", OrderGetDouble(ORDER_TP), dg) + "," +
                       Jn("dist_pips", MathAbs(op - cur) / PipOf(os), 1)));
     }
   return Obj(Jr("positions", Arr(rows)) + "," + Jr("pending_orders", Arr(pend)) + "," + J("times", "UTC"));
  }

//+------------------------------------------------------------------+
//| Freshness label + dispatch                                        |
//+------------------------------------------------------------------+
string Meta(CSlot *s, string tfStr, ulong us)
  {
   long lastTick = SymbolInfoInteger(s.sym, SYMBOL_TIME);
   int behind = 0;
   if(lastTick > 0 && s.n > 0 && (datetime)lastTick > s.t[s.n - 1] + PeriodSeconds(s.tf)) behind = (int)(((datetime)lastTick - s.t[s.n - 1]) / PeriodSeconds(s.tf));
   long closesIn = (long)PeriodSeconds(s.tf) - (long)(TimeTradeServer() - s.t[s.n - 1]);
   return Obj(Js("symbol", s.sym) + "," + J("timeframe", tfStr) + "," + Ji("bars", s.n) + "," +
              J("last_closed_candle_utc", SrvToIso(s.t[s.lc])) + "," + J("forming_candle_open_utc", SrvToIso(s.t[s.n - 1])) + "," +
              Jb("last_candle_still_forming", closesIn > 0) + "," + Ji("forming_closes_in_sec", MathMax((long)0, closesIn)) + "," +
              Jb("from_cache", s.fromCache) + "," + Ji("cache_age_sec", (long)(TimeLocal() - s.loadedAt)) + "," +
              Ji("bars_behind", behind) + "," + Jb("stale", s.stale) + "," +
              Jb("market_open", MarketOpenNow(s.sym)) + "," + Ji("quote_age_sec", lastTick > 0 ? (long)TimeTradeServer() - lastTick : -1) + "," +
              J("signals_on", "closed candles only") + "," + J("distances_from", "the last closed candle's close") + "," +
              Ji("compute_us", (long)us) + "," + J("ea_version", EA_VERSION));
  }

string WithMeta(string data, string meta)
  {
   if(StringLen(data) < 2 || StringGetCharacter(data, 0) != '{') return data;
   string rest = StringSubstr(data, 1);
   return "{\"_meta\":" + meta + (rest == "}" ? "" : ",") + rest;
  }

// cached chain answer (rebuilt on a new closed candle, or after 30 s for chains that read other timeframes)
string Chain(CSlot *s, int ch)
  {
   if(s.cache[ch] != "" && (ch == CH_CANDLES || TimeLocal() - s.cacheAt[ch] < 30)) return s.cache[ch];
   ulong t0 = GetMicrosecondCount();
   string r = "";
   switch(ch)
     {
      case CH_CANDLES:  r = C_Candles(s, 21); break;
      case CH_MS:       r = C_MarketStructure(s); break;
      case CH_LIQ:      r = C_Liquidity(s); break;
      case CH_ZONES:    r = C_Zones(s); break;
      case CH_TREND:    r = C_Trend(s); break;
      case CH_MOM:      r = C_Momentum(s); break;
      case CH_VOLAT:    r = C_Volatility(s); break;
      case CH_VOLUME:   r = C_Volume(s); break;
      case CH_LEVELS:   r = C_Levels(s); break;
      case CH_PATTERNS: r = C_ChartPatterns(s); break;
     }
   s.chUs[ch] = GetMicrosecondCount() - t0;
   s.cache[ch] = r;
   s.cacheAt[ch] = TimeLocal();
   if(s.chUs[ch] > 50000) Print("Dave EA: ", s.key, " chain ", ch, " took ", s.chUs[ch] / 1000, " ms");
   return r;
  }

// old 3.x endpoint names -> the 4.0 group that now holds that data
string Canonical(string ep)
  {
   if(ep == "structure" || ep == "swing" || ep == "fractal" || ep == "premium_discount" || ep == "inducement") return "market_structure";
   if(ep == "patterns") return "candles";
   if(ep == "order_blocks" || ep == "ict") return "zones";
   if(ep == "pivots" || ep == "fibonacci" || ep == "gann") return "levels";
   if(ep == "orderflow" || ep == "tape" || ep == "tape_flow" || ep == "market_profile") return "volume";
   if(ep == "correlation" || ep == "strength" || ep == "heatmap" || ep == "macro") return "intermarket";
   if(ep == "ichimoku" || ep == "adx" || ep == "regime") return "trend";
   if(ep == "divergence" || ep == "mean_reversion") return "momentum";
   if(ep == "reference_levels" || ep == "spread_analysis") return "price";
   if(ep == "mtf" || ep == "confluence" || ep == "risk_metrics" || ep == "backtest") return "summary";
   if(ep == "harmonic" || ep == "elliott" || ep == "wyckoff") return "chart_patterns";
   if(ep == "synthetic") return "volatility";
   if(ep == "seasonality" || ep == "sentiment") return "session";
   return ep;
  }

string AllAnalysis(CSlot *s)
  {
   string f[];
   A_Push(f, Jr("price", C_Price(s.sym)));
   A_Push(f, Jr("candles", Chain(s, CH_CANDLES)));
   A_Push(f, Jr("market_structure", Chain(s, CH_MS)));
   A_Push(f, Jr("liquidity", Chain(s, CH_LIQ)));
   A_Push(f, Jr("zones", Chain(s, CH_ZONES)));
   A_Push(f, Jr("trend", Chain(s, CH_TREND)));
   A_Push(f, Jr("momentum", Chain(s, CH_MOM)));
   A_Push(f, Jr("volatility", Chain(s, CH_VOLAT)));
   A_Push(f, Jr("volume", Chain(s, CH_VOLUME)));
   A_Push(f, Jr("levels", Chain(s, CH_LEVELS)));
   A_Push(f, Jr("session", C_Session(s.sym)));
   A_Push(f, Jr("news", C_News(s.sym)));
   A_Push(f, Jr("intermarket", C_Intermarket(s.sym)));
   A_Push(f, Jr("chart_patterns", Chain(s, CH_PATTERNS)));
   A_Push(f, Jr("summary", C_Summary(s)));
   return Obj(A_Join(f));
  }

void RunAnalysis(string commandId, string endpoint, string symbol, string tfStr, string obj)
  {
   g_srvOffset = SrvOffset();
   g_aErr = "";
   g_warmBudget = 4;
   ReleaseLoadedSeries();
   ulong t0 = GetMicrosecondCount();
   string ep = Canonical(endpoint);
   if(ep == "ping")
     {
      AppendResultData(commandId, Obj(J("status", "ok") + "," + J("time", IsoUtc(TimeGMT())) + "," + J("source", "DaveEA") + "," + J("ea_version", EA_VERSION) + "," +
                                      Jb("terminal_connected", TerminalInfoInteger(TERMINAL_CONNECTED) != 0) + "," +
                                      Jb("algo_trading", TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED)) + "," +
                                      Ji("server_utc_offset_min", g_srvOffset / 60) + "," + Ji("memory_slots", ArraySize(g_slots))));
      return;
     }
   string data = "";
   if(ep == "history") data = A_History(obj, symbol);
   else if(ep == "open_trades") data = A_OpenTrades();
   else if(ep == "symbol_info") data = A_SymbolInfo(symbol);
   else if(ep == "position_size")
     {
      if(SymbolInfoDouble(symbol, SYMBOL_POINT) <= 0) g_aErr = "\"" + symbol + "\" isn't on this broker";
      else data = A_PositionSize(symbol, obj);
     }
   if(ep == "history" || ep == "open_trades" || ep == "symbol_info" || ep == "position_size")
     {
      if(g_aErr != "" || data == "") AppendResult(commandId, false, g_aErr != "" ? g_aErr : "no data", "");
      else AppendResultData(commandId, data);
      return;
     }
   if(symbol == "" || SymbolInfoDouble(symbol, SYMBOL_POINT) <= 0)
     {
      AppendResult(commandId, false, "\"" + symbol + "\" isn't on this broker (not in its symbol list)", "");
      return;
     }
   ENUM_TIMEFRAMES tf = TimeframeFromString(tfStr);
   CSlot *s = GetSlot(symbol, tf, 1500);
   if(s == NULL)
     {
      AppendResult(commandId, false, "warming_up: MT5 is still loading " + symbol + " " + tfStr + " history -- ask again in a few seconds", "");
      return;
     }
   s.lastAsked = TimeLocal();
   if(ep == "candles") data = C_Candles(s, (int)JsonGetNumber(obj, "count", 21));
   else if(ep == "price") data = C_Price(symbol);
   else if(ep == "market_structure") data = Chain(s, CH_MS);
   else if(ep == "liquidity") data = Chain(s, CH_LIQ);
   else if(ep == "zones") data = Chain(s, CH_ZONES);
   else if(ep == "trend") data = Chain(s, CH_TREND);
   else if(ep == "momentum") data = Chain(s, CH_MOM);
   else if(ep == "volatility") data = Chain(s, CH_VOLAT);
   else if(ep == "volume") data = Chain(s, CH_VOLUME);
   else if(ep == "levels") data = Chain(s, CH_LEVELS);
   else if(ep == "session") data = C_Session(symbol);
   else if(ep == "news") data = C_News(symbol);
   else if(ep == "intermarket") data = C_Intermarket(symbol);
   else if(ep == "chart_patterns") data = Chain(s, CH_PATTERNS);
   else if(ep == "summary") data = C_Summary(s);
   else if(ep == "all") data = AllAnalysis(s);
   else
     {
      AppendResult(commandId, false, "endpoint \"" + endpoint + "\" is not an EA endpoint", "");
      return;
     }
   if(g_aErr != "" || data == "")
     {
      AppendResult(commandId, false, g_aErr != "" ? g_aErr : "no data", "");
      return;
     }
   AppendResultData(commandId, WithMeta(data, Meta(s, tfStr, GetMicrosecondCount() - t0)));
  }

// Timer: keep the timeframes the bot asked for in the last 10 minutes ready before it asks again --
// a new candle there is worked out now, within a 50 ms budget per tick.
void PrecomputeTick()
  {
   ulong t0 = GetMicrosecondCount();
   g_srvOffset = SrvOffset();
   for(int i = 0; i < ArraySize(g_slots); i++)
     {
      if(GetMicrosecondCount() - t0 > 50000) return;
      CSlot *s = g_slots[i];
      if(CheckPointer(s) == POINTER_INVALID || TimeLocal() - s.lastAsked > 600) continue;
      if(!SeriesInfoInteger(s.sym, s.tf, SERIES_SYNCHRONIZED)) continue;
      if(iTime(s.sym, s.tf, 0) == s.t[s.n - 1]) continue;
      GetSlot(s.sym, s.tf, 0);
      for(int ch = CH_MS; ch <= CH_PATTERNS && GetMicrosecondCount() - t0 < 50000; ch++) Chain(s, ch);
     }
   EvictSlots();
  }


//+------------------------------------------------------------------+
//| Step 11.2: MT5 push notification + email on trade open/close/    |
//| error. Real MT5 API -- SendNotification requires push             |
//| notifications enabled with a MetaQuotes ID in the terminal;        |
//| SendMail requires email configured in Tools > Options > Email.     |
//+------------------------------------------------------------------+
// Real gap fixed (user, live: wants the SAME full trade reasoning that reaches Telegram to also
// reach MT5 itself as a real push notification/email, not just the short trade-comment string).
// `fullReasoning` is optional (close/error events currently don't pass one) and, when present, is
// appended to the short `message` -- NOT used in place of it, so the direction/symbol/lots at the
// front of `message` always survive truncation below.
void NotifyTradeEvent(string message, string fullReasoning = "")
  {
   Print("Dave EA: ", message, (StringLen(fullReasoning) > 0 ? " | " + fullReasoning : ""));
   if(EnablePush)
     {
      // Real MT5 constraint: SendNotification's body is capped at ~255 characters by the MetaQuotes
      // push service. That cap is per MESSAGE, not per event -- so instead of cutting the reasoning
      // at 252 chars (the old behaviour, which is exactly the "it just stops at ..." bug), anything
      // longer is split into numbered parts. Part 1 goes out immediately so the trade itself is
      // never delayed; the rest are queued and drained one per OnTimer tick (see DrainPushQueue),
      // which respects the service's real ~2/second rate limit without blocking the EA.
      string combined = StringLen(fullReasoning) > 0 ? message + " - " + fullReasoning : message;
      if(StringLen(combined) <= PUSH_MAX_LEN)
        {
         SendNotification(combined);
        }
      else
        {
         string parts[];
         // Reserve room for the "(i/n) " prefix so a numbered part still fits inside the real cap.
         int n = SplitForPush(combined, PUSH_MAX_LEN - 8, parts);
         for(int i = 0; i < n; i++)
           {
            string numbered = "(" + IntegerToString(i + 1) + "/" + IntegerToString(n) + ") " + parts[i];
            if(i == 0)
               SendNotification(numbered);
            else
               EnqueuePush(numbered);
           }
        }
     }
   if(EnableEmail)
     {
      // Email has no equivalent real length constraint -- send the reasoning in full.
      string emailBody = StringLen(fullReasoning) > 0 ? message + "\n\n" + fullReasoning : message;
      SendMail("Dave EA trade event", emailBody);
     }
  }
//+------------------------------------------------------------------+
