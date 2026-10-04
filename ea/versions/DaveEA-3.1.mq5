//+------------------------------------------------------------------+
//|                                                      DaveEA.mq5   |
//|  Dave's MT5 bridge. Pushes account/positions/pending-orders/      |
//|  heartbeat to Dave's webhook on the same PushSeconds cadence as    |
//|  always, and executes the open/modify/close/delete-pending/       |
//|  analyze instructions that come back in that SAME HTTP response    |
//|  (WebRequest is one-directional -- there is no other way for      |
//|  Dave to reach this EA).                                          |
//|                                                                    |
//|  Item 5 (DAVEMA retirement): this EA now ALSO computes real market |
//|  analysis (trend/momentum/volatility, more endpoints to follow)    |
//|  locally on demand, via the "analyze" command -- DAVEMA (the old   |
//|  external HTTP API) is retired. This is genuinely on-demand, not a |
//|  new streaming channel: the heartbeat cadence above is completely  |
//|  unchanged, analysis only computes when a real "analyze" command   |
//|  actually arrives.                                                 |
//|                                                                    |
//|  Honest architecture note (Part 1 item 10): because WebRequest is  |
//|  one-directional, there is no real way for Dave to force an        |
//|  out-of-cycle push from THIS EA -- "bypass the timer" therefore    |
//|  means Dave-side tools (get_live_state / get_account_balance) read |
//|  the most recently RECEIVED report instantly from dave-ea-bridge's |
//|  already-persisted last-known-state/account-snapshot, rather than  |
//|  waiting for the next PushSeconds tick -- not a live query to MT5. |
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
#define EA_VERSION "3.1"
// Docker-mode file bridge (see UseFileBridge) -- defined up here for the same reason.
#define BRIDGE_DIR "dave_bridge"
#define BRIDGE_TIMEOUT_MS 5000

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
   EventSetTimer(g_pushIntervalSeconds);
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
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
   PushReportAndExecuteCommands();
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
void PushReportAndExecuteCommands()
  {
   string body = BuildReportJson();

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
      ExecuteCommandsFromResponse(bridgeResponse);
      return;
     }

   char result[];
   string resultHeaders;
   string headers = "Content-Type: application/json\r\n";
   ResetLastError();
   int status = WebRequest("POST", WebhookURL, headers, 5000, post, result, resultHeaders);

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
                   "\"digits\":" + IntegerToString(SymbolInfoInteger(psym, SYMBOL_DIGITS)) + "}";
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

string LastResultsJson()
  {
   string r = g_pendingResultsJson;
   g_pendingResultsJson = ""; // reported once, then cleared -- next batch starts fresh
   return r;
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
      EventKillTimer();
      g_pushIntervalSeconds = seconds;
      EventSetTimer(g_pushIntervalSeconds);
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

// Bars for the REQUESTED symbol+timeframe, index 0 = most recent (series order). Bar 0 is the candle
// that is STILL FORMING -- signals that must not flicker are read from bar 1 (the last closed candle).
int      g_anb = 0;
double   g_aO[], g_aH[], g_aL[], g_aC[];
long     g_aV[];
datetime g_aT[];
int      g_aDigits = 5;
double   g_aPoint = 0.00001, g_aPip = 0.0001;
ENUM_TIMEFRAMES g_aTf = PERIOD_M15;
bool     g_fromCache = false;
string   g_aErr = "";   // set by an endpoint that cannot answer (bad input) -- reported as an error

// A per symbol+timeframe cache of the last good series: when a fresh CopyRates() doesn't have enough
// bars yet (MT5 still downloading), the last real series for that exact pair/timeframe is used
// instead of blocking -- and the answer says so (_meta.from_cache).
#define DAVEEA_CACHE_SLOTS 24
string   g_cacheKey[DAVEEA_CACHE_SLOTS];
int      g_cacheNb[DAVEEA_CACHE_SLOTS];
double   g_cacheO[DAVEEA_CACHE_SLOTS][DAVEEA_BARS];
double   g_cacheH[DAVEEA_CACHE_SLOTS][DAVEEA_BARS];
double   g_cacheL[DAVEEA_CACHE_SLOTS][DAVEEA_BARS];
double   g_cacheC[DAVEEA_CACHE_SLOTS][DAVEEA_BARS];
long     g_cacheV[DAVEEA_CACHE_SLOTS][DAVEEA_BARS];
datetime g_cacheT[DAVEEA_CACHE_SLOTS][DAVEEA_BARS];
int      g_cacheNextSlot = 0;

int FindCacheSlot(string key)
  {
   for(int i = 0; i < DAVEEA_CACHE_SLOTS; i++)
      if(g_cacheKey[i] == key) return i;
   return -1;
  }

void SaveAnalysisCache(string key)
  {
   int slot = FindCacheSlot(key);
   if(slot < 0)
     {
      slot = g_cacheNextSlot;
      g_cacheNextSlot = (g_cacheNextSlot + 1) % DAVEEA_CACHE_SLOTS;
      g_cacheKey[slot] = key;
     }
   int n = MathMin(g_anb, DAVEEA_BARS);
   g_cacheNb[slot] = n;
   for(int i = 0; i < n; i++)
     {
      g_cacheO[slot][i] = g_aO[i]; g_cacheH[slot][i] = g_aH[i];
      g_cacheL[slot][i] = g_aL[i]; g_cacheC[slot][i] = g_aC[i];
      g_cacheV[slot][i] = g_aV[i]; g_cacheT[slot][i] = g_aT[i];
     }
  }

bool LoadAnalysisCache(string key)
  {
   int slot = FindCacheSlot(key);
   if(slot < 0 || g_cacheNb[slot] <= 0) return false;
   int n = g_cacheNb[slot];
   g_anb = n;
   ArrayResize(g_aO, n); ArrayResize(g_aH, n); ArrayResize(g_aL, n); ArrayResize(g_aC, n);
   ArrayResize(g_aV, n); ArrayResize(g_aT, n);
   for(int i = 0; i < n; i++)
     {
      g_aO[i] = g_cacheO[slot][i]; g_aH[i] = g_cacheH[slot][i];
      g_aL[i] = g_cacheL[slot][i]; g_aC[i] = g_cacheC[slot][i];
      g_aV[i] = g_cacheV[slot][i]; g_aT[i] = g_cacheT[slot][i];
     }
   return true;
  }

void CopySeries(MqlRates &rates[], int copied)
  {
   g_anb = copied;
   ArrayResize(g_aO, copied); ArrayResize(g_aH, copied); ArrayResize(g_aL, copied); ArrayResize(g_aC, copied);
   ArrayResize(g_aV, copied); ArrayResize(g_aT, copied);
   for(int i = 0; i < copied; i++)
     {
      g_aO[i] = rates[i].open; g_aH[i] = rates[i].high; g_aL[i] = rates[i].low; g_aC[i] = rates[i].close;
      g_aV[i] = rates[i].tick_volume; g_aT[i] = rates[i].time;
     }
  }

void SetSymbolInfo(string sym)
  {
   g_aDigits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   g_aPoint  = SymbolInfoDouble(sym, SYMBOL_POINT);
   // Same pip rule as the bot (dave-trading pip-size): 3/5-digit quotes -> 10 points, else 1 point.
   g_aPip    = (g_aDigits == 3 || g_aDigits == 5) ? g_aPoint * 10 : g_aPoint;
   if(g_aPip <= 0) g_aPip = g_aPoint > 0 ? g_aPoint : 0.0001;
  }

// --- Series that are already loaded -------------------------------------------------------------
// In an EA, reading a symbol/timeframe MT5 hasn't loaded yet makes MT5 WAIT for the download. The
// cross-market parts of "all" read up to 28 other pairs on every timeframe, which froze the EA for
// many minutes (live: it stopped reporting and the bot marked it offline until a restart). So a
// series is only read when it's already there; otherwise a background load starts (an indicator
// handle, which never blocks) and this answer leaves that piece out.
// Background loads are started a few per request, not all at once: the container has little
// memory, and asking MT5 for dozens of histories at the same moment got MetaTrader killed.
string g_warmK[];
int g_warmBudget = 4;
bool SeriesReady(string s, ENUM_TIMEFRAMES tf)
  {
   if(s == "") return false;
   if(SeriesInfoInteger(s, tf, SERIES_SYNCHRONIZED)) return true;
   string k = s + "|" + IntegerToString((int)tf);
   for(int i = 0; i < ArraySize(g_warmK); i++) if(g_warmK[i] == k) return false;
   int n = ArraySize(g_warmK);
   if(n < 400 && g_warmBudget > 0)
     {
      g_warmBudget--;
      ArrayResize(g_warmK, n + 1); g_warmK[n] = k;
      iMA(s, tf, 1, 0, MODE_SMA, PRICE_CLOSE); // kept open on purpose: it keeps that history loading/updated
     }
   return false;
  }
// Previous + present: the last good value of every cross-series read is remembered, so when a
// series is momentarily not ready the answer uses the previous value instead of waiting or
// leaving it out -- and the fresh value replaces it the moment it's there.
// Every answer says which parts are previous data (the freshness label's "previous_data"), so the
// bot never mistakes a remembered value for a live one.
string g_prevUsed[];
void NotePrevious(string label)
  {
   string head = StringSubstr(label, 0, StringFind(label, " ("));
   for(int i = 0; i < ArraySize(g_prevUsed); i++) if(StringFind(g_prevUsed[i], head + " (") == 0 || g_prevUsed[i] == label) return;
   A_Push(g_prevUsed, label);
  }
string TfName(ENUM_TIMEFRAMES tf) { string t = EnumToString(tf); StringReplace(t, "PERIOD_", ""); return t; }
string g_lastK[];
double g_lastV[];
datetime g_lastT[];
double LastGood(string k, double v, bool fresh, string label = "")
  {
   int n = ArraySize(g_lastK), i = 0;
   for(; i < n; i++) if(g_lastK[i] == k) break;
   if(fresh && v > 0)
     {
      if(i == n) { ArrayResize(g_lastK, n + 1); ArrayResize(g_lastV, n + 1); ArrayResize(g_lastT, n + 1); g_lastK[n] = k; }
      g_lastV[i] = v; g_lastT[i] = TimeLocal();
      return v;
     }
   if(i == n) return 0;
   if(label != "") NotePrevious(label + " (" + IntegerToString((long)(TimeLocal() - g_lastT[i]) / 60) + " min old)");
   return g_lastV[i];
  }
string XKey(string f, string s, ENUM_TIMEFRAMES tf, int sh) { return f + "|" + s + "|" + IntegerToString((int)tf) + "|" + IntegerToString(sh); }
double xGet(string f, string s, ENUM_TIMEFRAMES tf, int sh)
  {
   bool r = SeriesReady(s, tf);
   double v = 0;
   if(r) v = f == "o" ? iOpen(s, tf, sh) : f == "h" ? iHigh(s, tf, sh) : f == "l" ? iLow(s, tf, sh) : iClose(s, tf, sh);
   return LastGood(XKey(f, s, tf, sh), v, r, s + " " + TfName(tf));
  }
double xOpen(string s, ENUM_TIMEFRAMES tf, int sh)  { return xGet("o", s, tf, sh); }
double xHigh(string s, ENUM_TIMEFRAMES tf, int sh)  { return xGet("h", s, tf, sh); }
double xLow(string s, ENUM_TIMEFRAMES tf, int sh)   { return xGet("l", s, tf, sh); }
double xClose(string s, ENUM_TIMEFRAMES tf, int sh) { return xGet("c", s, tf, sh); }

bool LoadAnalysisSeries(string sym, ENUM_TIMEFRAMES tf)
  {
   string key = sym + "|" + IntegerToString((int)tf);
   g_aTf = tf;
   g_fromCache = false;
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int copied = SeriesReady(sym, tf) ? CopyRates(sym, tf, 0, DAVEEA_BARS, rates) : 0;
   if(copied > 60)
     {
      CopySeries(rates, copied);
      SetSymbolInfo(sym);
      SaveAnalysisCache(key);
      return true;
     }
   if(LoadAnalysisCache(key))
     {
      g_fromCache = true;
      SetSymbolInfo(sym);
      return true;
     }
   // Never loaded before: one bounded wait while MT5 downloads it.
   for(int attempt = 0; attempt < 5 && !SeriesReady(sym, tf); attempt++)
      Sleep(100);
   if(!SeriesReady(sym, tf)) return false;
   copied = CopyRates(sym, tf, 0, DAVEEA_BARS, rates);
   if(copied <= 60) return false;
   CopySeries(rates, copied);
   SetSymbolInfo(sym);
   SaveAnalysisCache(key);
   return true;
  }

// --- JSON helpers ---
string J(string k, string v)          { return "\"" + k + "\":\"" + v + "\""; }
string Js(string k, string v)         { return "\"" + k + "\":\"" + JsonEscape(v) + "\""; }
string Jn(string k, double v, int d=6){ return "\"" + k + "\":" + (MathIsValidNumber(v) ? DoubleToString(v, d) : "null"); }
// A price that may be unavailable (MT5 returns 0 when that history isn't loaded): null, never a fake 0.
string Jp(string k, double v, int d)  { return "\"" + k + "\":" + ((v > 0 && MathIsValidNumber(v)) ? DoubleToString(v, d) : "null"); }
string Ji(string k, long v)           { return "\"" + k + "\":" + IntegerToString(v); }
string Jb(string k, bool v)           { return "\"" + k + "\":" + (v ? "true" : "false"); }
string Jr(string k, string rawJson)   { return "\"" + k + "\":" + rawJson; }
string Jnull(string k)                { return "\"" + k + "\":null"; }
string Obj(string body)               { return "{" + body + "}"; }
string A_Join(string &a[], string sep=",")
  {
   string s = "";
   for(int i = 0; i < ArraySize(a); i++) { if(i > 0) s += sep; s += a[i]; }
   return s;
  }
void A_Push(string &arr[], string v) { int n = ArraySize(arr); ArrayResize(arr, n + 1); arr[n] = v; }
// A real UTC time (TimeGMT) as ISO.
string A_IsoTime(datetime t) { return IsoUtc(t); }
// A broker-server time (bar, deal, calendar) as real UTC ISO.
string A_BarTime(int i) { return SrvToIso(g_aT[i]); }
double A_P(double priceDiff) { return g_aPip > 0 ? priceDiff / g_aPip : 0; }

double A_Pips(string sym, double priceDiff)
  {
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double pip = (digits == 3 || digits == 5) ? point * 10 : point;
   return pip > 0 ? priceDiff / pip : 0;
  }

// --- Time zones (for sessions and ICT times, which are defined in LOCAL market time) -------------
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
// Hours to add to UTC for a zone at a UTC moment, with its real summer-time rules.
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
      // 2am local: 07:00 UTC on the 2nd Sunday of March, 06:00 UTC on the 1st Sunday of November.
      datetime a = MkTime(y, 3, NthSunday(y, 3, 2), 7), b = MkTime(y, 11, NthSunday(y, 11, 1), 6);
      return (utc >= a && utc < b) ? -4 : -5;
     }
   if(zone == TZ_TOKYO) return 9;
   if(zone == TZ_SYDNEY)
     {
      // Summer time ends on the 1st Sunday of April and starts on the 1st Sunday of October (16:00 UTC the day before).
      datetime endA = (datetime)((long)MkTime(y, 4, NthSunday(y, 4, 1), 0) - 8 * 3600);
      datetime startO = (datetime)((long)MkTime(y, 10, NthSunday(y, 10, 1), 0) - 8 * 3600);
      return (utc < endA || utc >= startO) ? 11 : 10;
     }
   return 0;
  }
datetime LocalOf(int zone, datetime utc) { return (datetime)((long)utc + ZoneOffset(zone, utc) * 3600); }
int LocalHour(int zone, datetime utc) { MqlDateTime d; TimeToStruct(LocalOf(zone, utc), d); return d.hour; }
int LocalMinuteOfDay(int zone, datetime utc) { MqlDateTime d; TimeToStruct(LocalOf(zone, utc), d); return d.hour * 60 + d.min; }

// Minutes until a zone's clock next reads startHour:00 (0 never -- if it is exactly now, 24 h).
int MinutesUntilLocal(int zone, int startHour)
  {
   datetime now = TimeGMT();
   long nowL = (long)now;
   long t = nowL - (nowL % 60) + 60;
   for(int k = 0; k < 60 * 48; k++, t += 60)
     {
      MqlDateTime d; TimeToStruct(LocalOf(zone, (datetime)t), d);
      if(d.hour == startHour && d.min == 0) return (int)((t - nowL) / 60);
     }
   return -1;
  }

bool InLocalWindow(int zone, datetime utc, int startH, int endH)
  {
   int h = LocalHour(zone, utc);
   return startH <= endH ? (h >= startH && h < endH) : (h >= startH || h < endH);
  }

// The latest instance of a daily window [startH, endH) in a zone's local time, from M5 bars:
// its high/low/open, when it started (UTC) and whether it is running right now.
bool ZoneWindowRange(string sym, int zone, int startH, int endH, double &hi, double &lo, double &openPx, datetime &startUtc)
  {
   MqlRates r[]; ArraySetAsSeries(r, true);
   hi = 0; lo = 0; openPx = 0; startUtc = 0;
   if(!SeriesReady(sym, PERIOD_M5)) return false;
   int n = CopyRates(sym, PERIOD_M5, 0, 900, r);
   if(n <= 0) return false;
   int found = -1, dayKey = -1;
   for(int i = 0; i < n; i++)
     {
      datetime u = (datetime)((long)r[i].time - g_srvOffset);
      MqlDateTime d; TimeToStruct(LocalOf(zone, u), d);
      bool inW = d.hour >= startH && d.hour < endH;
      int key = d.year * 1000 + d.day_of_year;
      if(found < 0)
        {
         if(!inW) continue;
         found = i; dayKey = key; hi = r[i].high; lo = r[i].low;
        }
      else
        {
         if(!inW || key != dayKey) break;
         hi = MathMax(hi, r[i].high); lo = MathMin(lo, r[i].low);
        }
      openPx = r[i].open; startUtc = u;
     }
   return found >= 0;
  }

// --- Broker symbol names for cross-market reads (EURUSD may be "EURUSDm" on this broker) ----------
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

// % return of a (resolved) symbol over `bars` CLOSED bars; false when that data isn't there.
bool A_SymReturn(string base, ENUM_TIMEFRAMES tf, int bars, double &ret)
  {
   ret = 0;
   string nm = ResolvedName(base);
   if(nm == "") return false;
   double c0 = xClose(nm, tf, 1), cn = xClose(nm, tf, bars + 1);
   if(c0 <= 0 || cn <= 0) return false;
   ret = (c0 - cn) / cn * 100.0;
   return true;
  }

// --- Indicator maths (matching MT5's own indicators) ---
double A_SMA(int period, int shift = 0)
  {
   if(period <= 0 || shift + period > g_anb) return 0;
   double s = 0; for(int i = shift; i < shift + period; i++) s += g_aC[i];
   return s / period;
  }
// EMA over ALL loaded history (seeded with an SMA at the oldest end), so it has settled.
double A_EMA(int period, int shift = 0)
  {
   int span = g_anb - shift;
   if(period <= 0 || span < period) return 0;
   double e = 0;
   for(int i = g_anb - period; i < g_anb; i++) e += g_aC[i];
   e /= period;
   double k = 2.0 / (period + 1.0);
   for(int i = g_anb - period - 1; i >= shift; i--) e = g_aC[i] * k + e * (1 - k);
   return e;
  }
// Smoothed MA (Wilder / MT5 "Smoothed"): SMA seed at the oldest end, then (prev*(n-1)+price)/n.
double A_SMMA(int period, int shift = 0)
  {
   int span = g_anb - shift;
   if(period <= 0 || span < period) return 0;
   double s = 0;
   for(int i = g_anb - period; i < g_anb; i++) s += g_aC[i];
   double smma = s / period;
   for(int i = g_anb - period - 1; i >= shift; i--) smma = (smma * (period - 1) + g_aC[i]) / period;
   return smma;
  }
double A_StdDev(int period, int shift = 0)
  {
   if(shift + period > g_anb) return 0;
   double m = A_SMA(period, shift), s = 0;
   for(int i = shift; i < shift + period; i++) s += MathPow(g_aC[i] - m, 2);
   return MathSqrt(s / period);
  }
double A_TrueRange(int i)
  {
   if(i + 1 >= g_anb) return g_aH[i] - g_aL[i];
   return MathMax(g_aH[i] - g_aL[i], MathMax(MathAbs(g_aH[i] - g_aC[i + 1]), MathAbs(g_aL[i] - g_aC[i + 1])));
  }
// MT5's ATR: a simple average of the true range.
double A_ATR(int period, int shift = 0)
  {
   if(shift + period + 1 > g_anb) return 0;
   double s = 0; for(int i = shift; i < shift + period; i++) s += A_TrueRange(i);
   return s / period;
  }
// Wilder's RSI (what MT5's RSI draws): first average of `period` changes, then smoothed
// (prev*(n-1)+change)/n all the way to `shift`. The old version averaged only the last 14 changes.
double A_RSI(int period, int shift = 0)
  {
   int last = g_anb - 1;
   if(last - shift < period + 1) return 50;
   double ag = 0, al = 0;
   for(int i = last - 1; i >= last - period; i--)
     {
      double d = g_aC[i] - g_aC[i + 1];
      if(d > 0) ag += d; else al -= d;
     }
   ag /= period; al /= period;
   for(int i = last - period - 1; i >= shift; i--)
     {
      double d = g_aC[i] - g_aC[i + 1];
      ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
      al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
     }
   if(al == 0) return ag == 0 ? 50 : 100;
   return 100.0 - 100.0 / (1.0 + ag / al);
  }
double A_MACDMain(int shift) { return A_EMA(12, shift) - A_EMA(26, shift); }
// MT5 MACD: main = EMA12 - EMA26; signal = SIMPLE 9-bar average of main (MT5 help).
void A_MACD(double &main, double &sig, double &hist, int shift = 0)
  {
   main = A_MACDMain(shift);
   double s = 0;
   for(int i = 0; i < 9; i++) s += A_MACDMain(shift + i);
   sig  = s / 9.0;
   hist = main - sig;
  }
// MT5 slow stochastic %K(kP, slowing): sum(close - lowest) / sum(highest - lowest) over `slow` bars.
double A_HighestHigh(int from, int count){ if(from >= g_anb) return 0; double v = g_aH[from]; for(int i = from; i < MathMin(g_anb, from + count); i++) v = MathMax(v, g_aH[i]); return v; }
double A_LowestLow (int from, int count){ if(from >= g_anb) return 0; double v = g_aL[from]; for(int i = from; i < MathMin(g_anb, from + count); i++) v = MathMin(v, g_aL[i]); return v; }
double A_StochK(int kP, int slow, int shift)
  {
   double num = 0, den = 0;
   for(int j = shift; j < shift + slow; j++)
     {
      if(j + kP > g_anb) return 50;
      double hh = A_HighestHigh(j, kP), ll = A_LowestLow(j, kP);
      num += g_aC[j] - ll; den += hh - ll;
     }
   return den > 0 ? num / den * 100.0 : 50;
  }
// 14/3/3 by default (K period, slowing, D period) -- %D = simple average of %K.
void A_Stochastic(int kP, int dP, double &k, double &d, int slow = 3, int shift = 0)
  {
   k = A_StochK(kP, slow, shift);
   double s = 0;
   for(int j = 0; j < dP; j++) s += A_StochK(kP, slow, shift + j);
   d = s / dP;
  }
double A_CCI(int period, int shift = 0)
  {
   if(shift + period + 1 >= g_anb) return 0;
   double m = 0;
   for(int i = shift; i < shift + period; i++) m += (g_aH[i] + g_aL[i] + g_aC[i]) / 3.0;
   m /= period;
   double dev = 0;
   for(int i = shift; i < shift + period; i++) dev += MathAbs((g_aH[i] + g_aL[i] + g_aC[i]) / 3.0 - m);
   dev /= period;
   double tp0 = (g_aH[shift] + g_aL[shift] + g_aC[shift]) / 3.0;
   return dev > 0 ? (tp0 - m) / (0.015 * dev) : 0;
  }
double A_WilliamsR(int period)
  {
   if(period >= g_anb) return -50;
   double hi = A_HighestHigh(0, period), lo = A_LowestLow(0, period);
   return (hi - lo) > 0 ? (hi - g_aC[0]) / (hi - lo) * -100.0 : -50;
  }
// Wilder's ADX with +DI/-DI, run over all loaded history up to `shift`.
bool A_ADXCalc(int p, int shift, double &adx, double &pdi, double &mdi)
  {
   adx = 0; pdi = 0; mdi = 0;
   int last = g_anb - 1;
   if(last - shift < 3 * p) return false;
   double sTR = 0, sP = 0, sM = 0;
   int i = last - 1;
   for(int c = 0; c < p; c++, i--)
     {
      double up = g_aH[i] - g_aH[i + 1], dn = g_aL[i + 1] - g_aL[i];
      sTR += A_TrueRange(i);
      sP  += (up > dn && up > 0) ? up : 0;
      sM  += (dn > up && dn > 0) ? dn : 0;
     }
   double dxSum = 0; int dxN = 0; bool ready = false;
   for(; i >= shift; i--)
     {
      double up = g_aH[i] - g_aH[i + 1], dn = g_aL[i + 1] - g_aL[i];
      sTR = sTR - sTR / p + A_TrueRange(i);
      sP  = sP - sP / p + ((up > dn && up > 0) ? up : 0);
      sM  = sM - sM / p + ((dn > up && dn > 0) ? dn : 0);
      pdi = sTR > 0 ? 100.0 * sP / sTR : 0;
      mdi = sTR > 0 ? 100.0 * sM / sTR : 0;
      double dx = (pdi + mdi) > 0 ? 100.0 * MathAbs(pdi - mdi) / (pdi + mdi) : 0;
      if(!ready) { dxSum += dx; dxN++; if(dxN == p) { adx = dxSum / p; ready = true; } }
      else adx = (adx * (p - 1) + dx) / p;
     }
   return ready;
  }

// --- Swings ---
bool A_IsSwingHigh(int i, int k)
  {
   if(i - k < 0 || i + k >= g_anb) return false;
   for(int j = 1; j <= k; j++) if(g_aH[i] <= g_aH[i - j] || g_aH[i] <= g_aH[i + j]) return false;
   return true;
  }
bool A_IsSwingLow(int i, int k)
  {
   if(i - k < 0 || i + k >= g_anb) return false;
   for(int j = 1; j <= k; j++) if(g_aL[i] >= g_aL[i - j] || g_aL[i] >= g_aL[i + j]) return false;
   return true;
  }
// Most recent first. A swing needs k closed bars on its right, so none of these move once found.
void A_CollectSwings(int k, int maxOut, double &hi[], int &hiBar[], double &lo[], int &loBar[])
  {
   ArrayResize(hi, 0); ArrayResize(lo, 0);
   ArrayResize(hiBar, 0); ArrayResize(loBar, 0);
   for(int i = k + 1; i < g_anb - k && (ArraySize(hi) < maxOut || ArraySize(lo) < maxOut); i++)
     {
      if(ArraySize(hi) < maxOut && A_IsSwingHigh(i, k))
        { int n = ArraySize(hi); ArrayResize(hi, n+1); ArrayResize(hiBar, n+1); hi[n] = g_aH[i]; hiBar[n] = i; }
      if(ArraySize(lo) < maxOut && A_IsSwingLow(i, k))
        { int n = ArraySize(lo); ArrayResize(lo, n+1); ArrayResize(loBar, n+1); lo[n] = g_aL[i]; loBar[n] = i; }
     }
  }
// Alternating high/low pivots in time order (oldest first) -- the zigzag harmonic and Elliott counts
// are read from. Two highs in a row keep the higher one, two lows the lower one.
int A_Zigzag(int k, int maxPts, double &px[], int &bar[], int &typ[])
  {
   double sh[], sl[]; int shB[], slB[];
   A_CollectSwings(k, 40, sh, shB, sl, slB);
   int n = ArraySize(sh) + ArraySize(sl);
   double tp[]; int tb[], tt[];
   ArrayResize(tp, n); ArrayResize(tb, n); ArrayResize(tt, n);
   int m = 0;
   for(int i = 0; i < ArraySize(sh); i++) { tp[m] = sh[i]; tb[m] = shB[i]; tt[m] = 1; m++; }
   for(int i = 0; i < ArraySize(sl); i++) { tp[m] = sl[i]; tb[m] = slB[i]; tt[m] = -1; m++; }
   // oldest first = biggest bar index first
   for(int a = 1; a < m; a++)
     {
      double p = tp[a]; int b = tb[a], t = tt[a]; int j = a - 1;
      while(j >= 0 && tb[j] < b) { tp[j+1] = tp[j]; tb[j+1] = tb[j]; tt[j+1] = tt[j]; j--; }
      tp[j+1] = p; tb[j+1] = b; tt[j+1] = t;
     }
   ArrayResize(px, 0); ArrayResize(bar, 0); ArrayResize(typ, 0);
   for(int a = 0; a < m; a++)
     {
      int c = ArraySize(px);
      if(c > 0 && typ[c - 1] == tt[a])
        {
         if((tt[a] == 1 && tp[a] > px[c - 1]) || (tt[a] == -1 && tp[a] < px[c - 1])) { px[c - 1] = tp[a]; bar[c - 1] = tb[a]; }
         continue;
        }
      ArrayResize(px, c + 1); ArrayResize(bar, c + 1); ArrayResize(typ, c + 1);
      px[c] = tp[a]; bar[c] = tb[a]; typ[c] = tt[a];
     }
   int c = ArraySize(px);
   if(c > maxPts)
     {
      int drop = c - maxPts;
      for(int a = 0; a < maxPts; a++) { px[a] = px[a + drop]; bar[a] = bar[a + drop]; typ[a] = typ[a + drop]; }
      ArrayResize(px, maxPts); ArrayResize(bar, maxPts); ArrayResize(typ, maxPts);
     }
   return ArraySize(px);
  }

// --- Candles ---
string A_Dir(int i)
  {
   double b = g_aC[i] - g_aO[i];
   if(MathAbs(b) < g_aPoint * 0.5) return "NEUTRAL";
   return b > 0 ? "BULL" : "BEAR";
  }
// Was price falling into candle i (last 5 closes before it)?
bool A_PriorDown(int i) { return i + 6 < g_anb && g_aC[i + 1] < g_aC[i + 6]; }
// One strict rule set, used by BOTH the candles and the patterns endpoints.
string A_CandleType(int i)
  {
   double rng = MathMax(g_aH[i] - g_aL[i], g_aPoint);
   double body = MathAbs(g_aC[i] - g_aO[i]);
   double uw = g_aH[i] - MathMax(g_aO[i], g_aC[i]);
   double lw = MathMin(g_aO[i], g_aC[i]) - g_aL[i];
   double br = body / rng;
   if(br <= 0.1)
     {
      if(uw <= 0.1 * rng && lw >= 0.6 * rng) return "DRAGONFLY_DOJI";
      if(lw <= 0.1 * rng && uw >= 0.6 * rng) return "GRAVESTONE_DOJI";
      return "DOJI";
     }
   if(br >= 0.9) return "MARUBOZU";
   double small = MathMax(body * 0.5, 0.1 * rng);
   if(lw >= 2 * body && uw <= small) return A_PriorDown(i) ? "HAMMER" : "HANGING_MAN";
   if(uw >= 2 * body && lw <= small) return A_PriorDown(i) ? "INVERTED_HAMMER" : "SHOOTING_STAR";
   if(br >= 0.7) return "LARGE_BODY";
   if(br < 0.3 && uw > body && lw > body) return "SPINNING_TOP";
   return "NORMAL";
  }

// --- Freshness label that goes on every answer ---
string A_Meta(string sym, string tfStr)
  {
   datetime nowSrv = TimeTradeServer();
   long quoteTime = SymbolInfoInteger(sym, SYMBOL_TIME);
   long qAge = quoteTime > 0 ? (long)nowSrv - quoteTime : -1;
   long barAge = g_anb > 0 ? (long)nowSrv - (long)g_aT[0] : -1;
   bool closed = qAge < 0 || qAge > 600;
   bool behind = !closed && barAge > 3 * PeriodSeconds(g_aTf);
   return Obj(Js("symbol", sym) + "," + J("timeframe", tfStr) + "," + Ji("bars", g_anb) + "," +
              J("last_bar_open_utc", g_anb > 0 ? A_BarTime(0) : "") + "," +
              Jb("last_bar_still_forming", true) + "," +
              Jb("from_cache", g_fromCache) + "," + Ji("quote_age_sec", qAge) + "," +
              Jb("market_likely_closed", closed) + "," + Jb("bars_behind", behind) + "," +
              Jb("limited_history", g_anb < 300) + "," + J("times", "UTC") + "," +
              J("computed_at_utc", A_IsoTime(TimeGMT())) + "," + Ji("broker_utc_offset_min", g_srvOffset / 60) + "," +
              J("ea_version", EA_VERSION) + A_PreviousNote());
  }
string A_PreviousNote()
  {
   string items[];
   if(g_fromCache) A_Push(items, "\"this symbol's own candles (MT5 had not loaded fresh ones)\"");
   for(int i = 0; i < ArraySize(g_prevUsed); i++) A_Push(items, "\"" + JsonEscape(g_prevUsed[i]) + "\"");
   if(ArraySize(items) == 0) return "," + Jr("previous_data", "[]");
   return "," + Jr("previous_data", "[" + A_Join(items) + "]") + "," +
          J("previous_data_note", "these parts use the LAST GOOD values the EA saw, because that data was not loaded in MT5 yet -- treat them as previous data, not live; everything else is live");
  }

// ============================== the endpoints ==============================

//--- trend ---------------------------------------------------------------
string A_Trend(string sym)
  {
   int n200 = MathMin(200, g_anb - 6);
   double ma20 = A_SMA(20), ma50 = A_SMA(50), ma200 = A_SMA(n200);
   double ema9 = A_EMA(9), ema21 = A_EMA(21);
   double ma20p = A_SMA(20, 5), ma50p = A_SMA(50, 5), ma200p = A_SMA(n200, 5);
   // The trader's own trend system: SMMA 6/20/100 drives bias and score (SMA/EMA are context).
   double smma6 = A_SMMA(6), smma20 = A_SMMA(20), smma100 = A_SMMA(100);
   double c = g_aC[0];
   int score = 0;
   if(c > smma6)       score++; else score--;
   if(c > smma20)      score++; else score--;
   if(c > smma100)     score++; else score--;
   if(smma6 > smma20)  score++; else score--;
   if(smma20 > smma100) score++; else score--;
   string bias = score >= 4 ? "STRONG_BULL" : score >= 2 ? "BULL" : score <= -4 ? "STRONG_BEAR" : score <= -2 ? "BEAR" : "NEUTRAL";
   bool allBull = c > ma20 && ma20 > ma50 && ma50 > ma200;
   bool allBear = c < ma20 && ma20 < ma50 && ma50 < ma200;
   bool smmaAllBull = smma100 > 0 && c > smma6 && smma6 > smma20 && smma20 > smma100;
   bool smmaAllBear = smma100 > 0 && c < smma6 && smma6 < smma20 && smma20 < smma100;
   double adx, pdi, mdi; bool adxOk = A_ADXCalc(14, 0, adx, pdi, mdi);
   int d = g_aDigits;
   return "{\"bias\":\"" + bias + "\",\"score\":" + IntegerToString(score) + "," +
          "\"slope_20\":" + DoubleToString(A_Pips(sym, ma20 - ma20p), 2) + "," +
          "\"slope_50\":" + DoubleToString(A_Pips(sym, ma50 - ma50p), 2) + "," +
          "\"ma20\":" + DoubleToString(ma20, d) + ",\"ma50\":" + DoubleToString(ma50, d) + ",\"ma200\":" + DoubleToString(ma200, d) + "," +
          "\"ma200_period_used\":" + IntegerToString(n200) + "," +
          "\"ema9\":" + DoubleToString(ema9, d) + ",\"ema21\":" + DoubleToString(ema21, d) + "," +
          "\"price_vs_ma20\":\"" + (c > ma20 ? "ABOVE" : "BELOW") + "\"," +
          "\"price_vs_ma50\":\"" + (c > ma50 ? "ABOVE" : "BELOW") + "\"," +
          "\"price_vs_ma200\":\"" + (c > ma200 ? "ABOVE" : "BELOW") + "\"," +
          "\"ema9_vs_ema21\":\"" + (ema9 > ema21 ? "ABOVE" : "BELOW") + "\"," +
          "\"ma_rising_20\":" + (ma20 > ma20p ? "true" : "false") + ",\"ma_rising_50\":" + (ma50 > ma50p ? "true" : "false") + "," +
          "\"ma_rising_200\":" + (ma200 > ma200p ? "true" : "false") + "," +
          "\"golden_cross\":" + ((ma50 > ma200 && A_SMA(50, 3) <= A_SMA(n200, 3)) ? "true" : "false") + "," +
          "\"death_cross\":" + ((ma50 < ma200 && A_SMA(50, 3) >= A_SMA(n200, 3)) ? "true" : "false") + "," +
          "\"price_above_all_mas\":" + (allBull ? "true" : "false") + "," +
          "\"ma_alignment\":\"" + (allBull ? "PERFECT_BULL" : allBear ? "PERFECT_BEAR" : "MIXED") + "\"," +
          "\"dist_ma200_pips\":" + DoubleToString(A_Pips(sym, c - ma200), 1) + "," +
          "\"dist_ma50_pips\":" + DoubleToString(A_Pips(sym, c - ma50), 1) + "," +
          "\"smma6\":" + DoubleToString(smma6, d) + ",\"smma20\":" + DoubleToString(smma20, d) + ",\"smma100\":" + DoubleToString(smma100, d) + "," +
          "\"price_vs_smma6\":\"" + (c > smma6 ? "ABOVE" : "BELOW") + "\"," +
          "\"price_vs_smma20\":\"" + (c > smma20 ? "ABOVE" : "BELOW") + "\"," +
          "\"price_vs_smma100\":\"" + (c > smma100 ? "ABOVE" : "BELOW") + "\"," +
          "\"smma_alignment\":\"" + (smmaAllBull ? "PERFECT_BULL" : smmaAllBear ? "PERFECT_BEAR" : "MIXED") + "\"," +
          (adxOk ? Jn("adx", adx, 1) : Jnull("adx")) + "," +
          J("adx_direction", pdi > mdi ? "BULL" : "BEAR") + "}";
  }

//--- momentum ------------------------------------------------------------
string A_Momentum()
  {
   double rsi = A_RSI(14), rsiPrev = A_RSI(14, 1);
   double m, s, h; A_MACD(m, s, h, 0);
   double mP, sP, hP; A_MACD(mP, sP, hP, 1);
   double k, d; A_Stochastic(14, 3, k, d, 3, 0);
   double cci = A_CCI(20), wr = A_WilliamsR(14);
   double roc = g_anb > 10 && g_aC[10] != 0 ? (g_aC[0] - g_aC[10]) / g_aC[10] * 100.0 : 0;
   int bull = 0, bear = 0;
   if(rsi > 50) bull++; else bear++;
   if(h > 0)    bull++; else bear++;
   if(k > d)    bull++; else bear++;
   if(cci > 0)  bull++; else bear++;
   if(wr > -50) bull++; else bear++;
   if(roc > 0)  bull++; else bear++;
   return "{\"rsi\":" + DoubleToString(rsi, 2) + ",\"rsi_prev\":" + DoubleToString(rsiPrev, 2) + "," +
          "\"rsi_method\":\"Wilder (same as MT5 RSI)\"," +
          "\"rsi_zone\":\"" + (rsi > 70 ? "OVERBOUGHT" : rsi < 30 ? "OVERSOLD" : "NEUTRAL") + "\"," +
          "\"rsi_slope\":" + DoubleToString(rsi - rsiPrev, 2) + "," +
          "\"macd_main\":" + DoubleToString(m, 8) + ",\"macd_signal\":" + DoubleToString(s, 8) + ",\"macd_hist\":" + DoubleToString(h, 8) + "," +
          "\"macd_hist_prev\":" + DoubleToString(hP, 8) + "," +
          "\"macd_settings\":\"12,26,9 (signal = simple average, as MT5)\"," +
          "\"macd_dir\":\"" + (h > 0 ? "BULL" : "BEAR") + "\"," +
          "\"macd_above_zero\":" + (m > 0 ? "true" : "false") + "," +
          "\"macd_hist_growing\":" + (MathAbs(h) > MathAbs(hP) ? "true" : "false") + "," +
          "\"stoch_k\":" + DoubleToString(k, 2) + ",\"stoch_d\":" + DoubleToString(d, 2) + "," +
          "\"stoch_settings\":\"14,3,3\"," +
          "\"stoch_zone\":\"" + (k > 80 ? "OVERBOUGHT" : k < 20 ? "OVERSOLD" : "NEUTRAL") + "\"," +
          "\"stoch_cross\":\"" + (k > d ? "BULL" : "BEAR") + "\"," +
          "\"cci\":" + DoubleToString(cci, 2) + ",\"cci_zone\":\"" + (cci > 100 ? "OVERBOUGHT" : cci < -100 ? "OVERSOLD" : "NEUTRAL") + "\"," +
          "\"williams_r\":" + DoubleToString(wr, 2) + ",\"williams_zone\":\"" + (wr > -20 ? "OVERBOUGHT" : wr < -80 ? "OVERSOLD" : "NEUTRAL") + "\"," +
          "\"roc\":" + DoubleToString(roc, 4) + "," +
          "\"momentum_score\":" + IntegerToString(bull - bear) + ",\"max_score\":6," +
          "\"overall_signal\":\"" + (bull > bear ? "BULL" : bull < bear ? "BEAR" : "NEUTRAL") + "\"," +
          "\"bull_signals_count\":" + IntegerToString(bull) + ",\"bear_signals_count\":" + IntegerToString(bear) + "}";
  }

//--- volatility ----------------------------------------------------------
string A_Volatility(string sym)
  {
   double atr = A_ATR(14), atrPrev = A_ATR(14, 5), atrLong = A_ATR(MathMin(50, g_anb - 2));
   double sd = A_StdDev(20), ma20 = A_SMA(20);
   double bbU = ma20 + 2 * sd, bbL = ma20 - 2 * sd;
   double kcU = ma20 + 1.5 * atr, kcL = ma20 - 1.5 * atr;
   double pctB = (bbU - bbL) > 0 ? (g_aC[0] - bbL) / (bbU - bbL) : 0.5;
   int below = 0, total = 0;
   for(int i = 0; i < MathMin(g_anb - 15, 100); i++) { total++; if(A_ATR(14, i) < atr) below++; }
   double pctile = total > 0 ? (double)below / total * 100.0 : 50;
   // Historical volatility = standard deviation of bar-to-bar returns (%), last 10 closed bars.
   double rets[]; ArrayResize(rets, 0);
   for(int i = 1; i <= 10 && i + 1 < g_anb; i++)
     if(g_aC[i + 1] > 0) { int n = ArraySize(rets); ArrayResize(rets, n + 1); rets[n] = MathLog(g_aC[i] / g_aC[i + 1]); }
   double mean = 0; for(int i = 0; i < ArraySize(rets); i++) mean += rets[i];
   double hv = 0;
   if(ArraySize(rets) > 1) { mean /= ArraySize(rets); for(int i = 0; i < ArraySize(rets); i++) hv += MathPow(rets[i] - mean, 2); hv = MathSqrt(hv / (ArraySize(rets) - 1)) * 100.0; }
   int digits = g_aDigits;
   return "{\"atr\":" + DoubleToString(atr, digits) + ",\"atr_pips\":" + DoubleToString(A_Pips(sym, atr), 1) + "," +
          "\"atr_state\":\"" + (atr > atrLong * 1.2 ? "EXPANDING" : atr < atrLong * 0.8 ? "CONTRACTING" : "NORMAL") + "\"," +
          "\"atr_percentile\":" + DoubleToString(pctile, 1) + "," +
          "\"atr_vs_avg\":" + DoubleToString(atrLong > 0 ? atr / atrLong : 1, 3) + "," +
          "\"bb_upper\":" + DoubleToString(bbU, digits) + ",\"bb_mid\":" + DoubleToString(ma20, digits) + ",\"bb_lower\":" + DoubleToString(bbL, digits) + "," +
          "\"bb_width_pips\":" + DoubleToString(A_Pips(sym, bbU - bbL), 1) + "," +
          "\"bb_position\":\"" + (g_aC[0] > bbU ? "ABOVE_UPPER" : g_aC[0] < bbL ? "BELOW_LOWER" : "INSIDE") + "\"," +
          "\"bb_pct_b\":" + DoubleToString(pctB, 3) + "," +
          "\"bb_squeeze\":" + ((bbU < kcU && bbL > kcL) ? "true" : "false") + "," +
          "\"kc_upper\":" + DoubleToString(kcU, digits) + ",\"kc_lower\":" + DoubleToString(kcL, digits) + "," +
          "\"kc_position\":\"" + (g_aC[0] > kcU ? "ABOVE" : g_aC[0] < kcL ? "BELOW" : "INSIDE") + "\"," +
          "\"expanding\":" + (atr > atrPrev ? "true" : "false") + ",\"contracting\":" + (atr < atrPrev ? "true" : "false") + "," +
          "\"historical_vol_10\":" + DoubleToString(hv, 4) + "," +
          "\"historical_vol_note\":\"std-dev of the last 10 bar returns, % per bar\"," +
          "\"regime\":\"" + (pctile > 70 ? "HIGH" : pctile < 30 ? "LOW" : "NORMAL") + "\"}";
  }

//--- price ---------------------------------------------------------------
double A_Hi52(string sym) { if(!SeriesReady(sym, PERIOD_W1)) return 0; double h[]; int n = CopyHigh(sym, PERIOD_W1, 0, 52, h); return n > 0 ? h[ArrayMaximum(h, 0, n)] : 0; }
double A_Lo52(string sym) { if(!SeriesReady(sym, PERIOD_W1)) return 0; double l[]; int n = CopyLow(sym, PERIOD_W1, 0, 52, l); return n > 0 ? l[ArrayMinimum(l, 0, n)] : 0; }
string A_TradeModeName(string sym)
  {
   long m = SymbolInfoInteger(sym, SYMBOL_TRADE_MODE);
   if(m == SYMBOL_TRADE_MODE_DISABLED) return "DISABLED";
   if(m == SYMBOL_TRADE_MODE_LONGONLY) return "LONG_ONLY";
   if(m == SYMBOL_TRADE_MODE_SHORTONLY) return "SHORT_ONLY";
   if(m == SYMBOL_TRADE_MODE_CLOSEONLY) return "CLOSE_ONLY";
   return "FULL";
  }

// Real daily/weekly/monthly figures from MT5's own D1/W1/MN1 candles -- not "the last N bars of
// whatever timeframe was asked for" (on M15 the old "day high" was really the last 6 hours).
string A_Price(string sym)
  {
   MqlTick tk; SymbolInfoTick(sym, tk);
   double bid = tk.bid, ask = tk.ask, mid = (bid + ask) / 2.0;
   double spread = ask - bid;
   double last = bid > 0 ? bid : g_aC[0];
   double dO = xOpen(sym, PERIOD_D1, 0), dH = xHigh(sym, PERIOD_D1, 0), dL = xLow(sym, PERIOD_D1, 0);
   double pdC = xClose(sym, PERIOD_D1, 1), pdO = xOpen(sym, PERIOD_D1, 1), pdH = xHigh(sym, PERIOD_D1, 1), pdL = xLow(sym, PERIOD_D1, 1);
   double wH = xHigh(sym, PERIOD_W1, 0), wL = xLow(sym, PERIOD_W1, 0);
   double mH = xHigh(sym, PERIOD_MN1, 0), mL = xLow(sym, PERIOD_MN1, 0);
   double yH = A_Hi52(sym), yL = A_Lo52(sym);
   int d = g_aDigits;
   string f[];
   A_Push(f, Jn("bid", bid, d));  A_Push(f, Jn("ask", ask, d));
   A_Push(f, Jn("mid", mid, d));
   A_Push(f, J("quote_time_utc", SrvToIso((datetime)tk.time)));
   A_Push(f, Jn("spread_pts", g_aPoint > 0 ? spread / g_aPoint : 0, 1));
   A_Push(f, Jn("spread_pips", A_Pips(sym, spread), 2));
   A_Push(f, Jp("day_open", dO, d));
   A_Push(f, Jp("day_high", dH, d)); A_Push(f, Jp("day_low", dL, d));
   A_Push(f, (dH > 0 && dL > 0) ? Jn("day_range_pips", A_Pips(sym, dH - dL), 1) : Jnull("day_range_pips"));
   A_Push(f, Jp("prev_close", pdC, d)); A_Push(f, Jp("prev_open", pdO, d));
   A_Push(f, Jp("prev_day_high", pdH, d)); A_Push(f, Jp("prev_day_low", pdL, d));
   A_Push(f, pdC > 0 ? Jn("change_pts", g_aPoint > 0 ? (last - pdC) / g_aPoint : 0, 1) : Jnull("change_pts"));
   A_Push(f, pdC > 0 ? Jn("change_pct", (last - pdC) / pdC * 100.0, 4) : Jnull("change_pct"));
   A_Push(f, J("change_vs", "previous day's close"));
   A_Push(f, Jn("prev_bar_close", g_anb > 1 ? g_aC[1] : g_aC[0], d));
   A_Push(f, Jp("week_high", wH, d)); A_Push(f, Jp("week_low", wL, d));
   A_Push(f, (wH > 0 && wL > 0) ? Jn("week_range_pips", A_Pips(sym, wH - wL), 1) : Jnull("week_range_pips"));
   A_Push(f, Jp("month_high", mH, d)); A_Push(f, Jp("month_low", mL, d));
   A_Push(f, Jp("hi_52w", yH, d)); A_Push(f, Jp("lo_52w", yL, d));
   A_Push(f, Ji("digits", g_aDigits));
   A_Push(f, Jn("point", g_aPoint, 8)); A_Push(f, Jn("pip", g_aPip, 8));
   A_Push(f, Jn("tick_value", SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE), 6));
   A_Push(f, Jn("tick_size",  SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE), 8));
   A_Push(f, Jn("swap_long",  SymbolInfoDouble(sym, SYMBOL_SWAP_LONG), 4));
   A_Push(f, Jn("swap_short", SymbolInfoDouble(sym, SYMBOL_SWAP_SHORT), 4));
   A_Push(f, Jn("min_lot",  SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), 2));
   A_Push(f, Jn("max_lot",  SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX), 2));
   A_Push(f, Jn("lot_step", SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP), 2));
   A_Push(f, J("trade_mode", A_TradeModeName(sym)));
   return Obj(A_Join(f));
  }

//--- structure -----------------------------------------------------------
// The most recent CLOSED candle that closed beyond `level`, among the candles AFTER the swing at
// `swingBar` (a candle from before the swing existed can't break it). -1 = none.
int A_BreakBar(double level, int swingBar, bool up)
  {
   int found = -1;
   for(int i = 1; i < swingBar && i < g_anb; i++)
     if((up && g_aC[i] > level) || (!up && g_aC[i] < level)) found = i; // keep the EARLIEST break (the BOS candle)
   return found;
  }

void A_StructureBreak(int k, string &trend, string &bos, int &barsSince, string &choch)
  {
   double sh[], sl[]; int shB[], slB[];
   A_CollectSwings(k, 5, sh, shB, sl, slB);
   trend = "UNKNOWN"; bos = "NONE"; choch = "NONE"; barsSince = -1;
   if(ArraySize(sh) < 2 || ArraySize(sl) < 2) return;
   bool hh = sh[0] > sh[1], hl = sl[0] > sl[1], lh = sh[0] < sh[1], ll = sl[0] < sl[1];
   trend = hh && hl ? "HH_HL" : (lh && ll ? "LH_LL" : (hh && ll ? "HH_LL" : "LH_HL"));
   int bull = A_BreakBar(sh[0], shB[0], true);
   int bear = A_BreakBar(sl[0], slB[0], false);
   if(bull > 0 && (bear < 0 || bull < bear)) { bos = "BULL"; barsSince = bull; }
   else if(bear > 0) { bos = "BEAR"; barsSince = bear; }
   if(bos == "BULL" && trend == "LH_LL") choch = "BULL";
   if(bos == "BEAR" && trend == "HH_HL") choch = "BEAR";
  }

string A_Structure(string sym)
  {
   double sh[], sl[]; int shB[], slB[];
   A_CollectSwings(SwingLookback, 5, sh, shB, sl, slB);
   double swingHigh = ArraySize(sh) > 0 ? sh[0] : A_HighestHigh(1, 50);
   double swingLow  = ArraySize(sl) > 0 ? sl[0] : A_LowestLow(1, 50);
   double prevHigh  = ArraySize(sh) > 1 ? sh[1] : swingHigh;
   double prevLow   = ArraySize(sl) > 1 ? sl[1] : swingLow;
   bool hh = swingHigh > prevHigh, hl = swingLow > prevLow;
   bool lh = swingHigh < prevHigh, ll = swingLow < prevLow;
   // External = the big swings (SwingLookback); internal = the small ones (2 bars each side).
   string trend, bos, choch; int barsSinceBos;
   A_StructureBreak(SwingLookback, trend, bos, barsSinceBos, choch);
   string iTrend, iBos, iChoch; int iBars;
   A_StructureBreak(2, iTrend, iBos, iBars, iChoch);
   if(trend == "UNKNOWN") trend = hh && hl ? "HH_HL" : (lh && ll ? "LH_LL" : (hh && ll ? "HH_LL" : "LH_HL"));
   string mss = choch;
   // Is the live candle breaking a swing right now? (not final until it closes)
   string breakingNow = g_aC[0] > swingHigh ? "BULL" : g_aC[0] < swingLow ? "BEAR" : "NONE";
   // CISD: the last closed candle closes beyond the OPEN of the whole run of opposite candles before it.
   string cisd = "NONE";
   if(g_anb > 6)
     {
      int j = 2; while(j < g_anb - 1 && g_aC[j] < g_aO[j]) j++;
      if(j > 2 && g_aC[1] > g_aO[j - 1]) cisd = "BULL";
      j = 2; while(j < g_anb - 1 && g_aC[j] > g_aO[j]) j++;
      if(cisd == "NONE" && j > 2 && g_aC[1] < g_aO[j - 1]) cisd = "BEAR";
     }
   double dr_hi = A_HighestHigh(0, 50), dr_lo = A_LowestLow(0, 50);
   double eq    = (dr_hi + dr_lo) / 2.0, rng = dr_hi - dr_lo;
   string pd    = g_aC[0] > eq ? "PREMIUM" : "DISCOUNT";
   // OTE = a 62-79% pullback: for BUYS it sits in the lower part of the leg (discount), for SELLS in
   // the upper part (premium). The old code only ever gave the sell side, unlabelled.
   double oteLongHi = dr_hi - rng * 0.62, oteLongLo = dr_hi - rng * 0.79;
   double oteShortLo = dr_lo + rng * 0.62, oteShortHi = dr_lo + rng * 0.79;
   bool bullish = (trend == "HH_HL" || bos == "BULL");
   string eqH[], eqL[];
   double tol = EqTolerancePips * g_aPip;
   for(int i = 0; i + 1 < ArraySize(sh); i++)
      if(MathAbs(sh[i] - sh[i+1]) <= tol) A_Push(eqH, DoubleToString(sh[i], g_aDigits));
   for(int i = 0; i + 1 < ArraySize(sl); i++)
      if(MathAbs(sl[i] - sl[i+1]) <= tol) A_Push(eqL, DoubleToString(sl[i], g_aDigits));
   string shArr[], slArr[];
   for(int i = 0; i < ArraySize(sh); i++) A_Push(shArr, DoubleToString(sh[i], g_aDigits));
   for(int i = 0; i < ArraySize(sl); i++) A_Push(slArr, DoubleToString(sl[i], g_aDigits));
   double idmLevel = bullish ? (ArraySize(sl) > 0 ? sl[0] : swingLow) : (ArraySize(sh) > 0 ? sh[0] : swingHigh);
   string idm = Obj(Jb("detected", ArraySize(sl) > 1 && ArraySize(sh) > 1) + "," + Jn("level", idmLevel, g_aDigits) + "," +
                    J("type", bullish ? "SSL" : "BSL") + "," + Ji("bar", bullish ? (ArraySize(slB) > 0 ? slB[0] : 0) : (ArraySize(shB) > 0 ? shB[0] : 0)));
   string qml = Obj(Jb("detected", choch != "NONE") + "," + Jn("level", choch == "BULL" ? prevLow : prevHigh, g_aDigits) + "," +
                    J("type", choch));
   double strength = MathMin(100.0, MathAbs(A_Pips(sym, g_aC[0] - eq)) / MathMax(1.0, A_Pips(sym, rng)) * 200.0);
   string f[];
   A_Push(f, J("trend", trend));   A_Push(f, J("bos", bos));   A_Push(f, J("choch", choch));
   A_Push(f, J("mss", mss));       A_Push(f, J("cisd", cisd));
   A_Push(f, J("breaking_now", breakingNow));
   A_Push(f, Jr("idm", idm));      A_Push(f, Jr("qml", qml));
   A_Push(f, Jb("hh", hh)); A_Push(f, Jb("hl", hl)); A_Push(f, Jb("lh", lh)); A_Push(f, Jb("ll", ll));
   A_Push(f, Jr("eq_highs", "[" + A_Join(eqH) + "]"));
   A_Push(f, Jr("eq_lows",  "[" + A_Join(eqL) + "]"));
   A_Push(f, Jn("swing_high", swingHigh, g_aDigits)); A_Push(f, Jn("swing_low", swingLow, g_aDigits));
   A_Push(f, Jn("prev_high", prevHigh, g_aDigits));   A_Push(f, Jn("prev_low", prevLow, g_aDigits));
   A_Push(f, Jn("dealing_range_high", dr_hi, g_aDigits));
   A_Push(f, Jn("dealing_range_low",  dr_lo, g_aDigits));
   A_Push(f, Jn("equilibrium", eq, g_aDigits));
   A_Push(f, J("premium_discount", pd));
   A_Push(f, Jn("ote_zone_high", bullish ? oteLongHi : oteShortHi, g_aDigits));
   A_Push(f, Jn("ote_zone_low",  bullish ? oteLongLo : oteShortLo, g_aDigits));
   A_Push(f, J("ote_zone_side", bullish ? "BUY" : "SELL"));
   A_Push(f, Jr("ote_long",  Obj(Jn("high", oteLongHi, g_aDigits) + "," + Jn("low", oteLongLo, g_aDigits))));
   A_Push(f, Jr("ote_short", Obj(Jn("high", oteShortHi, g_aDigits) + "," + Jn("low", oteShortLo, g_aDigits))));
   A_Push(f, Jn("ce", eq, g_aDigits));
   A_Push(f, J("internal_trend", iTrend)); A_Push(f, J("internal_bos", iBos)); A_Push(f, J("internal_choch", iChoch));
   A_Push(f, J("external_bos", bos));
   A_Push(f, Ji("bars_since_bos", barsSinceBos));
   A_Push(f, Jn("trend_strength", strength, 1));
   A_Push(f, Jr("swing_highs_array", "[" + A_Join(shArr) + "]"));
   A_Push(f, Jr("swing_lows_array",  "[" + A_Join(slArr) + "]"));
   return Obj(A_Join(f));
  }

//--- zones (supply / demand + support / resistance) ----------------------
string A_Zones(string sym)
  {
   string sup[], dem[];
   double c = g_aC[0];
   double nsBot = 0, nsTop = 0, nsDist = 1e18, ndBot = 0, ndTop = 0, ndDist = 1e18;
   bool inZone = false; string zoneAt = "NONE";
   double strongestLvl = 0; string strongestType = "NONE"; double strongestScore = -1;
   for(int i = 2; i < MathMin(g_anb - 2, 300) && (ArraySize(sup) < ZoneMax || ArraySize(dem) < ZoneMax); i++)
     {
      double top = g_aH[i], bot = g_aL[i];
      double body = MathAbs(g_aC[i] - g_aO[i]), rng = MathMax(top - bot, g_aPoint);
      double ratio = body / rng;
      bool isSupply = g_aC[i] > g_aO[i] && g_aC[i - 1] < bot;   // last up candle before a drop through it
      bool isDemand = g_aC[i] < g_aO[i] && g_aC[i - 1] > top;   // last down candle before a rally through it
      if(!isSupply && !isDemand) continue;
      if(isSupply && ArraySize(sup) >= ZoneMax) continue;
      if(isDemand && ArraySize(dem) >= ZoneMax) continue;
      // Touches start AFTER the move candle (i-1 is the move itself); counted as separate visits.
      int tests = 0; bool wasIn = false; double deepest = isSupply ? 0 : 1e18; bool broken = false;
      for(int j = i - 2; j >= 0; j--)
        {
         bool touch = isSupply ? (g_aH[j] >= bot) : (g_aL[j] <= top);
         if(touch && !wasIn && j >= 1) tests++;
         wasIn = touch;
         if(isSupply) deepest = MathMax(deepest, g_aH[j]); else deepest = MathMin(deepest, g_aL[j]);
         if(j >= 1 && ((isSupply && g_aC[j] > top) || (isDemand && g_aC[j] < bot))) broken = true;
        }
      double mit = 0;
      if(isSupply && deepest > bot) mit = MathMin(100.0, (deepest - bot) / rng * 100.0);
      if(isDemand && deepest < top) mit = MathMin(100.0, (top - deepest) / rng * 100.0);
      double score = MathMax(0.0, (100.0 - tests * 15.0) * ratio);
      string z = Obj(Jn("top", top, g_aDigits) + "," + Jn("bot", bot, g_aDigits) + "," +
                     Ji("bar", i) + "," + J("time", A_BarTime(i)) + "," + Jb("fresh", tests == 0) + "," + Jn("strength", score, 1) + "," +
                     Ji("tests", tests) + "," + Jn("body_ratio", ratio, 3) + "," + Jn("mitigation_pct", mit, 1) + "," + Jb("broken", broken));
      if(isSupply) A_Push(sup, z); else A_Push(dem, z);
      if(broken) continue; // a zone price has closed through no longer counts
      if(c >= bot && c <= top) { inZone = true; zoneAt = isSupply ? "SUPPLY" : "DEMAND"; }
      if(isSupply && top >= c)
        {
         double dist = MathMax(0.0, bot - c);
         if(dist < nsDist) { nsDist = dist; nsBot = bot; nsTop = top; }
        }
      if(isDemand && bot <= c)
        {
         double dist = MathMax(0.0, c - top);
         if(dist < ndDist) { ndDist = dist; ndBot = bot; ndTop = top; }
        }
      if(score > strongestScore) { strongestScore = score; strongestLvl = (top + bot) / 2; strongestType = isSupply ? "SUPPLY" : "DEMAND"; }
     }
   // Retest read from the last CLOSED candle against the nearest zone.
   string retestQuality = "NONE", retestZoneType = "NONE";
   if(nsBot > 0 && g_aH[1] >= nsBot)
     { retestZoneType = "SUPPLY"; retestQuality = g_aC[1] < nsBot ? "CLEAN_REJECTION" : (g_aC[1] > nsTop ? "BROKEN_THROUGH" : "INSIDE_ZONE"); }
   else if(ndTop > 0 && g_aL[1] <= ndTop)
     { retestZoneType = "DEMAND"; retestQuality = g_aC[1] > ndTop ? "CLEAN_REJECTION" : (g_aC[1] < ndBot ? "BROKEN_THROUGH" : "INSIDE_ZONE"); }
   // Horizontal support/resistance: swing clusters with 2+ touches.
   double sh2[], sl2[]; int sh2B[], sl2B[];
   A_CollectSwings(SwingLookback, 20, sh2, sh2B, sl2, sl2B);
   double srTol = EqTolerancePips * g_aPip;
   double atr = A_ATR(14);
   if(srTol < atr * 0.1) srTol = atr * 0.1; // synthetics/indices: a fixed pip tolerance is far too tight
   string resist[], support[];
   double nearestResistance = 0, nearestSupport = 0;
   // cluster all swing prices
   double all[]; ArrayResize(all, 0);
   for(int i = 0; i < ArraySize(sh2); i++) { int n = ArraySize(all); ArrayResize(all, n + 1); all[n] = sh2[i]; }
   for(int i = 0; i < ArraySize(sl2); i++) { int n = ArraySize(all); ArrayResize(all, n + 1); all[n] = sl2[i]; }
   bool used[]; ArrayResize(used, ArraySize(all));
   for(int u = 0; u < ArraySize(used); u++) used[u] = false;
   for(int i = 0; i < ArraySize(all); i++)
     {
      if(used[i]) continue;
      double sum = 0; int touches = 0;
      for(int j = 0; j < ArraySize(all); j++) if(!used[j] && MathAbs(all[j] - all[i]) <= srTol) { sum += all[j]; touches++; used[j] = true; }
      if(touches < 2) continue;
      double level = sum / touches;
      if(level > c && ArraySize(resist) < ZoneMax)
        {
         A_Push(resist, Obj(Jn("level", level, g_aDigits) + "," + Ji("touches", touches) + "," + Jn("dist_pips", A_Pips(sym, level - c), 1)));
         if(nearestResistance == 0 || level < nearestResistance) nearestResistance = level;
        }
      else if(level <= c && ArraySize(support) < ZoneMax)
        {
         A_Push(support, Obj(Jn("level", level, g_aDigits) + "," + Ji("touches", touches) + "," + Jn("dist_pips", A_Pips(sym, c - level), 1)));
         if(nearestSupport == 0 || level > nearestSupport) nearestSupport = level;
        }
     }
   string f[];
   A_Push(f, Jr("supply", "[" + A_Join(sup) + "]"));
   A_Push(f, Jr("demand", "[" + A_Join(dem) + "]"));
   A_Push(f, Ji("supply_count", ArraySize(sup)));
   A_Push(f, Ji("demand_count", ArraySize(dem)));
   A_Push(f, Jr("nearest_supply", nsBot > 0 ? Obj(Jn("level", nsBot, g_aDigits) + "," + Jn("top", nsTop, g_aDigits) + "," + Jn("dist_pips", A_Pips(sym, nsDist), 1)) : "null"));
   A_Push(f, Jr("nearest_demand", ndTop > 0 ? Obj(Jn("level", ndTop, g_aDigits) + "," + Jn("bot", ndBot, g_aDigits) + "," + Jn("dist_pips", A_Pips(sym, ndDist), 1)) : "null"));
   A_Push(f, Jb("price_in_zone", inZone));
   A_Push(f, J("zone_at_price", zoneAt));
   A_Push(f, Jr("strongest_zone", Obj(J("type", strongestType) + "," + Jn("level", strongestLvl, g_aDigits))));
   A_Push(f, Jr("retest", Obj(J("zone_type", retestZoneType) + "," + J("quality", retestQuality) + "," + J("read_from", "last closed candle"))));
   A_Push(f, Jr("resistance", "[" + A_Join(resist) + "]"));
   A_Push(f, Jr("support", "[" + A_Join(support) + "]"));
   A_Push(f, Jr("nearest_resistance", nearestResistance > 0 ? Obj(Jn("level", nearestResistance, g_aDigits) + "," + Jn("dist_pips", A_Pips(sym, nearestResistance - c), 1)) : "null"));
   A_Push(f, Jr("nearest_support", nearestSupport > 0 ? Obj(Jn("level", nearestSupport, g_aDigits) + "," + Jn("dist_pips", A_Pips(sym, c - nearestSupport), 1)) : "null"));
   return Obj(A_Join(f));
  }

//--- fair value gaps (shared by liquidity + ict) --------------------------
// Confirmed 3-candle gaps only (all three candles closed). For each: filled = price has since traded
// through the whole gap; mitigated = price has at least reached into it; inverted = a candle has
// CLOSED through it (it now works the other way).
int A_Fvgs(int maxOut, int lookback, string &types[], double &tops[], double &bots[], int &bars[], bool &filled[], bool &mitig[], bool &inverted[])
  {
   ArrayResize(types, 0); ArrayResize(tops, 0); ArrayResize(bots, 0); ArrayResize(bars, 0);
   ArrayResize(filled, 0); ArrayResize(mitig, 0); ArrayResize(inverted, 0);
   for(int i = 2; i + 1 < MathMin(g_anb, lookback); i++)
     {
      bool bull = g_aL[i - 1] > g_aH[i + 1];
      bool bear = g_aH[i - 1] < g_aL[i + 1];
      if(!bull && !bear) continue;
      double top = bull ? g_aL[i - 1] : g_aL[i + 1];
      double bot = bull ? g_aH[i + 1] : g_aH[i - 1];
      bool f = false, m = false, inv = false;
      for(int j = i - 2; j >= 0; j--)
        {
         if(bull) { if(g_aL[j] <= top) m = true; if(g_aL[j] <= bot) f = true; if(j >= 1 && g_aC[j] < bot) inv = true; }
         else     { if(g_aH[j] >= bot) m = true; if(g_aH[j] >= top) f = true; if(j >= 1 && g_aC[j] > top) inv = true; }
        }
      int n = ArraySize(types);
      ArrayResize(types, n + 1); ArrayResize(tops, n + 1); ArrayResize(bots, n + 1); ArrayResize(bars, n + 1);
      ArrayResize(filled, n + 1); ArrayResize(mitig, n + 1); ArrayResize(inverted, n + 1);
      types[n] = bull ? "BULL" : "BEAR"; tops[n] = top; bots[n] = bot; bars[n] = i; filled[n] = f; mitig[n] = m; inverted[n] = inv;
      if(n + 1 >= maxOut) break;
     }
   return ArraySize(types);
  }

//--- liquidity -----------------------------------------------------------
string A_Liquidity(string sym)
  {
   double sh[], sl[]; int shB[], slB[];
   A_CollectSwings(SwingLookback, 8, sh, shB, sl, slB);
   double tol = EqTolerancePips * g_aPip;
   double atr = A_ATR(14);
   if(tol < atr * 0.1) tol = atr * 0.1;
   double c = g_aC[0];
   string bsl[], ssl[], eqH[], eqL[], irl[], erl[];
   double nearBsl = 0, nearSsl = 0;
   for(int i = 0; i + 1 < ArraySize(sh); i++)
      if(MathAbs(sh[i] - sh[i+1]) <= tol)
        {
         double lvl = MathMax(sh[i], sh[i+1]);
         A_Push(bsl, Obj(Jn("level", lvl, g_aDigits) + "," + Ji("bar1", shB[i]) + "," + Ji("bar2", shB[i+1]) + "," + Jn("dist_pips", A_Pips(sym, lvl - c), 1)));
         A_Push(eqH, DoubleToString(lvl, g_aDigits));
         if(lvl > c && (nearBsl == 0 || lvl < nearBsl)) nearBsl = lvl;
        }
   for(int i = 0; i + 1 < ArraySize(sl); i++)
      if(MathAbs(sl[i] - sl[i+1]) <= tol)
        {
         double lvl = MathMin(sl[i], sl[i+1]);
         A_Push(ssl, Obj(Jn("level", lvl, g_aDigits) + "," + Ji("bar1", slB[i]) + "," + Ji("bar2", slB[i+1]) + "," + Jn("dist_pips", A_Pips(sym, c - lvl), 1)));
         A_Push(eqL, DoubleToString(lvl, g_aDigits));
         if(lvl < c && (nearSsl == 0 || lvl > nearSsl)) nearSsl = lvl;
        }
   // No equal highs/lows: the nearest single swing above/below still holds stops.
   if(nearBsl == 0) for(int i = 0; i < ArraySize(sh); i++) if(sh[i] > c && (nearBsl == 0 || sh[i] < nearBsl)) nearBsl = sh[i];
   if(nearSsl == 0) for(int i = 0; i < ArraySize(sl); i++) if(sl[i] < c && (nearSsl == 0 || sl[i] > nearSsl)) nearSsl = sl[i];
   // ERL = the range's own high and low; IRL = unfilled fair value gaps inside the range.
   double drHi = A_HighestHigh(0, 50), drLo = A_LowestLow(0, 50);
   A_Push(erl, Obj(Jn("level", drHi, g_aDigits) + "," + J("type", "RANGE_HIGH")));
   A_Push(erl, Obj(Jn("level", drLo, g_aDigits) + "," + J("type", "RANGE_LOW")));
   string ft[]; double fT[], fB[]; int fBar[]; bool fF[], fM[], fI[];
   int nf = A_Fvgs(12, 50, ft, fT, fB, fBar, fF, fM, fI);
   for(int i = 0; i < nf && ArraySize(irl) < 4; i++)
      if(!fF[i]) A_Push(irl, Obj(J("type", "FVG_" + ft[i]) + "," + Jn("top", fT[i], g_aDigits) + "," + Jn("bot", fB[i], g_aDigits) + "," + Ji("bar", fBar[i])));
   // Sweep: a CLOSED candle wicks through a liquidity level and closes back.
   bool bslSwept = false, sslSwept = false;
   string sweepType = "NONE"; double sweepLevel = 0; int sweepBar = -1;
   for(int i = 1; i < MathMin(g_anb, 21); i++)
     {
      for(int s = 0; s < ArraySize(sh); s++)
         if(shB[s] > i && g_aH[i] > sh[s] && g_aC[i] < sh[s] && !bslSwept)
           { bslSwept = true; if(sweepBar < 0) { sweepType = "BSL"; sweepLevel = sh[s]; sweepBar = i; } }
      for(int s = 0; s < ArraySize(sl); s++)
         if(slB[s] > i && g_aL[i] < sl[s] && g_aC[i] > sl[s] && !sslSwept)
           { sslSwept = true; if(sweepBar < 0) { sweepType = "SSL"; sweepLevel = sl[s]; sweepBar = i; } }
      if(bslSwept && sslSwept) break;
     }
   bool voidAbove = false, voidBelow = false;
   for(int i = 0; i < nf; i++) if(!fF[i]) { if(fB[i] > c) voidAbove = true; if(fT[i] < c) voidBelow = true; }
   string f[];
   A_Push(f, Jr("bsl", "[" + A_Join(bsl) + "]"));  A_Push(f, Jr("ssl", "[" + A_Join(ssl) + "]"));
   A_Push(f, Ji("bsl_count", ArraySize(bsl)));   A_Push(f, Ji("ssl_count", ArraySize(ssl)));
   A_Push(f, Jb("bsl_swept", bslSwept));         A_Push(f, Jb("ssl_swept", sslSwept));
   A_Push(f, Jr("nearest_bsl", nearBsl > 0 ? Obj(Jn("level", nearBsl, g_aDigits) + "," + Jn("dist_pips", A_Pips(sym, nearBsl - c), 1)) : "null"));
   A_Push(f, Jr("nearest_ssl", nearSsl > 0 ? Obj(Jn("level", nearSsl, g_aDigits) + "," + Jn("dist_pips", A_Pips(sym, c - nearSsl), 1)) : "null"));
   A_Push(f, Jr("irl", "[" + A_Join(irl) + "]"));  A_Push(f, Jr("erl", "[" + A_Join(erl) + "]"));
   A_Push(f, Jb("liquidity_void_above", voidAbove));
   A_Push(f, Jb("liquidity_void_below", voidBelow));
   A_Push(f, Jr("equal_highs", "[" + A_Join(eqH) + "]"));
   A_Push(f, Jr("equal_lows",  "[" + A_Join(eqL) + "]"));
   A_Push(f, Jr("most_recent_sweep", Obj(J("type", sweepType) + "," + Jn("level", sweepLevel, g_aDigits) + "," + Ji("bar", sweepBar) + "," + J("time", sweepBar > 0 ? A_BarTime(sweepBar) : ""))));
   return Obj(A_Join(f));
  }

//--- volume (MT5 tick volume: forex/synthetics have no real traded volume) --
string A_Volume()
  {
   double cur = (double)g_aV[0], last = g_anb > 1 ? (double)g_aV[1] : cur, a20 = 0, a50 = 0;
   int n20 = MathMin(20, g_anb - 1), n50 = MathMin(50, g_anb - 1);
   for(int i = 1; i <= n20; i++) a20 += (double)g_aV[i]; a20 /= MathMax(1, n20);
   for(int i = 1; i <= n50; i++) a50 += (double)g_aV[i]; a50 /= MathMax(1, n50);
   double bullV = 0, bearV = 0;
   for(int i = 1; i <= n20; i++) { if(g_aC[i] >= g_aO[i]) bullV += (double)g_aV[i]; else bearV += (double)g_aV[i]; }
   double delta = (bullV + bearV) > 0 ? (bullV - bearV) / (bullV + bearV) * 100.0 : 0;
   string lastArr[];
   for(int i = 0; i < MathMin(10, g_anb); i++) A_Push(lastArr, IntegerToString((long)g_aV[i]));
   string f[];
   A_Push(f, J("source", "tick volume (number of price changes), not traded volume"));
   A_Push(f, Jn("current", cur, 0)); A_Push(f, Jn("last_closed", last, 0));
   A_Push(f, Jn("avg_20", a20, 1)); A_Push(f, Jn("avg_50", a50, 1));
   A_Push(f, J("state", last > a20 * 1.5 ? "HIGH" : last < a20 * 0.5 ? "LOW" : "NORMAL"));
   A_Push(f, Jn("vs_avg20", a20 > 0 ? last / a20 : 1, 3));
   A_Push(f, Jb("trending_up", a20 > a50));
   A_Push(f, Jn("bull_vol", bullV, 0)); A_Push(f, Jn("bear_vol", bearV, 0));
   A_Push(f, Jn("delta_pct", delta, 2));
   A_Push(f, J("vol_bias", delta > 10 ? "BULL" : delta < -10 ? "BEAR" : "NEUTRAL"));
   A_Push(f, Jb("vol_spike", last > a20 * 2.0));
   A_Push(f, Jb("vol_climax", last > a50 * 3.0));
   A_Push(f, Jb("rising_price_rising_vol", g_anb > 2 && g_aC[1] > g_aC[2] && last > a20));
   A_Push(f, Jb("rising_price_falling_vol", g_anb > 2 && g_aC[1] > g_aC[2] && last < a20));
   A_Push(f, Jr("last_10", "[" + A_Join(lastArr) + "]"));
   return Obj(A_Join(f));
  }

//--- ichimoku ------------------------------------------------------------
// The cloud is plotted 26 bars AHEAD: the cloud under price today was computed 26 bars ago.
double A_Tenkan(int s) { return (A_HighestHigh(s, 9) + A_LowestLow(s, 9)) / 2.0; }
double A_Kijun(int s)  { return (A_HighestHigh(s, 26) + A_LowestLow(s, 26)) / 2.0; }
double A_SpanA(int s)  { return (A_Tenkan(s) + A_Kijun(s)) / 2.0; }
double A_SpanB(int s)  { return (A_HighestHigh(s, 52) + A_LowestLow(s, 52)) / 2.0; }
string A_Ichimoku()
  {
   if(g_anb < 110) { g_aErr = "not enough history for Ichimoku (needs 110 bars)"; return ""; }
   double tenkan = A_Tenkan(0), kijun = A_Kijun(0);
   double spanA = A_SpanA(26), spanB = A_SpanB(26);          // the cloud under price NOW
   double futA = A_SpanA(0), futB = A_SpanB(0);              // the cloud 26 bars ahead
   double futAPrev = A_SpanA(1), futBPrev = A_SpanB(1);
   double top = MathMax(spanA, spanB), bot = MathMin(spanA, spanB);
   double chikou = g_aC[0];
   double cloudAtChikouA = A_SpanA(52), cloudAtChikouB = A_SpanB(52); // the cloud where the chikou line sits
   double tenkanPrev = A_Tenkan(3), kijunPrev = A_Kijun(3);
   double c = g_aC[0];
   int score = 0;
   if(c > top)           score++;
   if(futA > futB)       score++;
   if(c > tenkan)        score++;
   if(c > kijun)         score++;
   if(chikou > g_aC[26]) score++;
   bool twist = (futA > futB) != (futAPrev > futBPrev);
   double atr = A_ATR(14);
   double chTop = MathMax(cloudAtChikouA, cloudAtChikouB), chBot = MathMin(cloudAtChikouA, cloudAtChikouB);
   string f[];
   A_Push(f, Jn("tenkan", tenkan, g_aDigits)); A_Push(f, Jn("kijun", kijun, g_aDigits));
   A_Push(f, Jn("senkou_a", spanA, g_aDigits)); A_Push(f, Jn("senkou_b", spanB, g_aDigits));
   A_Push(f, Jn("future_senkou_a", futA, g_aDigits)); A_Push(f, Jn("future_senkou_b", futB, g_aDigits));
   A_Push(f, Jn("chikou", chikou, g_aDigits));
   A_Push(f, Jr("cloud", Obj(J("color", spanA > spanB ? "BULL" : "BEAR") + "," +
        Jn("top", top, g_aDigits) + "," + Jn("bottom", bot, g_aDigits) + "," +
        Jn("thickness_pips", A_P(top - bot), 1) + "," + Jb("price_inside", c <= top && c >= bot))));
   A_Push(f, J("future_cloud_color", futA > futB ? "BULL" : "BEAR"));
   A_Push(f, J("price_vs_cloud", c > top ? "ABOVE" : c < bot ? "BELOW" : "INSIDE"));
   A_Push(f, J("price_vs_tenkan", c > tenkan ? "ABOVE" : "BELOW"));
   A_Push(f, J("price_vs_kijun",  c > kijun  ? "ABOVE" : "BELOW"));
   A_Push(f, Jn("tenkan_slope", A_P(tenkan - tenkanPrev), 2));
   A_Push(f, Jn("kijun_slope",  A_P(kijun - kijunPrev), 2));
   A_Push(f, J("chikou_vs_price", chikou > g_aC[26] ? "ABOVE" : "BELOW"));
   A_Push(f, J("chikou_vs_cloud", chikou > chTop ? "ABOVE" : chikou < chBot ? "BELOW" : "INSIDE"));
   A_Push(f, Jb("flat_kijun", MathAbs(kijun - kijunPrev) < g_aPip));
   A_Push(f, Jb("kijun_support", c > kijun && MathAbs(c - kijun) < atr));
   A_Push(f, Jb("kijun_resistance", c < kijun && MathAbs(c - kijun) < atr));
   A_Push(f, Jb("kumo_twist", twist));
   A_Push(f, J("signal", score >= 4 ? "STRONG_BULL" : score == 3 ? "BULL" : score == 1 ? "BEAR" : score == 0 ? "STRONG_BEAR" : "NEUTRAL"));
   A_Push(f, Ji("score", score)); A_Push(f, Ji("max_score", 5));
   A_Push(f, Jn("dist_tenkan_pips", A_P(c - tenkan), 1));
   A_Push(f, Jn("dist_kijun_pips",  A_P(c - kijun), 1));
   A_Push(f, Jb("all_conditions_bull", score == 5));
   A_Push(f, Jb("all_conditions_bear", score == 0));
   return Obj(A_Join(f));
  }

//--- fibonacci -----------------------------------------------------------
string A_Fibonacci(string sym)
  {
   int look = MathMin(100, g_anb - 1);
   double hi = A_HighestHigh(0, look), lo = A_LowestLow(0, look);
   int hiBar = 0, loBar = 0;
   for(int i = look - 1; i >= 0; i--) { if(g_aH[i] == hi) hiBar = i; if(g_aL[i] == lo) loBar = i; }
   bool swingUp = loBar > hiBar;   // the low came first -> the leg went up
   double rng = hi - lo;
   // Retracement levels measured back from the END of the leg (0% = the leg's end).
   double f0   = swingUp ? hi : lo;
   double f100 = swingUp ? lo : hi;
   double ratios[7] = {0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0};
   double px[7];
   for(int i = 0; i < 7; i++) px[i] = f0 + (f100 - f0) * ratios[i];
   double best = 1e18; int bestI = 0;
   for(int i = 0; i < 7; i++) { double dd = MathAbs(g_aC[0] - px[i]); if(dd < best) { best = dd; bestI = i; } }
   // OTE = 62-79% retracement of the leg: after an UP leg it is a BUY zone below the high; after a
   // DOWN leg a SELL zone above the low. (The old code had these two swapped.)
   double oteA = f0 + (f100 - f0) * 0.62, oteB = f0 + (f100 - f0) * 0.79;
   double oteHi = MathMax(oteA, oteB), oteLo = MathMin(oteA, oteB);
   double pos   = rng > 0 ? (g_aC[0] - lo) / rng : 0.5;
   double ma50  = A_SMA(50);
   double atr   = A_ATR(14);
   double dir   = swingUp ? 1 : -1;
   string f[];
   A_Push(f, Jn("high", hi, g_aDigits)); A_Push(f, Jn("low", lo, g_aDigits));
   A_Push(f, Jn("range_pips", A_Pips(sym, rng), 1)); A_Push(f, Jb("swing_up", swingUp));
   A_Push(f, Jn("f0", px[0], g_aDigits));   A_Push(f, Jn("f236", px[1], g_aDigits));
   A_Push(f, Jn("f382", px[2], g_aDigits)); A_Push(f, Jn("f500", px[3], g_aDigits));
   A_Push(f, Jn("f618", px[4], g_aDigits)); A_Push(f, Jn("f786", px[5], g_aDigits));
   A_Push(f, Jn("f100", px[6], g_aDigits));
   // Continuation targets: beyond the leg's end, in its direction.
   A_Push(f, Jn("e127", f0 + dir * rng * 0.272, g_aDigits));
   A_Push(f, Jn("e161", f0 + dir * rng * 0.618, g_aDigits));
   A_Push(f, Jn("e200", f0 + dir * rng * 1.0, g_aDigits));
   A_Push(f, Jn("e261", f0 + dir * rng * 1.618, g_aDigits));
   A_Push(f, J("extensions_are", "continuation targets beyond the leg's end, in the leg's direction"));
   A_Push(f, Jn("nearest_level", ratios[bestI], 3));
   A_Push(f, Jn("nearest_price", px[bestI], g_aDigits));
   A_Push(f, Jn("dist_to_nearest_pips", A_Pips(sym, best), 1));
   A_Push(f, Jn("pos_in_range", pos, 3));
   A_Push(f, J("price_zone", pos > 0.5 ? "PREMIUM" : "DISCOUNT"));
   A_Push(f, Jr("ote", Obj(Jn("high", oteHi, g_aDigits) + "," + Jn("low", oteLo, g_aDigits) + "," + J("side", swingUp ? "BUY" : "SELL"))));
   A_Push(f, Jb("in_ote", g_aC[0] <= oteHi && g_aC[0] >= oteLo));
   A_Push(f, Jn("retracement_depth_pct", rng > 0 ? MathAbs(g_aC[0] - f0) / rng * 100.0 : 0, 2));
   A_Push(f, Jb("confluence_with_ma", MathAbs(px[bestI] - ma50) < atr));
   A_Push(f, Jb("golden_ratio_bounce", MathAbs(g_aC[0] - px[4]) < atr * 0.3));
   return Obj(A_Join(f));
  }

//--- candles -------------------------------------------------------------
// Newest first. Candle 0 is still forming (closed:false, seconds_left); every time is real UTC.
string A_Candles(string sym, int count)
  {
   if(count <= 0) count = 21;
   if(count > 300) count = 300;
   double atr = A_ATR(14, 1); // from closed candles only
   long secsLeft = PeriodSeconds(g_aTf) - ((long)TimeTradeServer() - (long)g_aT[0]);
   if(secsLeft < 0) secsLeft = 0;
   string arr[];
   for(int i = 0; i < MathMin(count, g_anb); i++)
     {
      double body = MathAbs(g_aC[i] - g_aO[i]);
      double rng  = MathMax(g_aH[i] - g_aL[i], g_aPoint);
      double uw   = g_aH[i] - MathMax(g_aO[i], g_aC[i]);
      double lw   = MathMin(g_aO[i], g_aC[i]) - g_aL[i];
      double gap  = (i + 1 < g_anb) ? g_aO[i] - g_aC[i + 1] : 0;
      bool   imb  = (i > 0 && i + 1 < g_anb) && (g_aL[i - 1] > g_aH[i + 1] || g_aH[i - 1] < g_aL[i + 1]);
      string b[];
      A_Push(b, J("t", A_BarTime(i)));
      A_Push(b, Jb("closed", i > 0));
      if(i == 0) A_Push(b, Ji("seconds_left", secsLeft));
      A_Push(b, Jn("o", g_aO[i], g_aDigits)); A_Push(b, Jn("h", g_aH[i], g_aDigits));
      A_Push(b, Jn("l", g_aL[i], g_aDigits)); A_Push(b, Jn("c", g_aC[i], g_aDigits));
      A_Push(b, Ji("v", g_aV[i]));
      A_Push(b, J("d", A_Dir(i)));
      A_Push(b, Jn("body", body, g_aDigits));
      A_Push(b, Jn("upper_wick", uw, g_aDigits)); A_Push(b, Jn("lower_wick", lw, g_aDigits));
      A_Push(b, Jn("body_ratio", body / rng, 3));
      A_Push(b, Jn("wick_ratio", (uw + lw) / rng, 3));
      A_Push(b, Jn("size_pips", A_Pips(sym, rng), 1));
      A_Push(b, Jn("size_vs_atr", atr > 0 ? rng / atr : 0, 3));
      A_Push(b, J("type", A_CandleType(i)));
      A_Push(b, Jn("gap", gap, g_aDigits));
      A_Push(b, J("gap_type", MathAbs(gap) < g_aPip ? "NONE" : gap > 0 ? "UP" : "DOWN"));
      A_Push(b, Jb("is_imbalance", imb));
      // An imbalance centred on candle 1 uses the still-forming candle 0 -- not confirmed yet.
      if(i == 1) A_Push(b, Jb("imbalance_confirmed", false));
      A_Push(arr, Obj(A_Join(b)));
     }
   return Obj(J("order", "newest_first") + "," + J("times", "UTC") + "," + Js("symbol", sym) + "," +
              Jn("atr", atr, g_aDigits) + "," + J("volume_is", "tick volume") + "," +
              Jr("candles", "[" + A_Join(arr) + "]"));
  }

//--- patterns (read from the last CLOSED candles) --------------------------
string A_Patterns()
  {
   int p = 1; // the last closed candle; candle 0 is still forming and would make patterns flicker
   if(g_anb < p + 8) { g_aErr = "not enough history for patterns"; return ""; }
   double rng0 = MathMax(g_aH[p] - g_aL[p], g_aPoint);
   double body0 = MathAbs(g_aC[p] - g_aO[p]), body1 = MathAbs(g_aC[p+1] - g_aO[p+1]), body2 = MathAbs(g_aC[p+2] - g_aO[p+2]);
   double rng2 = MathMax(g_aH[p+2] - g_aL[p+2], g_aPoint);
   bool bull0 = g_aC[p] > g_aO[p], bear0 = g_aC[p] < g_aO[p];
   bool bull1 = g_aC[p+1] > g_aO[p+1], bear1 = g_aC[p+1] < g_aO[p+1];
   bool bull2 = g_aC[p+2] > g_aO[p+2], bear2 = g_aC[p+2] < g_aO[p+2];
   string t0 = A_CandleType(p);
   bool doji = StringFind(t0, "DOJI") >= 0;
   bool hammer = t0 == "HAMMER", hanging = t0 == "HANGING_MAN";
   bool invHammer = t0 == "INVERTED_HAMMER", shooting = t0 == "SHOOTING_STAR";
   bool maru = t0 == "MARUBOZU";
   double uw0 = g_aH[p] - MathMax(g_aO[p], g_aC[p]), lw0 = MathMin(g_aO[p], g_aC[p]) - g_aL[p];
   bool pinbar = (uw0 > rng0 * 0.6) || (lw0 > rng0 * 0.6);
   bool spin = t0 == "SPINNING_TOP";
   double hi0 = MathMax(g_aO[p], g_aC[p]), lo0 = MathMin(g_aO[p], g_aC[p]);
   double hi1 = MathMax(g_aO[p+1], g_aC[p+1]), lo1 = MathMin(g_aO[p+1], g_aC[p+1]);
   bool engulf = body0 > body1 && ((bull0 && bear1) || (bear0 && bull1)) && hi0 >= hi1 && lo0 <= lo1;
   bool harami = body0 < body1 && ((bull0 && bear1) || (bear0 && bull1)) && hi0 <= hi1 && lo0 >= lo1;
   bool haramiX = body0 < body1 && doji && hi0 <= hi1 && lo0 >= lo1;
   double atr = A_ATR(14, 1);
   double tol = MathMax(g_aPip, atr * 0.05);
   bool tweezerTop = bull1 && bear0 && MathAbs(g_aH[p] - g_aH[p+1]) <= tol;
   bool tweezerBot = bear1 && bull0 && MathAbs(g_aL[p] - g_aL[p+1]) <= tol;
   double mid1 = (g_aO[p+1] + g_aC[p+1]) / 2.0;
   bool piercing  = bear1 && bull0 && g_aO[p] <= g_aC[p+1] && g_aC[p] > mid1 && g_aC[p] < g_aO[p+1];
   bool darkcloud = bull1 && bear0 && g_aO[p] >= g_aC[p+1] && g_aC[p] < mid1 && g_aC[p] > g_aO[p+1];
   bool inside  = g_aH[p] < g_aH[p+1] && g_aL[p] > g_aL[p+1];
   bool outside = g_aH[p] > g_aH[p+1] && g_aL[p] < g_aL[p+1];
   double mid2 = (g_aO[p+2] + g_aC[p+2]) / 2.0;
   bool morning = bear2 && body2 >= 0.5 * rng2 && body1 < body2 * 0.3 && bull0 && g_aC[p] > mid2;
   bool evening = bull2 && body2 >= 0.5 * rng2 && body1 < body2 * 0.3 && bear0 && g_aC[p] < mid2;
   bool tws = bull0 && bull1 && bull2 && g_aC[p] > g_aC[p+1] && g_aC[p+1] > g_aC[p+2] &&
              g_aO[p] > g_aO[p+1] && g_aO[p] <= g_aC[p+1] && g_aO[p+1] > g_aO[p+2] && g_aO[p+1] <= g_aC[p+2];
   bool tbc = bear0 && bear1 && bear2 && g_aC[p] < g_aC[p+1] && g_aC[p+1] < g_aC[p+2] &&
              g_aO[p] < g_aO[p+1] && g_aO[p] >= g_aC[p+1] && g_aO[p+1] < g_aO[p+2] && g_aO[p+1] >= g_aC[p+2];
   double hi2 = MathMax(g_aO[p+2], g_aC[p+2]), lo2 = MathMin(g_aO[p+2], g_aC[p+2]);
   bool harami12 = body1 < body2 && hi1 <= hi2 && lo1 >= lo2;
   bool tiu = bear2 && bull1 && harami12 && bull0 && g_aC[p] > g_aO[p+2];
   bool tid = bull2 && bear1 && harami12 && bear0 && g_aC[p] < g_aO[p+2];
   // Institutional candle: big body AND clearly above-average tick volume AND a close near its extreme.
   double volAvg20 = 0; int volN = MathMin(20, g_anb - p - 1);
   for(int i = p + 1; i <= p + volN; i++) volAvg20 += (double)g_aV[i];
   if(volN > 0) volAvg20 /= volN;
   bool bigBody = body0 / rng0 > 0.6;
   bool bigVolume = volAvg20 > 0 && (double)g_aV[p] > volAvg20 * 1.5;
   bool closeNearExtreme = bull0 ? (g_aH[p] - g_aC[p]) / rng0 < 0.2 : (g_aC[p] - g_aL[p]) / rng0 < 0.2;
   bool institutional = bigBody && bigVolume && closeNearExtreme;
   string strongest = "NONE"; string bias = "NEUTRAL"; int reliability = 0;
   if(engulf)  { strongest = bull0 ? "BULLISH_ENGULFING" : "BEARISH_ENGULFING"; bias = bull0 ? "BULL":"BEAR"; reliability = 80; }
   else if(morning) { strongest = "MORNING_STAR"; bias = "BULL"; reliability = 85; }
   else if(evening) { strongest = "EVENING_STAR"; bias = "BEAR"; reliability = 85; }
   else if(tws)     { strongest = "THREE_WHITE_SOLDIERS"; bias = "BULL"; reliability = 78; }
   else if(tbc)     { strongest = "THREE_BLACK_CROWS"; bias = "BEAR"; reliability = 78; }
   else if(tiu)     { strongest = "THREE_INSIDE_UP"; bias = "BULL"; reliability = 70; }
   else if(tid)     { strongest = "THREE_INSIDE_DOWN"; bias = "BEAR"; reliability = 70; }
   else if(piercing){ strongest = "PIERCING_LINE"; bias = "BULL"; reliability = 65; }
   else if(darkcloud){ strongest = "DARK_CLOUD_COVER"; bias = "BEAR"; reliability = 65; }
   else if(hammer)  { strongest = "HAMMER"; bias = "BULL"; reliability = 65; }
   else if(shooting){ strongest = "SHOOTING_STAR"; bias = "BEAR"; reliability = 65; }
   else if(hanging) { strongest = "HANGING_MAN"; bias = "BEAR"; reliability = 55; }
   else if(invHammer){ strongest = "INVERTED_HAMMER"; bias = "BULL"; reliability = 55; }
   else if(tweezerTop){ strongest = "TWEEZER_TOP"; bias = "BEAR"; reliability = 55; }
   else if(tweezerBot){ strongest = "TWEEZER_BOTTOM"; bias = "BULL"; reliability = 55; }
   else if(doji)    { strongest = "DOJI"; bias = "NEUTRAL"; reliability = 40; }
   string single = Obj(Jb("doji", doji) + "," + Jb("hammer", hammer) + "," + Jb("hanging_man", hanging) + "," +
                       Jb("inverted_hammer", invHammer) + "," + Jb("shooting_star", shooting) + "," + Jb("marubozu", maru) + "," +
                       Jb("pin_bar", pinbar) + "," + Jb("spinning_top", spin));
   string dbl = Obj(Jb("engulfing", engulf) + "," + Jb("harami", harami) + "," + Jb("harami_cross", haramiX) + "," +
                    Jb("tweezers", tweezerTop || tweezerBot) + "," + Jb("tweezer_top", tweezerTop) + "," + Jb("tweezer_bottom", tweezerBot) + "," +
                    Jb("piercing_line", piercing) + "," + Jb("dark_cloud_cover", darkcloud) + "," + Jb("inside_bar", inside) + "," + Jb("outside_bar", outside));
   string tri = Obj(Jb("morning_star", morning) + "," + Jb("evening_star", evening) + "," +
                    Jb("three_white_soldiers", tws) + "," + Jb("three_black_crows", tbc) + "," +
                    Jb("three_inside_up", tiu) + "," + Jb("three_inside_down", tid));
   return Obj(J("read_from", "last closed candle") + "," + J("candle_time", A_BarTime(p)) + "," + J("candle_type", t0) + "," +
              Jr("single", single) + "," + Jr("double", dbl) + "," + Jr("triple", tri) + "," +
              J("strongest", strongest) + "," + J("bias", bias) + "," + Ji("reliability", reliability) + "," +
              J("forming_candle_type", A_CandleType(0)) + "," +
              Jr("institutional_candle", Obj(Jb("detected", institutional) + "," + J("direction", institutional ? (bull0 ? "BULL" : "BEAR") : "NONE") + "," +
                   Jb("big_body", bigBody) + "," + Jb("big_volume", bigVolume) + "," + Jb("close_near_extreme", closeNearExtreme))));
  }

//--- ict -----------------------------------------------------------------
// ICT defines its times in NEW YORK local time (with US summer time):
//   killzones: Asian 20:00-00:00, London 02:00-05:00, New York 07:00-10:00, London close 10:00-12:00
//   Silver Bullet: 03-04, 10-11, 14-15 · CBDR: 14:00-20:00 · midnight open: 00:00
string A_NyKillzone(datetime utc)
  {
   int h = LocalHour(TZ_NEWYORK, utc);
   if(h >= 20) return "ASIA";
   if(h >= 2 && h < 5) return "LONDON_OPEN";
   if(h >= 7 && h < 10) return "NY_OPEN";
   if(h >= 10 && h < 12) return "LONDON_CLOSE";
   return "NONE";
  }

bool A_IsFxLike(string sym)
  {
   string base = SymbolInfoString(sym, SYMBOL_CURRENCY_BASE), prof = SymbolInfoString(sym, SYMBOL_CURRENCY_PROFIT);
   return base != "" && prof != "" && base != prof;
  }

string A_Ict(string sym, ENUM_TIMEFRAMES tf)
  {
   double atr = A_ATR(14, 1);
   double c = g_aC[0];
   datetime nowUtc = TimeGMT();
   // Fair value gaps (confirmed ones only; see A_Fvgs).
   string ft[]; double fT[], fB[]; int fBar[]; bool fF[], fM[], fI[];
   int nf = A_Fvgs(8, 80, ft, fT, fB, fBar, fF, fM, fI);
   string fvg[], ifvg[], vi[];
   for(int i = 0; i < nf; i++)
     {
      A_Push(fvg, Obj(J("type", ft[i]) + "," + Jn("top", fT[i], g_aDigits) + "," + Jn("bot", fB[i], g_aDigits) + "," +
                    Jn("ce", (fT[i] + fB[i]) / 2, g_aDigits) + "," + Jb("mitigated", fM[i]) + "," + Jb("filled", fF[i]) + "," +
                    Ji("bar", fBar[i]) + "," + J("time", A_BarTime(fBar[i]))));
      // Inversion FVG: a candle CLOSED through the gap, so it now works the other way.
      if(fI[i]) A_Push(ifvg, Obj(J("type", ft[i] == "BULL" ? "BEAR" : "BULL") + "," + Jn("top", fT[i], g_aDigits) + "," + Jn("bot", fB[i], g_aDigits) + "," + Ji("bar", fBar[i])));
      A_Push(vi, Obj(Jn("gap_pips", A_P(fT[i] - fB[i]), 1) + "," + Ji("bar", fBar[i])));
     }
   // Balanced price range: a bullish and a bearish FVG that overlap.
   bool bpr = false; double bprTop = 0, bprBot = 0;
   for(int a = 0; a < nf && !bpr; a++)
      for(int b = 0; b < nf && !bpr; b++)
         if(ft[a] == "BULL" && ft[b] == "BEAR")
           {
            double top = MathMin(fT[a], fT[b]), bot = MathMax(fB[a], fB[b]);
            if(top > bot) { bpr = true; bprTop = top; bprBot = bot; }
           }
   // Order block: the last opposite candle before a displacement candle (> 0.7 ATR body) that closes beyond it.
   string obType = "NONE"; double obH = 0, obL = 0; int obBar = -1; bool obTested = false;
   for(int i = 3; i < MathMin(g_anb, 60); i++)
     {
      if(g_aC[i] < g_aO[i] && g_aC[i - 1] > g_aH[i] && (g_aC[i-1] - g_aO[i-1]) > atr * 0.7)
        { obType = "BULL"; obH = g_aH[i]; obL = g_aL[i]; obBar = i; break; }
      if(g_aC[i] > g_aO[i] && g_aC[i - 1] < g_aL[i] && (g_aO[i-1] - g_aC[i-1]) > atr * 0.7)
        { obType = "BEAR"; obH = g_aH[i]; obL = g_aL[i]; obBar = i; break; }
     }
   // Tested = price came BACK into it after the displacement candle (i-1 is the move itself).
   if(obBar > 0) for(int j = obBar - 2; j >= 0; j--) if(g_aL[j] <= obH && g_aH[j] >= obL) { obTested = true; break; }
   double obCe = (obH + obL) / 2.0;
   // Breaker: that order block failed -- a candle CLOSED through its far side -- confirmed by the last
   // closed candle closing decisively (>50% body) in the breaker's direction.
   string breakerType = obType == "BULL" ? "BEAR" : obType == "BEAR" ? "BULL" : "NONE";
   bool breakerValid = false;
   if(obBar > 0)
     for(int j = obBar - 2; j >= 1; j--)
       {
        if(obType == "BULL" && g_aC[j] < obL) { breakerValid = true; break; }
        if(obType == "BEAR" && g_aC[j] > obH) { breakerValid = true; break; }
       }
   double body1 = MathAbs(g_aC[1] - g_aO[1]), rng1 = MathMax(g_aH[1] - g_aL[1], g_aPoint);
   bool breakerConfirmed = breakerValid && body1 / rng1 > 0.5 && (breakerType == "BULL" ? g_aC[1] > g_aO[1] : g_aC[1] < g_aO[1]);
   // Sweep: the last closed candle ran the previous 50-candle range's high/low and closed back inside.
   double prevHi = A_HighestHigh(2, 50), prevLo = A_LowestLow(2, 50);
   string sweepType = "NONE"; double sweepLvl = 0;
   if(g_aH[1] > prevHi && g_aC[1] < prevHi) { sweepType = "BSL"; sweepLvl = prevHi; }
   else if(g_aL[1] < prevLo && g_aC[1] > prevLo) { sweepType = "SSL"; sweepLvl = prevLo; }
   string sweepNow = (g_aH[0] > prevHi && c < prevHi) ? "BSL" : (g_aL[0] < prevLo && c > prevLo) ? "SSL" : "NONE";
   double dr_hi = A_HighestHigh(0, 50), dr_lo = A_LowestLow(0, 50), eq = (dr_hi + dr_lo) / 2.0, rng = dr_hi - dr_lo;
   // Sessions in New York time.
   double asiaHi, asiaLo, asiaOpen; datetime asiaStart;
   bool asiaOk = ZoneWindowRange(sym, TZ_NEWYORK, 20, 24, asiaHi, asiaLo, asiaOpen, asiaStart);
   double cbdrHi, cbdrLo, cbdrOpen; datetime cbdrStart;
   bool cbdrOk = ZoneWindowRange(sym, TZ_NEWYORK, 14, 20, cbdrHi, cbdrLo, cbdrOpen, cbdrStart);
   double dayHi, dayLo, midnightOpen; datetime dayStart;
   bool dayOk = ZoneWindowRange(sym, TZ_NEWYORK, 0, 24, dayHi, dayLo, midnightOpen, dayStart);
   int nyH = LocalHour(TZ_NEWYORK, nowUtc);
   string kz = A_NyKillzone(nowUtc);
   bool sb = nyH == 3 || nyH == 10 || nyH == 14;
   string sbName = nyH == 3 ? "LONDON" : nyH == 10 ? "NY_AM" : nyH == 14 ? "NY_PM" : "CLOSED";
   // Judas swing: early in the New York day, price ran the Asian range's high (or low) and is back inside.
   string judas = "NONE";
   if(asiaOk && dayOk && nyH < 12)
     {
      if(dayHi > asiaHi && c < asiaHi) judas = "BEARISH";
      else if(dayLo < asiaLo && c > asiaLo) judas = "BULLISH";
     }
   string amd = (nyH >= 18 || nyH < 2) ? "ACCUMULATION" : nyH < 7 ? "MANIPULATION" : nyH < 17 ? "DISTRIBUTION" : "ROLLOVER";
   string dol = c < eq ? "BSL_ABOVE" : "SSL_BELOW";
   // New day / new week opening gaps: yesterday's close -> today's open, last week's close -> this week's open.
   double dOpen = xOpen(sym, PERIOD_D1, 0), pdClose = xClose(sym, PERIOD_D1, 1);
   double wOpen = xOpen(sym, PERIOD_W1, 0), pwClose = xClose(sym, PERIOD_W1, 1);
   double ndog = (dOpen > 0 && pdClose > 0) ? dOpen - pdClose : 0;
   double nwog = (wOpen > 0 && pwClose > 0) ? wOpen - pwClose : 0;
   string bslArr[], sslArr[];
   double sh[], sl[]; int shB[], slB[]; A_CollectSwings(SwingLookback, 4, sh, shB, sl, slB);
   for(int i = 0; i < ArraySize(sh); i++) if(sh[i] > c) A_Push(bslArr, DoubleToString(sh[i], g_aDigits));
   for(int i = 0; i < ArraySize(sl); i++) if(sl[i] < c) A_Push(sslArr, DoubleToString(sl[i], g_aDigits));
   // SMT: this market makes a new swing high/low while a correlated one (EURUSD) doesn't confirm.
   // Only meaningful for currency pairs and metals.
   bool smtApplicable = A_IsFxLike(sym) && StringFind(sym, "EURUSD") < 0;
   bool smtDetected = false; string smtDir = "NONE";
   if(smtApplicable && ArraySize(sh) > 1 && ArraySize(sl) > 1)
     {
      double euRet;
      if(A_SymReturn("EURUSD", tf, 20, euRet))
        {
         if(sh[0] > sh[1] && euRet <= 0) { smtDetected = true; smtDir = "BEARISH"; }
         else if(sl[0] < sl[1] && euRet >= 0) { smtDetected = true; smtDir = "BULLISH"; }
        }
      else smtApplicable = false;
     }
   string f[];
   A_Push(f, Jr("fvg", "[" + A_Join(fvg) + "]"));
   A_Push(f, Jr("ifvg", "[" + A_Join(ifvg) + "]"));
   A_Push(f, Jr("bpr", Obj(Jb("detected", bpr) + "," + Jn("top", bprTop, g_aDigits) + "," + Jn("bot", bprBot, g_aDigits))));
   A_Push(f, Jr("vi", "[" + A_Join(vi) + "]"));
   A_Push(f, Jr("ob", Obj(J("type", obType) + "," + Jn("high", obH, g_aDigits) + "," + Jn("low", obL, g_aDigits) + "," +
        Jn("ce", obCe, g_aDigits) + "," + Ji("bar", obBar) + "," + J("time", obBar > 0 ? A_BarTime(obBar) : "") + "," +
        Jb("valid", obBar > 0 && !breakerValid) + "," + Jb("tested", obTested))));
   A_Push(f, Jr("breaker", Obj(J("type", breakerValid ? breakerType : "NONE") + "," +
        Jn("high", obH, g_aDigits) + "," + Jn("low", obL, g_aDigits) + "," + Ji("bar", obBar) + "," +
        Jb("valid", breakerValid) + "," + Jb("confirmed", breakerConfirmed))));
   A_Push(f, Jr("sweep", Obj(J("type", sweepType) + "," + Jn("level", sweepLvl, g_aDigits) + "," + Ji("bar", sweepType != "NONE" ? 1 : -1) + "," + J("sweeping_now", sweepNow))));
   A_Push(f, Jr("bsl", "[" + A_Join(bslArr) + "]"));
   A_Push(f, Jr("ssl", "[" + A_Join(sslArr) + "]"));
   A_Push(f, Jr("idm", Obj(Jn("level", ArraySize(sl) > 1 ? sl[1] : dr_lo, g_aDigits) + "," + J("type", "SSL") + "," + Ji("bar", ArraySize(slB) > 1 ? slB[1] : 0))));
   A_Push(f, Jr("ndog", Obj(Jb("detected", MathAbs(ndog) > g_aPip) + "," + Jp("open", dOpen, g_aDigits) + "," +
        Jp("prev_close", pdClose, g_aDigits) + "," + Jn("gap_pips", A_P(ndog), 1))));
   A_Push(f, Jr("nwog", Obj(Jb("detected", MathAbs(nwog) > g_aPip) + "," + Jp("open", wOpen, g_aDigits) + "," +
        Jp("prev_close", pwClose, g_aDigits) + "," + Jn("gap_pips", A_P(nwog), 1))));
   A_Push(f, dayOk ? Jn("midnight_open", midnightOpen, g_aDigits) : Jnull("midnight_open"));
   A_Push(f, dayOk ? J("vs_midnight_open", c > midnightOpen ? "ABOVE" : "BELOW") : Jnull("vs_midnight_open"));
   A_Push(f, Jr("asian_range", asiaOk ? Obj(Jn("high", asiaHi, g_aDigits) + "," + Jn("low", asiaLo, g_aDigits) + "," +
        Jn("range_pips", A_P(asiaHi - asiaLo), 1) + "," + J("started_utc", IsoUtc(asiaStart)) + "," + J("window", "20:00-00:00 New York")) : "null"));
   A_Push(f, J("killzone", kz));
   A_Push(f, J("new_york_time", StringFormat("%02d:%02d", nyH, LocalMinuteOfDay(TZ_NEWYORK, nowUtc) % 60)));
   A_Push(f, Jb("silver_bullet", sb));
   A_Push(f, J("silver_bullet_window", sbName));
   A_Push(f, J("judas_swing", judas));
   A_Push(f, J("amd_phase", amd));
   A_Push(f, Jr("cbdr", Obj(Jb("active", nyH >= 14 && nyH < 20) + "," +
        (cbdrOk ? Jn("high", cbdrHi, g_aDigits) + "," + Jn("low", cbdrLo, g_aDigits) : Jnull("high") + "," + Jnull("low")) + "," + J("window", "14:00-20:00 New York"))));
   A_Push(f, J("dol", dol));
   A_Push(f, J("dol_dir", c < eq ? "UP" : "DOWN"));
   A_Push(f, J("premium_discount", c > eq ? "PREMIUM" : "DISCOUNT"));
   A_Push(f, Jr("ote_long",  Obj(Jn("high", dr_hi - rng * 0.62, g_aDigits) + "," + Jn("low", dr_hi - rng * 0.79, g_aDigits))));
   A_Push(f, Jr("ote_short", Obj(Jn("high", dr_lo + rng * 0.79, g_aDigits) + "," + Jn("low", dr_lo + rng * 0.62, g_aDigits))));
   A_Push(f, Ji("poi_count", nf + (obBar > 0 ? 1 : 0)));
   A_Push(f, Jr("smt", Obj(Jb("applicable", smtApplicable) + "," + Jb("detected", smtDetected) + "," + J("direction", smtDir))));
   return Obj(A_Join(f));
  }

//--- wyckoff (rough rules -- a phase guess, not a full Wyckoff reading) ----
string A_Wyckoff()
  {
   double trHi = A_HighestHigh(1, 50), trLo = A_LowestLow(1, 50);
   double prevHi = A_HighestHigh(51, 50), prevLo = A_LowestLow(51, 50);
   double recentRange = trHi - trLo, prevRange = prevHi - prevLo;
   double avgVol = 0, recVol = 0;
   int n = MathMin(50, g_anb - 1);
   for(int i = 1; i <= n; i++) avgVol += (double)g_aV[i]; avgVol /= MathMax(1, n);
   for(int i = 1; i <= 5; i++) recVol += (double)g_aV[i]; recVol /= 5.0;
   double volRatio = avgVol > 0 ? recVol / avgVol : 1;
   double c = g_aC[1];
   double moved = MathAbs(c - g_aC[MathMin(g_anb - 1, 6)]);
   string phase = "RANGING", sub = "", ev = "NONE", schem = "NEUTRAL";
   bool nearLo = c < trLo + recentRange * 0.25;
   bool nearHi = c > trHi - recentRange * 0.25;
   if(recentRange > prevRange * 1.3)
     {
      bool up = c > (prevHi + prevLo) / 2.0;
      phase = up ? "MARKUP" : "MARKDOWN"; sub = "PHASE_D"; ev = up ? "SOS" : "SOW";
     }
   else if(nearLo && volRatio > 1.3) { phase = "ACCUMULATION"; sub = "PHASE_C"; ev = "SPRING"; schem = "ACCUMULATION"; }
   else if(nearLo)                   { phase = "ACCUMULATION"; sub = "PHASE_B"; ev = "ST"; schem = "ACCUMULATION"; }
   else if(nearHi && volRatio > 1.3) { phase = "DISTRIBUTION"; sub = "PHASE_C"; ev = "UTAD"; schem = "DISTRIBUTION"; }
   else if(nearHi)                   { phase = "DISTRIBUTION"; sub = "PHASE_B"; ev = "UT"; schem = "DISTRIBUTION"; }
   string er = "NEUTRAL";
   if(volRatio > 1.3 && moved < recentRange * 0.15) er = "EFFORT_NO_RESULT";
   else if(volRatio < 0.8 && moved > recentRange * 0.3) er = "RESULT_NO_EFFORT";
   else if(volRatio > 1.1 && moved > recentRange * 0.2) er = "HARMONY";
   string f[];
   A_Push(f, J("method", "rough rules on closed candles and tick volume -- a phase guess"));
   A_Push(f, J("phase", phase)); A_Push(f, J("sub_phase", sub));
   A_Push(f, J("event", ev));    A_Push(f, J("schematic", schem));
   A_Push(f, Jn("avg_vol", avgVol, 1)); A_Push(f, Jn("recent_vol", recVol, 1));
   A_Push(f, Jn("vol_ratio", volRatio, 3));
   A_Push(f, J("effort_result", er));
   A_Push(f, Jn("trading_range_high", trHi, g_aDigits));
   A_Push(f, Jn("trading_range_low",  trLo, g_aDigits));
   A_Push(f, J("breakout_direction", g_aC[0] > trHi ? "UP" : g_aC[0] < trLo ? "DOWN" : "NONE"));
   A_Push(f, Ji("cause_bars", n));
   A_Push(f, Jn("recent_range", A_P(recentRange), 1));
   A_Push(f, Jn("prev_range", A_P(prevRange), 1));
   return Obj(A_Join(f));
  }

//--- divergence (values compared AT the two swing points) ------------------
string A_Divergence()
  {
   double sh[], sl[]; int shB[], slB[];
   A_CollectSwings(SwingLookback, 3, sh, shB, sl, slB);
   bool haveH = ArraySize(sh) > 1, haveL = ArraySize(sl) > 1;
   double rsiNow = A_RSI(14);
   double ph1 = haveH ? sh[0] : 0, ph2 = haveH ? sh[1] : 0;
   double pl1 = haveL ? sl[0] : 0, pl2 = haveL ? sl[1] : 0;
   double rH1 = haveH ? A_RSI(14, shB[0]) : 0, rH2 = haveH ? A_RSI(14, shB[1]) : 0;
   double rL1 = haveL ? A_RSI(14, slB[0]) : 0, rL2 = haveL ? A_RSI(14, slB[1]) : 0;
   double mH1 = haveH ? A_MACDMain(shB[0]) : 0, mH2 = haveH ? A_MACDMain(shB[1]) : 0;
   double mL1 = haveL ? A_MACDMain(slB[0]) : 0, mL2 = haveL ? A_MACDMain(slB[1]) : 0;
   double kH1 = haveH ? A_StochK(14, 3, shB[0]) : 0, kH2 = haveH ? A_StochK(14, 3, shB[1]) : 0;
   double kL1 = haveL ? A_StochK(14, 3, slB[0]) : 0, kL2 = haveL ? A_StochK(14, 3, slB[1]) : 0;
   // Regular: price makes a new extreme, the oscillator doesn't. Hidden: the reverse (continuation).
   bool rsiBear = haveH && ph1 > ph2 && rH1 < rH2;
   bool rsiBull = haveL && pl1 < pl2 && rL1 > rL2;
   bool hidBull = haveL && pl1 > pl2 && rL1 < rL2;
   bool hidBear = haveH && ph1 < ph2 && rH1 > rH2;
   bool macdBear = haveH && ph1 > ph2 && mH1 < mH2;
   bool macdBull = haveL && pl1 < pl2 && mL1 > mL2;
   bool macdHidBull = haveL && pl1 > pl2 && mL1 < mL2;
   bool macdHidBear = haveH && ph1 < ph2 && mH1 > mH2;
   bool stochBull = haveL && pl1 < pl2 && kL1 > kL2;
   bool stochBear = haveH && ph1 > ph2 && kH1 < kH2;
   string strongest = rsiBull ? "RSI_BULL" : rsiBear ? "RSI_BEAR" :
                      macdBull ? "MACD_BULL" : macdBear ? "MACD_BEAR" :
                      hidBull ? "HIDDEN_BULL" : hidBear ? "HIDDEN_BEAR" :
                      stochBull ? "STOCH_BULL" : stochBear ? "STOCH_BEAR" : "NONE";
   // Confirmed: since the latest swing, a closed candle has moved away in the divergence's direction.
   bool bullish = StringFind(strongest, "BULL") >= 0;
   bool confirmed = false;
   if(strongest != "NONE")
     {
      if(bullish && haveL) confirmed = g_aC[1] > g_aH[slB[0]];
      if(!bullish && haveH) confirmed = g_aC[1] < g_aL[shB[0]];
     }
   int barsSince = strongest == "NONE" ? -1 : (bullish ? (haveL ? slB[0] : -1) : (haveH ? shB[0] : -1));
   string f[];
   A_Push(f, Jb("rsi_bull_div", rsiBull)); A_Push(f, Jb("rsi_bear_div", rsiBear));
   A_Push(f, Jb("rsi_hidden_bull", hidBull)); A_Push(f, Jb("rsi_hidden_bear", hidBear));
   A_Push(f, Jb("macd_bull_div", macdBull)); A_Push(f, Jb("macd_bear_div", macdBear));
   A_Push(f, Jb("macd_hidden_bull", macdHidBull)); A_Push(f, Jb("macd_hidden_bear", macdHidBear));
   A_Push(f, Jb("stoch_bull_div", stochBull)); A_Push(f, Jb("stoch_bear_div", stochBear));
   A_Push(f, Jn("price_high1", ph1, g_aDigits)); A_Push(f, Jn("price_high2", ph2, g_aDigits));
   A_Push(f, Jn("price_low1", pl1, g_aDigits));  A_Push(f, Jn("price_low2", pl2, g_aDigits));
   A_Push(f, Jn("rsi_now", rsiNow, 2));
   A_Push(f, Jn("rsi_at_high1", rH1, 2)); A_Push(f, Jn("rsi_at_prev_high", rH2, 2));
   A_Push(f, Jn("rsi_at_low1", rL1, 2));  A_Push(f, Jn("rsi_at_prev_low", rL2, 2));
   A_Push(f, J("strongest", strongest));
   A_Push(f, Jb("confirmed", confirmed));
   A_Push(f, Ji("bars_since_div", barsSince));
   return Obj(A_Join(f));
  }

//--- session ---------------------------------------------------------------
// Local market hours with their real summer-time rules: Sydney 07-16, Tokyo 09-18, London 08-17,
// New York 08-17 (each in its own local time).
string A_Session(string sym)
  {
   datetime now = TimeGMT();
   bool sydney = InLocalWindow(TZ_SYDNEY, now, 7, 16);
   bool tokyo  = InLocalWindow(TZ_TOKYO, now, 9, 18);
   bool london = InLocalWindow(TZ_LONDON, now, 8, 17);
   bool ny     = InLocalWindow(TZ_NEWYORK, now, 8, 17);
   MqlDateTime u; TimeToStruct(now, u);
   // Forex closes from Friday 17:00 to Sunday 17:00 New York time.
   int nyDow; { MqlDateTime nd; TimeToStruct(LocalOf(TZ_NEWYORK, now), nd); nyDow = nd.day_of_week; }
   int nyHour = LocalHour(TZ_NEWYORK, now);
   bool fxWeekend = (nyDow == 6) || (nyDow == 5 && nyHour >= 17) || (nyDow == 0 && nyHour < 17);
   bool overlapLN = london && ny, overlapTL = tokyo && london;
   string cur = overlapLN ? "LONDON_NY" : ny ? "NEW_YORK" : london ? "LONDON" : tokyo ? "TOKYO" : sydney ? "SYDNEY" : "CLOSED";
   // The current (or latest) main session's own high/low and open.
   int zone = ny ? TZ_NEWYORK : london ? TZ_LONDON : tokyo ? TZ_TOKYO : TZ_SYDNEY;
   int sH = zone == TZ_TOKYO ? 9 : zone == TZ_SYDNEY ? 7 : 8, eH = zone == TZ_TOKYO ? 18 : zone == TZ_SYDNEY ? 16 : 17;
   double sHi, sLo, sOpen; datetime sStart;
   bool sOk = ZoneWindowRange(sym, zone, sH, eH, sHi, sLo, sOpen, sStart);
   double aHi, aLo, aOpen; datetime aStart;
   bool aOk = ZoneWindowRange(sym, TZ_TOKYO, 9, 18, aHi, aLo, aOpen, aStart);
   int lh = LocalHour(TZ_LONDON, now), nh = nyHour;
   string f[];
   A_Push(f, J("current", cur));
   A_Push(f, Jb("tokyo", tokyo)); A_Push(f, Jb("london", london));
   A_Push(f, Jb("new_york", ny)); A_Push(f, Jb("sydney", sydney));
   A_Push(f, Jb("overlap", overlapLN || overlapTL)); A_Push(f, J("overlap_type", overlapLN ? "LONDON_NY" : overlapTL ? "TOKYO_LONDON" : "NONE"));
   A_Push(f, Jb("forex_weekend_closed", fxWeekend));
   A_Push(f, Ji("hour_utc", u.hour)); A_Push(f, Ji("min_utc", u.min));
   A_Push(f, J("london_time", StringFormat("%02d:%02d", lh, u.min)));
   A_Push(f, J("new_york_time", StringFormat("%02d:%02d", nh, u.min)));
   A_Push(f, Ji("to_london_min", MinutesUntilLocal(TZ_LONDON, 8)));
   A_Push(f, Ji("to_ny_min", MinutesUntilLocal(TZ_NEWYORK, 8)));
   A_Push(f, Ji("to_tokyo_min", MinutesUntilLocal(TZ_TOKYO, 9)));
   A_Push(f, Ji("to_sydney_min", MinutesUntilLocal(TZ_SYDNEY, 7)));
   A_Push(f, Jb("silver_bullet_window", nh == 3 || nh == 10 || nh == 14));
   A_Push(f, Jb("cbdr_active", nh >= 14 && nh < 20));
   // The opens: London 08:00-10:00 London time, New York 08:00-11:00 New York time.
   A_Push(f, Jb("high_impact_hours", (lh >= 8 && lh < 10) || (nh >= 8 && nh < 11)));
   A_Push(f, sOk ? Jn("session_open_price", sOpen, g_aDigits) : Jnull("session_open_price"));
   A_Push(f, sOk ? Jn("session_high", sHi, g_aDigits) : Jnull("session_high"));
   A_Push(f, sOk ? Jn("session_low", sLo, g_aDigits) : Jnull("session_low"));
   A_Push(f, sOk ? J("session_started_utc", IsoUtc(sStart)) : Jnull("session_started_utc"));
   A_Push(f, aOk ? Jn("asian_range_high", aHi, g_aDigits) : Jnull("asian_range_high"));
   A_Push(f, aOk ? Jn("asian_range_low", aLo, g_aDigits) : Jnull("asian_range_low"));
   A_Push(f, aOk ? Jn("asian_range_pips", A_P(aHi - aLo), 1) : Jnull("asian_range_pips"));
   A_Push(f, J("asian_range_window", "Tokyo session 09:00-18:00 Tokyo time"));
   A_Push(f, Ji("session_time_elapsed_min", sOk && cur != "CLOSED" ? (long)(now - sStart) / 60 : 0));
   return Obj(A_Join(f));
  }

//--- pivots (from real daily/weekly/monthly candles) -----------------------
string A_Pivots(string sym)
  {
   double pdh = xHigh(sym, PERIOD_D1, 1),  pdl = xLow(sym, PERIOD_D1, 1);
   double pdc = xClose(sym, PERIOD_D1, 1), pdo = xOpen(sym, PERIOD_D1, 1);
   double pwh = xHigh(sym, PERIOD_W1, 1),  pwl = xLow(sym, PERIOD_W1, 1);
   double pwc = xClose(sym, PERIOD_W1, 1);
   double pmh = xHigh(sym, PERIOD_MN1, 1), pml = xLow(sym, PERIOD_MN1, 1);
   double pmc = xClose(sym, PERIOD_MN1, 1);
   if(pdh <= 0 || pdl <= 0 || pdc <= 0) { g_aErr = "yesterday's daily candle isn't loaded yet for " + sym; return ""; }
   double rng = pdh - pdl;
   double p  = (pdh + pdl + pdc) / 3.0;
   double r1 = 2 * p - pdl, s1 = 2 * p - pdh;
   double r2 = p + rng,     s2 = p - rng;
   double r3 = pdh + 2 * (p - pdl), s3 = pdl - 2 * (pdh - p);
   double fr1 = p + 0.382 * rng, fs1 = p - 0.382 * rng;
   double fr2 = p + 0.618 * rng, fs2 = p - 0.618 * rng;
   double fr3 = p + 1.000 * rng, fs3 = p - 1.000 * rng;
   double cr1 = pdc + rng * 1.1 / 12, cs1 = pdc - rng * 1.1 / 12;
   double cr2 = pdc + rng * 1.1 / 6,  cs2 = pdc - rng * 1.1 / 6;
   double cr3 = pdc + rng * 1.1 / 4,  cs3 = pdc - rng * 1.1 / 4;
   double cr4 = pdc + rng * 1.1 / 2,  cs4 = pdc - rng * 1.1 / 2;
   bool wOk = pwh > 0 && pwl > 0 && pwc > 0, mOk = pmh > 0 && pml > 0 && pmc > 0;
   double wp = (pwh + pwl + pwc) / 3.0;
   double mp = (pmh + pml + pmc) / 3.0;
   double lv[7]; lv[0]=p; lv[1]=r1; lv[2]=r2; lv[3]=r3; lv[4]=s1; lv[5]=s2; lv[6]=s3;
   string nm[7]; nm[0]="P"; nm[1]="R1"; nm[2]="R2"; nm[3]="R3"; nm[4]="S1"; nm[5]="S2"; nm[6]="S3";
   int bi = 0; double bd = 1e18;
   for(int i = 0; i < 7; i++) { double dd = MathAbs(g_aC[0] - lv[i]); if(dd < bd) { bd = dd; bi = i; } }
   int digits = g_aDigits;
   string f[];
   A_Push(f, Jr("classic", Obj(Jn("p", p, digits) + "," + Jn("r1", r1, digits) + "," + Jn("r2", r2, digits) + "," +
        Jn("r3", r3, digits) + "," + Jn("s1", s1, digits) + "," + Jn("s2", s2, digits) + "," + Jn("s3", s3, digits))));
   A_Push(f, Jr("fibonacci", Obj(Jn("p", p, digits) + "," + Jn("r1", fr1, digits) + "," + Jn("r2", fr2, digits) + "," +
        Jn("r3", fr3, digits) + "," + Jn("s1", fs1, digits) + "," + Jn("s2", fs2, digits) + "," + Jn("s3", fs3, digits))));
   A_Push(f, Jr("camarilla", Obj(Jn("r1", cr1, digits) + "," + Jn("r2", cr2, digits) + "," + Jn("r3", cr3, digits) + "," +
        Jn("r4", cr4, digits) + "," + Jn("s1", cs1, digits) + "," + Jn("s2", cs2, digits) + "," +
        Jn("s3", cs3, digits) + "," + Jn("s4", cs4, digits))));
   A_Push(f, Jr("weekly", wOk ? Obj(Jn("p", wp, digits) + "," + Jn("r1", 2*wp - pwl, digits) + "," +
        Jn("s1", 2*wp - pwh, digits) + "," + Jn("high", pwh, digits) + "," + Jn("low", pwl, digits)) : "null"));
   A_Push(f, Jr("monthly", mOk ? Obj(Jn("p", mp, digits) + "," + Jn("r1", 2*mp - pml, digits) + "," + Jn("s1", 2*mp - pmh, digits)) : "null"));
   A_Push(f, Jn("pdh", pdh, digits)); A_Push(f, Jn("pdl", pdl, digits));
   A_Push(f, Jn("pdc", pdc, digits)); A_Push(f, Jp("pdo", pdo, digits));
   A_Push(f, Jp("pwh", pwh, digits)); A_Push(f, Jp("pwl", pwl, digits));
   A_Push(f, J("nearest_pivot", nm[bi]));
   A_Push(f, Jn("dist_to_nearest_pips", A_P(bd), 1));
   A_Push(f, J("price_vs_pivot", g_aC[0] > p ? "ABOVE" : "BELOW"));
   return Obj(A_Join(f));
  }

//--- levels (round numbers sized to the market) ---------------------------
// EURUSD ~1.08 -> big figure 0.01; USDJPY ~150 -> 1; gold ~2650 -> 10; an index at ~9,000 -> 100.
string A_Levels(string sym)
  {
   double c = g_aC[0];
   double big = c > 0 ? MathPow(10.0, MathFloor(MathLog10(c)) - 2) : g_aPip * 100;
   double half = big / 2.0, quarter = big / 4.0, major = big * 10.0;
   double step = half;
   double nearest = MathRound(c / step) * step;
   double above = MathFloor(c / step) * step + step;
   double below = MathCeil(c / step) * step - step;
   double bigF  = MathRound(c / big) * big;
   double halfF = MathRound(c / half) * half;
   double majF  = MathRound(c / major) * major;
   double hi52 = A_Hi52(sym), lo52 = A_Lo52(sym);
   string nearby[];
   for(int i = -2; i <= 2; i++) A_Push(nearby, DoubleToString(nearest + i * step, g_aDigits));
   string f[];
   A_Push(f, Jn("nearest", nearest, g_aDigits));
   A_Push(f, Jn("above", above, g_aDigits)); A_Push(f, Jn("below", below, g_aDigits));
   A_Push(f, Jn("mid", (above + below) / 2, g_aDigits));
   A_Push(f, Jn("dist_pips", A_P(MathAbs(c - nearest)), 1));
   A_Push(f, Jn("step_size", step, g_aDigits));
   A_Push(f, Jn("big_figure", bigF, g_aDigits));
   A_Push(f, Jn("half_figure", halfF, g_aDigits));
   A_Push(f, Jn("quarter_step", quarter, g_aDigits));
   A_Push(f, Jn("major_level", majF, g_aDigits));
   A_Push(f, Jn("dist_to_big_figure_pips", A_P(MathAbs(c - bigF)), 1));
   A_Push(f, Jn("dist_to_half_figure_pips", A_P(MathAbs(c - halfF)), 1));
   A_Push(f, Jn("psychological_level", bigF, g_aDigits));
   A_Push(f, Jn("magnet_level", MathAbs(c - bigF) < MathAbs(c - halfF) ? bigF : halfF, g_aDigits));
   A_Push(f, Jr("nearby_rounds", "[" + A_Join(nearby) + "]"));
   A_Push(f, Jp("hi_52w", hi52, g_aDigits)); A_Push(f, Jp("lo_52w", lo52, g_aDigits));
   A_Push(f, hi52 > 0 ? Jn("dist_to_52h_pips", A_P(hi52 - c), 1) : Jnull("dist_to_52h_pips"));
   A_Push(f, lo52 > 0 ? Jn("dist_to_52l_pips", A_P(c - lo52), 1) : Jnull("dist_to_52l_pips"));
   return Obj(A_Join(f));
  }

//--- orderflow (ESTIMATED from tick volume and candle colour) ---------------
string A_OrderFlow()
  {
   double buyV = 0, sellV = 0;
   int n = MathMin(20, g_anb - 1);
   for(int i = 1; i <= n; i++) { if(g_aC[i] >= g_aO[i]) buyV += (double)g_aV[i]; else sellV += (double)g_aV[i]; }
   double delta = buyV - sellV;
   int consec = 1; bool up = g_aC[1] >= g_aO[1];
   for(int i = 2; i <= n; i++) { if((g_aC[i] >= g_aO[i]) == up) consec++; else break; }
   double atr = A_ATR(14, 1);
   int absorption = 0;
   double avgV = (buyV + sellV) / MathMax(1, n);
   for(int i = 1; i <= n; i++) if((double)g_aV[i] > avgV * 1.5 && MathAbs(g_aC[i] - g_aO[i]) < atr * 0.3) absorption++;
   double accel = g_anb > 4 ? MathAbs(g_aC[1]-g_aC[2]) - MathAbs(g_aC[3]-g_aC[4]) : 0;
   bool climaxBuy  = g_aC[1] > g_aO[1] && (double)g_aV[1] > avgV * 2.5;
   bool climaxSell = g_aC[1] < g_aO[1] && (double)g_aV[1] > avgV * 2.5;
   bool stopRun = g_anb > 3 && ((g_aH[1] > g_aH[2] && g_aC[1] < g_aC[2]) || (g_aL[1] < g_aL[2] && g_aC[1] > g_aC[2]));
   string f[];
   A_Push(f, J("source", "estimated from tick volume x candle colour -- not real order flow"));
   A_Push(f, Jn("delta", delta, 0));
   A_Push(f, J("bias", delta > 0 ? "BULL" : delta < 0 ? "BEAR" : "NEUTRAL"));
   A_Push(f, Jn("buy_vol", buyV, 0)); A_Push(f, Jn("sell_vol", sellV, 0));
   A_Push(f, Ji("consecutive", consec));
   A_Push(f, J("consecutive_dir", up ? "BULL" : "BEAR"));
   A_Push(f, Ji("absorption_bars", absorption));
   A_Push(f, Jn("momentum_acceleration", A_P(accel), 2));
   A_Push(f, Jb("climax_buy", climaxBuy)); A_Push(f, Jb("climax_sell", climaxSell));
   A_Push(f, Jb("initiative_buyers", delta > 0 && consec >= 3 && up));
   A_Push(f, Jb("initiative_sellers", delta < 0 && consec >= 3 && !up));
   A_Push(f, Jb("responsive_buyers", delta > 0 && g_aC[1] < A_SMA(20, 1)));
   A_Push(f, Jb("responsive_sellers", delta < 0 && g_aC[1] > A_SMA(20, 1)));
   A_Push(f, Jb("stop_run", stopRun));
   A_Push(f, Jb("momentum_ignition", MathAbs(g_aC[1]-g_aO[1]) > atr * 1.5));
   return Obj(A_Join(f));
  }

//--- confluence ------------------------------------------------------------
string A_Confluence(int &outScore, string &outDir)
  {
   double ma20 = A_SMA(20), ma50 = A_SMA(50);
   double rsi = A_RSI(14);
   double m, s, h; A_MACD(m, s, h, 0);
   double adx, pdi, mdi; bool adxOk = A_ADXCalc(14, 0, adx, pdi, mdi);
   int bull = 0, bear = 0;
   int maT = g_aC[0] > ma20 && ma20 > ma50 ? 1 : (g_aC[0] < ma20 && ma20 < ma50 ? -1 : 0);
   int rsiS = rsi > 55 ? 1 : rsi < 45 ? -1 : 0;
   int macdS = h > 0 ? 1 : h < 0 ? -1 : 0;
   // Real ADX: a trend counts only when ADX >= 25, in the direction of the stronger DI.
   int adxS  = (adxOk && adx >= 25) ? (pdi > mdi ? 1 : -1) : 0;
   int paS   = g_aC[1] > g_aO[1] ? 1 : g_aC[1] < g_aO[1] ? -1 : 0; // last closed candle
   int arr[5]; arr[0]=maT; arr[1]=rsiS; arr[2]=macdS; arr[3]=adxS; arr[4]=paS;
   for(int i = 0; i < 5; i++) { if(arr[i] > 0) bull++; else if(arr[i] < 0) bear++; }
   int total = 5;
   int score = (int)MathRound((double)MathMax(bull, bear) / total * 100.0);
   string dir = bull > bear ? "BULL" : bull < bear ? "BEAR" : "NEUTRAL";
   outScore = score; outDir = dir;
   string strength = score >= 80 ? "VERY_STRONG" : score >= 60 ? "STRONG" : score >= 40 ? "MODERATE" : "WEAK";
   string bd = Obj(Ji("ma_trend", maT) + "," + Ji("rsi", rsiS) + "," + Ji("macd", macdS) + "," +
                   Ji("adx_trend", adxS) + "," + Ji("price_action", paS));
   string f[];
   A_Push(f, Ji("score", score)); A_Push(f, J("direction", dir)); A_Push(f, J("strength", strength));
   A_Push(f, Ji("bull_signals", bull)); A_Push(f, Ji("bear_signals", bear));
   A_Push(f, Ji("total_signals", total));
   A_Push(f, Jn("agreement_pct", (double)MathMax(bull, bear) / total * 100.0, 1));
   A_Push(f, J("confidence", score >= 80 ? "HIGH" : score >= 60 ? "MEDIUM" : "LOW"));
   A_Push(f, adxOk ? Jn("adx", adx, 1) : Jnull("adx"));
   A_Push(f, Jr("signal_breakdown", bd));
   return Obj(A_Join(f));
  }

//--- risk_metrics ----------------------------------------------------------
double A_ADR(string sym, int days)
  {
   MqlRates d[]; ArraySetAsSeries(d, true);
   int n = SeriesReady(sym, PERIOD_D1) ? CopyRates(sym, PERIOD_D1, 1, days, d) : 0;
   if(n <= 0) return 0;
   double s = 0; for(int i = 0; i < n; i++) s += d[i].high - d[i].low;
   return s / n;
  }
double A_RoundLots(string sym, double lots)
  {
   double step = SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP), vmax = SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX);
   if(step <= 0) step = 0.01;
   double r = MathFloor(lots / step + 1e-9) * step;
   if(vmax > 0 && r > vmax) r = vmax;
   return NormalizeDouble(r, 2);
  }
string A_RiskMetrics(string sym)
  {
   double atr = A_ATR(14, 1), atrP = A_Pips(sym, atr);
   double spread = A_Pips(sym, SymbolInfoDouble(sym, SYMBOL_ASK) - SymbolInfoDouble(sym, SYMBOL_BID));
   double tickVal = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
   double tickSz  = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   double pipVal  = (tickSz > 0) ? tickVal * (g_aPip / tickSz) : 0;
   double bal = AccountInfoDouble(ACCOUNT_BALANCE);
   double adr = A_ADR(sym, 14), adrP = A_Pips(sym, adr);
   double todayRange = xHigh(sym, PERIOD_D1, 0) - xLow(sym, PERIOD_D1, 0);
   double sl2 = atrP * 2.0;
   double vmin = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);
   double raw1 = (pipVal > 0 && sl2 > 0) ? (bal * 0.01) / (sl2 * pipVal) : 0;
   double lot1 = A_RoundLots(sym, raw1), lot2 = A_RoundLots(sym, raw1 * 2);
   string f[];
   A_Push(f, Jn("atr_pips", atrP, 1));
   A_Push(f, Jn("sl_1x_pips", atrP, 1));   A_Push(f, Jn("sl_1_5x_pips", atrP * 1.5, 1));
   A_Push(f, Jn("sl_2x_pips", sl2, 1));    A_Push(f, Jn("sl_3x_pips", atrP * 3, 1));
   A_Push(f, Jn("tp_1_5x_pips", atrP * 1.5, 1)); A_Push(f, Jn("tp_2x_pips", atrP * 2, 1));
   A_Push(f, Jn("tp_3x_pips", atrP * 3, 1));     A_Push(f, Jn("tp_5x_pips", atrP * 5, 1));
   A_Push(f, Jn("rr_1_5", 1.5, 2)); A_Push(f, Jn("rr_2", 2.0, 2)); A_Push(f, Jn("rr_3", 3.0, 2));
   A_Push(f, Jn("pip_value", pipVal, 4));
   A_Push(f, J("pip_value_is", "per 1 lot, in the account currency"));
   A_Push(f, Jn("spread_pips", spread, 2));
   A_Push(f, Jn("spread_pct_of_sl", sl2 > 0 ? spread / sl2 * 100.0 : 0, 2));
   A_Push(f, adr > 0 ? Jn("daily_range_pips", adrP, 1) : Jnull("daily_range_pips"));
   A_Push(f, J("daily_range_is", "average of the last 14 full days"));
   A_Push(f, todayRange > 0 ? Jn("today_range_pips", A_Pips(sym, todayRange), 1) : Jnull("today_range_pips"));
   A_Push(f, adr > 0 ? Jn("atr_pct_of_daily_range", atrP / adrP * 100.0, 1) : Jnull("atr_pct_of_daily_range"));
   A_Push(f, Jn("max_recommended_sl_pips", atrP * 3, 1));
   A_Push(f, Jr("position_sizing", Obj(Jn("lot_per_1pct_risk", lot1, 2) + "," + Jn("lot_per_2pct_risk", lot2, 2) + "," +
        J("for_stop_of", "2x ATR") + "," + Jb("below_min_lot", lot1 < vmin) + "," + Jn("min_lot", vmin, 2) + "," +
        J("exact_sizing", "use get_position_size for an exact size from your real entry and stop"))));
   return Obj(A_Join(f));
  }

//--- synthetic (measured from THIS broker's own price feed) ---------------
// Spikes on synthetic indices come from a random generator: the time since the last spike does NOT
// make the next one more likely. So there is no "due"/"overdue" here -- the real, measured spike rate
// on this broker's history gives the chance per candle.
string A_Synthetic(string sym)
  {
   string s = sym; StringToUpper(s);
   string type = "OTHER";
   if(StringFind(s, "BOOM") >= 0) type = "BOOM";
   else if(StringFind(s, "CRASH") >= 0) type = "CRASH";
   else if(StringFind(s, "STORM") >= 0) type = "STORM";
   else if(StringFind(s, "FLAME") >= 0) type = "FLAME";
   else if(StringFind(s, "VOL") >= 0) type = "VOL";
   else if(StringFind(s, "STEP") >= 0) type = "STEP";
   // The FIRST number in the name only ("VOL_10" -> 10, "Volatility 75 (1s)" -> 75).
   int tick = 0; bool inNum = false;
   for(int i = 0; i < StringLen(s); i++)
     {
      ushort ch = StringGetCharacter(s, i);
      if(ch >= '0' && ch <= '9') { tick = tick * 10 + (int)(ch - '0'); inNum = true; }
      else if(inNum) break;
     }
   // A spike = a closed candle whose body is > 4x the typical (median) candle range.
   int n = g_anb - 1;
   double ranges[]; ArrayResize(ranges, n);
   for(int i = 1; i <= n; i++) ranges[i - 1] = g_aH[i] - g_aL[i];
   ArraySort(ranges);
   double median = n > 0 ? ranges[n / 2] : 0;
   double threshold = median * 4.0;
   string spikes[]; int count = 0, up = 0, dn = 0, lastBar = -1;
   double sizeSum = 0;
   for(int i = 1; i <= n && threshold > 0; i++)
     {
      double mv = g_aC[i] - g_aO[i];
      if(MathAbs(mv) <= threshold) continue;
      if(type == "BOOM" && mv < 0) continue;
      if(type == "CRASH" && mv > 0) continue;
      count++; sizeSum += MathAbs(mv);
      if(mv > 0) up++; else dn++;
      if(lastBar < 0) lastBar = i;
      if(ArraySize(spikes) < 5)
         A_Push(spikes, Obj(Ji("bar", i) + "," + J("time", A_BarTime(i)) + "," + J("dir", mv > 0 ? "UP" : "DOWN") + "," + Jn("size_pips", A_Pips(sym, MathAbs(mv)), 1)));
     }
   double perBar = n > 0 ? (double)count / n : 0;              // measured spike rate per candle
   double avgBetween = count > 0 ? (double)n / count : 0;
   double chanceNext = (1.0 - MathExp(-perBar)) * 100.0;
   double chance10 = (1.0 - MathExp(-perBar * 10)) * 100.0;
   double avgRange = 0; int m = MathMin(50, n);
   for(int i = 1; i <= m; i++) avgRange += (g_aH[i] - g_aL[i]); avgRange /= MathMax(1, m);
   double atr = A_ATR(14, 1);
   string f[];
   A_Push(f, J("type", type));
   A_Push(f, Ji("tick_interval_number", tick));
   A_Push(f, J("spike_dir", type == "BOOM" ? "UP" : type == "CRASH" ? "DOWN" : "BOTH"));
   A_Push(f, Ji("bars_measured", n));
   A_Push(f, Ji("spike_count", count));
   A_Push(f, Ji("spikes_up", up)); A_Push(f, Ji("spikes_down", dn));
   A_Push(f, Jn("spikes_per_100_bars", perBar * 100.0, 2));
   A_Push(f, Jn("avg_bars_between", avgBetween, 1));
   A_Push(f, Jn("avg_spike_pips", count > 0 ? A_Pips(sym, sizeSum / count) : 0, 1));
   A_Push(f, Ji("bars_since_spike", lastBar));
   A_Push(f, Jn("spike_chance_next_bar_pct", chanceNext, 1));
   A_Push(f, Jn("spike_chance_next_10_bars_pct", chance10, 1));
   A_Push(f, J("note", "spikes are random: waiting longer does not make one more likely -- the chance per candle stays the same"));
   A_Push(f, J("dominant_dir", g_aC[1] > A_SMA(50, 1) ? "UP" : "DOWN"));
   A_Push(f, J("micro_trend", g_aC[1] > A_SMA(5, 1) ? "UP" : "DOWN"));
   A_Push(f, Jn("spike_threshold", A_Pips(sym, threshold), 1));
   A_Push(f, Jn("avg_candle_range", A_Pips(sym, avgRange), 1));
   A_Push(f, J("volatility_class", atr > avgRange * 1.5 ? "EXTREME" : atr > avgRange ? "HIGH" : "NORMAL"));
   A_Push(f, Jr("recent_spikes", "[" + A_Join(spikes) + "]"));
   return Obj(A_Join(f));
  }

//--- elliott (Elliott's three hard rules on a real zigzag) -----------------
string A_Elliott()
  {
   double px[]; int bar[], typ[];
   int n = A_Zigzag(SwingLookback, 8, px, bar, typ);
   string f[];
   int wave = 0; bool impulse = false; string dir = "NONE"; double target = 0, invalid = 0; string rules = ""; string corr = "NONE";
   // Try the last 6 pivots as waves 0-5, then the last 5 (wave 5 in progress), then 3 (wave 3 in progress).
   for(int len = 6; len >= 3 && wave == 0; len--)
     {
      if(n < len) continue;
      int o = n - len;
      bool up = typ[o] == -1; // starts at a low -> bullish impulse
      double p0 = px[o], p1 = px[o+1], p2 = px[o+2];
      double s = up ? 1 : -1;
      double w1 = s * (p1 - p0);
      bool r2 = s * (p2 - p0) > 0;           // wave 2 never goes past the start of wave 1
      if(w1 <= 0 || !r2) continue;
      if(len == 3)
        {
         // In wave 3 if price is beyond the end of wave 1.
         if(s * (g_aC[0] - p1) > 0) { wave = 3; impulse = true; dir = up ? "BULL" : "BEAR"; target = p2 + s * w1 * 1.618; invalid = p2; rules = "wave2_ok"; }
         continue;
        }
      double p3 = px[o+3];
      double w3 = s * (p3 - p2);
      if(w3 <= 0) continue;
      if(len == 4)
        {
         // Wave 4 in progress (only 4 pivots -- there is no px[o+4]; reading it was an "array out of
         // range" that made MT5 switch the whole EA off). Valid while price stays clear of wave 1's end.
         if(s * (g_aC[0] - p1) > 0) { wave = 4; impulse = true; dir = up ? "BULL" : "BEAR"; target = p3 - s * w3 * 0.382; invalid = p1; rules = "wave2_ok,wave4_no_overlap_so_far"; }
         continue;
        }
      double p4 = px[o+4];
      bool r4 = s * (p4 - p1) > 0;           // wave 4 never overlaps wave 1
      if(!r4) continue;
      if(len == 5)
        {
         if(w3 < w1 && s * (g_aC[0] - p3) <= 0) continue;
         wave = 5; impulse = true; dir = up ? "BULL" : "BEAR"; target = p4 + s * w1; invalid = p4; rules = "wave2_ok,wave4_no_overlap";
         continue;
        }
      double p5 = px[o+5];
      double w5 = s * (p5 - p4);
      bool r3 = !(w3 < w1 && w3 < w5);        // wave 3 is never the shortest
      if(w5 <= 0 || !r3) continue;
      wave = 5; impulse = true; dir = up ? "BULL" : "BEAR"; target = p5 - s * (p5 - p0) * 0.382; invalid = p5;
      rules = "wave2_ok,wave3_not_shortest,wave4_no_overlap"; corr = "ABC_EXPECTED";
     }
   string pts[];
   for(int i = 0; i < n; i++) A_Push(pts, Obj(Jn("price", px[i], g_aDigits) + "," + J("type", typ[i] == 1 ? "HIGH" : "LOW") + "," + Ji("bar", bar[i])));
   A_Push(f, J("method", "zigzag pivots checked against Elliott's 3 rules (wave 2 < start of 1, wave 3 not shortest, wave 4 no overlap with 1)"));
   A_Push(f, Ji("wave", wave)); A_Push(f, Jb("impulse", impulse)); A_Push(f, J("direction", dir));
   A_Push(f, Ji("pivots", n));
   A_Push(f, J("rules_passed", rules));
   A_Push(f, wave > 0 ? Jn("wave_target", target, g_aDigits) : Jnull("wave_target"));
   A_Push(f, wave > 0 ? Jn("wave_invalidation", invalid, g_aDigits) : Jnull("wave_invalidation"));
   A_Push(f, J("correction_type", corr));
   A_Push(f, J("confidence", wave == 0 ? "NONE" : corr != "NONE" ? "MEDIUM" : "LOW"));
   A_Push(f, J("result", wave == 0 ? "no valid Elliott count on this timeframe" : "a count that passes the rules -- one reading, not a certainty"));
   A_Push(f, Jr("pivots_used", "[" + A_Join(pts) + "]"));
   return Obj(A_Join(f));
  }

//--- correlation (real correlation of bar returns) -------------------------
// Pearson correlation of closed-bar returns, matched candle by candle on time.
bool A_CorrWith(string base, ENUM_TIMEFRAMES tf, int want, double &corr, int &pairs)
  {
   corr = 0; pairs = 0;
   string nm = ResolvedName(base);
   if(nm == "") return false;
   string ck = XKey("corr", nm, tf, want);
   if(!SeriesReady(nm, tf))
     {
      // previous answer (stored shifted by +2 so a real 0 or negative correlation is kept)
      double prev = LastGood(ck, 0, false, nm + " " + TfName(tf)), prevN = LastGood(ck + "|n", 0, false);
      if(prev <= 0) return false;
      corr = prev - 2; pairs = (int)prevN;
      return true;
     }
   MqlRates r[]; ArraySetAsSeries(r, true);
   int got = CopyRates(nm, tf, 0, want + 60, r);
   if(got < 20) return false;
   double x[], y[]; ArrayResize(x, 0); ArrayResize(y, 0);
   int j = 0;
   for(int i = 1; i + 1 < g_anb && ArraySize(x) < want; i++)
     {
      while(j < got && r[j].time > g_aT[i]) j++;
      if(j + 1 >= got) break;
      if(r[j].time != g_aT[i] || r[j + 1].time != g_aT[i + 1]) continue;
      if(g_aC[i + 1] <= 0 || r[j + 1].close <= 0) continue;
      int k = ArraySize(x); ArrayResize(x, k + 1); ArrayResize(y, k + 1);
      x[k] = MathLog(g_aC[i] / g_aC[i + 1]); y[k] = MathLog(r[j].close / r[j + 1].close);
     }
   pairs = ArraySize(x);
   if(pairs < 20) return false;
   double mx = 0, my = 0; for(int i = 0; i < pairs; i++) { mx += x[i]; my += y[i]; } mx /= pairs; my /= pairs;
   double sxy = 0, sxx = 0, syy = 0;
   for(int i = 0; i < pairs; i++) { sxy += (x[i]-mx)*(y[i]-my); sxx += (x[i]-mx)*(x[i]-mx); syy += (y[i]-my)*(y[i]-my); }
   if(sxx <= 0 || syy <= 0) return false;
   corr = sxy / MathSqrt(sxx * syy);
   LastGood(ck, corr + 2, true); LastGood(ck + "|n", pairs, true);
   return true;
  }
string A_Correlation(string sym, ENUM_TIMEFRAMES tf)
  {
   double r5  = g_anb > 6  && g_aC[6]  != 0 ? (g_aC[1] - g_aC[6])  / g_aC[6]  * 100.0 : 0;
   double r20 = g_anb > 21 && g_aC[21] != 0 ? (g_aC[1] - g_aC[21]) / g_aC[21] * 100.0 : 0;
   string refs[6] = {"EURUSD", "GBPUSD", "USDJPY", "XAUUSD", "AUDUSD", "USDCHF"};
   string items[]; int pos = 0, neg = 0;
   double euCorr = 0; bool euOk = false;
   for(int i = 0; i < 6; i++)
     {
      if(StringFind(sym, refs[i]) == 0) continue;
      double c; int pairs;
      if(!A_CorrWith(refs[i], tf, 100, c, pairs)) continue;
      A_Push(items, Obj(J("symbol", refs[i]) + "," + Jn("corr", c, 3) + "," + Ji("bars", pairs)));
      if(c > 0.5) pos++; else if(c < -0.5) neg++;
      if(refs[i] == "EURUSD") { euCorr = c; euOk = true; }
     }
   double eu = 0; bool euRetOk = A_SymReturn("EURUSD", tf, 20, eu);
   string s = sym; StringToUpper(s);
   bool haven = StringFind(s, "XAU") >= 0 || StringFind(s, "JPY") >= 0 || StringFind(s, "CHF") >= 0;
   string f[];
   A_Push(f, Jn("ret_5bar", r5, 4)); A_Push(f, Jn("ret_20bar", r20, 4));
   A_Push(f, euRetOk ? Jn("vs_eurusd", eu, 4) : Jnull("vs_eurusd"));
   A_Push(f, euOk ? Jn("corr_eurusd", euCorr, 3) : Jnull("corr_eurusd"));
   A_Push(f, J("corr_label", !euOk ? "UNKNOWN" : euCorr > 0.5 ? "POSITIVE" : euCorr < -0.5 ? "NEGATIVE" : "WEAK"));
   A_Push(f, euRetOk ? Jn("vs_dxy", -eu, 4) : Jnull("vs_dxy"));
   A_Push(f, J("vs_dxy_is", "minus EURUSD's return (a proxy, no DXY feed)"));
   A_Push(f, Jr("correlations", "[" + A_Join(items) + "]"));
   A_Push(f, J("correlation_is", "Pearson correlation of the last 100 closed-candle returns"));
   A_Push(f, Jb("risk_on", r20 > 0 && !haven));
   A_Push(f, Jb("safe_haven", haven));
   A_Push(f, Jb("momentum_sync", euOk && euCorr > 0.5));
   A_Push(f, Ji("positive_pairs", pos));
   A_Push(f, Ji("negative_pairs", neg));
   return Obj(A_Join(f));
  }

//--- strength / heatmap ---------------------------------------------------
int A_CurrencyStrengths(ENUM_TIMEFRAMES tf, string &cur[], double &str[])
  {
   string ccy[8] = {"USD","EUR","GBP","JPY","AUD","NZD","CAD","CHF"};
   string pairs[28] = {"EURUSD","GBPUSD","AUDUSD","NZDUSD","USDJPY","USDCAD","USDCHF",
                       "EURGBP","EURJPY","EURAUD","EURNZD","EURCAD","EURCHF",
                       "GBPJPY","GBPAUD","GBPNZD","GBPCAD","GBPCHF",
                       "AUDJPY","AUDNZD","AUDCAD","AUDCHF",
                       "NZDJPY","NZDCAD","NZDCHF","CADJPY","CADCHF","CHFJPY"};
   ArrayResize(cur, 8); ArrayResize(str, 8);
   int cnt[8];
   for(int i = 0; i < 8; i++) { cur[i] = ccy[i]; str[i] = 0; cnt[i] = 0; }
   int used = 0;
   for(int p = 0; p < 28; p++)
     {
      double r;
      if(!A_SymReturn(pairs[p], tf, 20, r)) continue;
      used++;
      string base = StringSubstr(pairs[p], 0, 3), quote = StringSubstr(pairs[p], 3, 3);
      for(int i = 0; i < 8; i++)
        {
         if(cur[i] == base)  { str[i] += r; cnt[i]++; }
         if(cur[i] == quote) { str[i] -= r; cnt[i]++; }
        }
     }
   // Average per pair, so a currency with fewer pairs available isn't penalised.
   for(int i = 0; i < 8; i++) if(cnt[i] > 0) str[i] /= cnt[i];
   return used;
  }
string A_Strength(string sym, ENUM_TIMEFRAMES tf)
  {
   string cur[]; double str[]; int used = A_CurrencyStrengths(tf, cur, str);
   string base = SymbolInfoString(sym, SYMBOL_CURRENCY_BASE), quote = SymbolInfoString(sym, SYMBOL_CURRENCY_PROFIT);
   if(base == "" || quote == "") { base = StringSubstr(sym, 0, 3); quote = StringSubstr(sym, 3, 3); }
   double bs = 0, qs = 0; bool bOk = false, qOk = false;
   int strongestI = 0, weakestI = 0;
   for(int i = 0; i < ArraySize(cur); i++)
     {
      if(cur[i] == base) { bs = str[i]; bOk = true; }
      if(cur[i] == quote) { qs = str[i]; qOk = true; }
      if(str[i] > str[strongestI]) strongestI = i;
      if(str[i] < str[weakestI])   weakestI = i;
     }
   string items[];
   for(int i = 0; i < ArraySize(cur); i++) A_Push(items, "\"" + cur[i] + "\":" + DoubleToString(str[i], 3));
   string f[];
   A_Push(f, J("base", base)); A_Push(f, J("quote", quote));
   A_Push(f, bOk ? Jn("base_strength", bs, 3) : Jnull("base_strength"));
   A_Push(f, qOk ? Jn("quote_strength", qs, 3) : Jnull("quote_strength"));
   A_Push(f, (bOk && qOk) ? Jn("differential", bs - qs, 3) : Jnull("differential"));
   A_Push(f, J("bias", !(bOk && qOk) ? "NOT_A_CURRENCY_PAIR" : bs > qs ? "LONG_BASE" : "SHORT_BASE"));
   A_Push(f, J("strongest", used > 0 ? cur[strongestI] : "")); A_Push(f, J("weakest", used > 0 ? cur[weakestI] : ""));
   A_Push(f, Ji("pairs_used", used)); A_Push(f, Ji("pairs_total", 28));
   A_Push(f, J("method", "average % move over the last 20 closed candles across the 28 major pairs"));
   A_Push(f, Jr("all", Obj(A_Join(items))));
   return Obj(A_Join(f));
  }
string A_Heatmap(ENUM_TIMEFRAMES tf)
  {
   string cur[]; double str[]; int used = A_CurrencyStrengths(tf, cur, str);
   string rows[];
   for(int i = 0; i < ArraySize(cur); i++)
      A_Push(rows, Obj(J("ccy", cur[i]) + "," + Jn("score", str[i], 3) + "," +
                     J("state", str[i] > 0.15 ? "STRONG" : str[i] < -0.15 ? "WEAK" : "NEUTRAL")));
   return Obj(Jr("currencies", "[" + A_Join(rows) + "]") + "," + Ji("count", ArraySize(cur)) + "," + Ji("pairs_used", used));
  }

//--- fractal (Williams, 2 closed bars each side) --------------------------
string A_Fractal()
  {
   string up[], dn[];
   int lastUp = -1, lastDn = -1;
   for(int i = 3; i < MathMin(g_anb - 2, 120) && (ArraySize(up) < 6 || ArraySize(dn) < 6); i++)
     {
      if(ArraySize(up) < 6 && A_IsSwingHigh(i, 2)) { A_Push(up, Obj(Ji("bar", i) + "," + Jn("level", g_aH[i], g_aDigits))); if(lastUp < 0) lastUp = i; }
      if(ArraySize(dn) < 6 && A_IsSwingLow(i, 2))  { A_Push(dn, Obj(Ji("bar", i) + "," + Jn("level", g_aL[i], g_aDigits))); if(lastDn < 0) lastDn = i; }
     }
   double atr = A_ATR(14);
   string last = lastUp < 0 && lastDn < 0 ? "NONE" : lastDn < 0 || (lastUp >= 0 && lastUp < lastDn) ? "UP" : "DOWN";
   return Obj(Jr("up_fractals", "[" + A_Join(up) + "]") + "," + Jr("down_fractals", "[" + A_Join(dn) + "]") + "," +
              Ji("up_count", ArraySize(up)) + "," + Ji("down_count", ArraySize(dn)) + "," +
              J("last_fractal", last) + "," + Jn("fractal_atr", A_P(atr), 1));
  }

//--- harmonic (time-ordered X-A-B-C + the D completion zone) -----------------
bool InRange(double v, double lo, double hi) { return v >= lo && v <= hi; }
string A_Harmonic()
  {
   double px[]; int bar[], typ[];
   int n = A_Zigzag(SwingLookback, 4, px, bar, typ);
   if(n < 4) return Obj(J("pattern", "NONE") + "," + Ji("confidence", 0) + "," + J("reason", "not enough swings"));
   double X = px[0], A = px[1], B = px[2], C = px[3];
   bool bullish = A > X;  // X low -> A high -> B low -> C high -> D low (buy)
   double xa = MathAbs(A - X), ab = MathAbs(A - B), bc = MathAbs(B - C);
   double abXa = xa > 0 ? ab / xa : 0, bcAb = ab > 0 ? bc / ab : 0;
   double D = g_aC[0];
   double adXa = xa > 0 ? MathAbs(A - D) / xa : 0;
   double cdBc = bc > 0 ? MathAbs(C - D) / bc : 0;
   string pattern = "NONE"; double dRatio = 0; int conf = 0;
   bool bcOk = InRange(bcAb, 0.382, 0.886);
   if(InRange(abXa, 0.58, 0.66) && bcOk) { pattern = "GARTLEY"; dRatio = 0.786; }
   else if(InRange(abXa, 0.382, 0.5) && bcOk) { pattern = "BAT"; dRatio = 0.886; }
   else if(InRange(abXa, 0.75, 0.82) && bcOk) { pattern = "BUTTERFLY"; dRatio = 1.27; }
   else if(InRange(abXa, 0.382, 0.618) && bcOk) { pattern = "CRAB"; dRatio = 1.618; }
   double s = bullish ? -1 : 1;
   double prz = pattern != "NONE" ? A + s * xa * dRatio : 0;  // the D completion level
   double atr = A_ATR(14);
   bool inPrz = pattern != "NONE" && MathAbs(D - prz) <= atr * 0.5;
   if(pattern != "NONE") conf = inPrz ? 70 : 45;
   return Obj(J("pattern", pattern) + "," + J("status", pattern == "NONE" ? "NONE" : inPrz ? "AT_COMPLETION_ZONE" : "FORMING") + "," + Ji("confidence", conf) + "," +
              Jn("x", X, g_aDigits) + "," + Jn("a", A, g_aDigits) + "," + Jn("b", B, g_aDigits) + "," +
              Jn("c", C, g_aDigits) + "," + Jn("d", D, g_aDigits) + "," +
              Jn("ab_xa", abXa, 3) + "," + Jn("bc_ab", bcAb, 3) + "," + Jn("cd_bc", cdBc, 3) + "," + Jn("ad_xa", adXa, 3) + "," +
              J("direction", pattern == "NONE" ? "NONE" : bullish ? "BULL" : "BEAR") + "," +
              (pattern != "NONE" ? Jn("prz", prz, g_aDigits) + "," + Jn("prz_high", prz + atr * 0.5, g_aDigits) + "," + Jn("prz_low", prz - atr * 0.5, g_aDigits)
                                 : Jnull("prz") + "," + Jnull("prz_high") + "," + Jnull("prz_low")) + "," +
              Jb("in_prz", inPrz));
  }

//--- mean_reversion --------------------------------------------------------
string A_MeanReversion()
  {
   double ma20 = A_SMA(20), sd = A_StdDev(20), atr = A_ATR(14);
   double z = sd > 0 ? (g_aC[0] - ma20) / sd : 0;
   int barsAway = 0;
   for(int i = 0; i < MathMin(g_anb, 50); i++) { if((g_aC[i] > A_SMA(20, i)) == (g_aC[0] > ma20)) barsAway++; else break; }
   // Real half-life (Ornstein-Uhlenbeck): regress the bar change on the previous close over 100 closed bars.
   int n = MathMin(100, g_anb - 2);
   double sx = 0, sy = 0, sxx = 0, sxy = 0;
   for(int i = 1; i <= n; i++) { double x = g_aC[i + 1], y = g_aC[i] - g_aC[i + 1]; sx += x; sy += y; sxx += x * x; sxy += x * y; }
   double den = n * sxx - sx * sx;
   double beta = den != 0 ? (n * sxy - sx * sy) / den : 0;
   bool hlOk = beta < 0;
   double halfLife = hlOk ? -MathLog(2.0) / beta : 0;
   return Obj(Jn("mean", ma20, g_aDigits) + "," + Jn("zscore", z, 3) + "," +
              Jn("deviation_pips", A_P(g_aC[0] - ma20), 1) + "," +
              J("state", z > 2 ? "OVEREXTENDED_UP" : z < -2 ? "OVEREXTENDED_DOWN" : "NORMAL") + "," +
              Jb("revert_long", z < -1.5) + "," + Jb("revert_short", z > 1.5) + "," +
              Ji("bars_from_mean", barsAway) + "," +
              (hlOk ? Jn("half_life_est", halfLife, 1) : Jnull("half_life_est")) + "," +
              J("half_life_is", hlOk ? "bars for half of a move away from the mean to fade (regression on 100 bars)" : "no mean-reverting tendency measured") + "," +
              Jn("target", ma20, g_aDigits) + "," +
              Jn("target_dist_pips", A_P(MathAbs(g_aC[0] - ma20)), 1) + "," +
              Jn("atr_multiple", atr > 0 ? MathAbs(g_aC[0] - ma20) / atr : 0, 3));
  }

//--- tape (real last 200 ticks) ---------------------------------------------
string A_Tape(string sym)
  {
   MqlTick ticks[];
   int got = SymbolIsSynchronized(sym) ? CopyTicks(sym, ticks, COPY_TICKS_ALL, 0, 200) : 0;
   int upT = 0, dnT = 0; double lastP = 0;
   for(int i = 0; i < got; i++)
     {
      double p = ticks[i].bid > 0 ? ticks[i].bid : ticks[i].last;
      if(lastP > 0) { if(p > lastP) upT++; else if(p < lastP) dnT++; }
      lastP = p;
     }
   double ratio = (upT + dnT) > 0 ? (double)upT / (upT + dnT) * 100.0 : 50;
   long spanSec = got > 1 ? (long)((ticks[got - 1].time_msc - ticks[0].time_msc) / 1000) : 0;
   return Obj(Ji("ticks_sampled", got) + "," + Ji("up_ticks", upT) + "," + Ji("down_ticks", dnT) + "," +
              Jn("uptick_pct", ratio, 2) + "," +
              J("tape_bias", ratio > 55 ? "BULL" : ratio < 45 ? "BEAR" : "NEUTRAL") + "," +
              Jn("last_price", lastP, g_aDigits) + "," + Ji("span_seconds", spanSec) + "," +
              Jb("fast_tape", got >= 200 && spanSec > 0 && spanSec < 120));
  }

string A_TapeFlow()
  {
   int n = MathMin(30, g_anb - 1);
   double up = 0, dn = 0;
   for(int i = 1; i <= n; i++) { if(g_aC[i] >= g_aO[i]) up += (double)g_aV[i]; else dn += (double)g_aV[i]; }
   double cvd = up - dn;
   double imb = (up + dn) > 0 ? (up - dn) / (up + dn) : 0;
   return Obj(J("source", "estimated from tick volume x candle colour -- not real order flow") + "," +
              Jn("cvd", cvd, 0) + "," + Jn("imbalance", imb, 4) + "," +
              J("flow_bias", imb > 0.1 ? "BUY" : imb < -0.1 ? "SELL" : "BALANCED") + "," +
              Jn("buy_flow", up, 0) + "," + Jn("sell_flow", dn, 0) + "," +
              Ji("window_bars", n) + "," +
              Jb("aggressive_buyers", imb > 0.25) + "," + Jb("aggressive_sellers", imb < -0.25));
  }

//--- seasonality (hours in real UTC) --------------------------------------
string A_Seasonality()
  {
   MqlDateTime d; TimeToStruct(TimeGMT(), d);
   double hourly[24]; int hcnt[24];
   for(int i = 0; i < 24; i++) { hourly[i] = 0; hcnt[i] = 0; }
   for(int i = 1; i < g_anb; i++)
     {
      MqlDateTime b; TimeToStruct((datetime)((long)g_aT[i] - g_srvOffset), b);
      hourly[b.hour] += A_P(g_aH[i] - g_aL[i]); hcnt[b.hour]++;
     }
   int bestH = 0; double bestV = -1;
   string rows[];
   for(int i = 0; i < 24; i++)
     {
      double avg = hcnt[i] > 0 ? hourly[i] / hcnt[i] : 0;
      if(avg > bestV) { bestV = avg; bestH = i; }
      A_Push(rows, DoubleToString(avg, 1));
     }
   string dow[7]; dow[0]="SUN"; dow[1]="MON"; dow[2]="TUE"; dow[3]="WED"; dow[4]="THU"; dow[5]="FRI"; dow[6]="SAT";
   return Obj(J("day_of_week", dow[d.day_of_week]) + "," + Ji("hour_utc", d.hour) + "," +
              Ji("month", d.mon) + "," + Ji("day_of_month", d.day) + "," +
              Ji("most_volatile_hour", bestH) + "," + J("hours_are", "UTC") + "," + Jn("most_volatile_hour_pips", bestV, 1) + "," +
              Jr("hourly_avg_range_pips", "[" + A_Join(rows) + "]") + "," +
              Jb("is_month_end", d.day >= DaysInMonth(d.year, d.mon) - 2) + "," + Jb("is_friday", d.day_of_week == 5));
  }

//--- spread_analysis --------------------------------------------------------
string A_SpreadAnalysis(string sym)
  {
   double spread = SymbolInfoDouble(sym, SYMBOL_ASK) - SymbolInfoDouble(sym, SYMBOL_BID);
   double sp = A_Pips(sym, spread);
   double atrP = A_Pips(sym, A_ATR(14));
   long spPts = (long)SymbolInfoInteger(sym, SYMBOL_SPREAD);
   return Obj(Jn("spread_pips", sp, 2) + "," + Ji("spread_points", spPts) + "," +
              Jn("spread_pct_of_atr", atrP > 0 ? sp / atrP * 100.0 : 0, 2) + "," +
              J("cost_rating", sp < atrP * 0.05 ? "LOW" : sp < atrP * 0.15 ? "NORMAL" : "HIGH") + "," +
              Jb("tradeable", sp < atrP * 0.2) + "," +
              Jn("stop_level_pts", (double)SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL), 0) + "," +
              Jn("freeze_level_pts", (double)SymbolInfoInteger(sym, SYMBOL_TRADE_FREEZE_LEVEL), 0) + "," +
              J("execution_mode", EnumToString((ENUM_SYMBOL_TRADE_EXECUTION)SymbolInfoInteger(sym, SYMBOL_TRADE_EXEMODE))));
  }

//--- gann ----------------------------------------------------------------
string A_Gann()
  {
   double hi = A_HighestHigh(0, 50), lo = A_LowestLow(0, 50), rng = hi - lo;
   double g[9]; double ratios[9] = {0.125, 0.25, 0.333, 0.375, 0.5, 0.625, 0.667, 0.75, 0.875};
   string lines[];
   for(int i = 0; i < 9; i++) { g[i] = lo + rng * ratios[i]; A_Push(lines, DoubleToString(g[i], g_aDigits)); }
   int bi = 0; double bd = 1e18;
   for(int i = 0; i < 9; i++) { double dd = MathAbs(g_aC[0] - g[i]); if(dd < bd) { bd = dd; bi = i; } }
   // Square of 9: price (in points) -> sqrt; each 45 degrees = +/-0.25 on the root.
   double pts = g_aC[0] / MathMax(g_aPoint, 1e-9);
   double root = MathSqrt(pts);
   string sq[];
   int degs[4] = {45, 90, 180, 360};
   for(int k = 0; k < 4; k++)
     {
      double step = degs[k] / 180.0;
      double upP = MathPow(root + step, 2) * g_aPoint, dnP = MathPow(MathMax(root - step, 0), 2) * g_aPoint;
      A_Push(sq, Obj(Ji("degrees", degs[k]) + "," + Jn("up", upP, g_aDigits) + "," + Jn("down", dnP, g_aDigits)));
     }
   return Obj(Jr("gann_levels", "[" + A_Join(lines) + "]") + "," +
              Jn("nearest_gann", g[bi], g_aDigits) + "," + Jn("nearest_ratio", ratios[bi], 3) + "," +
              Jn("dist_pips", A_P(bd), 1) + "," +
              Jn("range_high", hi, g_aDigits) + "," + Jn("range_low", lo, g_aDigits) + "," +
              Jn("sq9_next", MathPow(root + 1.0, 2) * g_aPoint, g_aDigits) + "," +
              Jr("square_of_9", "[" + A_Join(sq) + "]") + "," +
              J("gann_bias", g_aC[0] > lo + rng * 0.5 ? "BULL" : "BEAR"));
  }

//--- market_profile (each candle's tick volume spread over its own range) ---
string A_MarketProfile()
  {
   int n = MathMin(g_anb, 100);
   double hi = A_HighestHigh(0, n), lo = A_LowestLow(0, n);
   int BINS = 24;
   double binSize = (hi - lo) / BINS;
   if(binSize <= 0) binSize = g_aPoint;
   double vol[24]; for(int i = 0; i < BINS; i++) vol[i] = 0;
   for(int i = 0; i < n; i++)
     {
      int b0 = (int)MathFloor((g_aL[i] - lo) / binSize), b1 = (int)MathFloor((g_aH[i] - lo) / binSize);
      b0 = MathMax(0, MathMin(BINS - 1, b0)); b1 = MathMax(0, MathMin(BINS - 1, b1));
      double share = (double)g_aV[i] / (b1 - b0 + 1);
      for(int b = b0; b <= b1; b++) vol[b] += share;
     }
   int poc = 0; double total = 0;
   for(int i = 0; i < BINS; i++) { total += vol[i]; if(vol[i] > vol[poc]) poc = i; }
   double pocPrice = lo + (poc + 0.5) * binSize;
   double acc = vol[poc]; int lowI = poc, hiI = poc;
   while(acc < total * 0.7 && (lowI > 0 || hiI < BINS - 1))
     {
      double below = lowI > 0 ? vol[lowI - 1] : -1;
      double above = hiI < BINS - 1 ? vol[hiI + 1] : -1;
      if(above >= below) { hiI++; acc += MathMax(0.0, above); }
      else { lowI--; acc += MathMax(0.0, below); }
     }
   double vah = lo + (hiI + 1) * binSize, val = lo + lowI * binSize;
   string bins[];
   for(int i = 0; i < BINS; i++)
      A_Push(bins, Obj(Jn("price", lo + (i + 0.5) * binSize, g_aDigits) + "," + Jn("volume", vol[i], 0)));
   double pocPos = (pocPrice - lo) / MathMax(hi - lo, g_aPoint);
   string shape = (vah - val) > (hi - lo) * 0.7 ? "D_SHAPE" : pocPos > 0.6 ? "P_SHAPE" : pocPos < 0.4 ? "B_SHAPE" : "D_SHAPE";
   return Obj(J("volume_is", "tick volume") + "," + Jn("poc", pocPrice, g_aDigits) + "," + Jn("vah", vah, g_aDigits) + "," + Jn("val", val, g_aDigits) + "," +
              Jn("profile_high", hi, g_aDigits) + "," + Jn("profile_low", lo, g_aDigits) + "," +
              J("price_vs_va", g_aC[0] > vah ? "ABOVE" : g_aC[0] < val ? "BELOW" : "INSIDE") + "," +
              Jn("dist_to_poc_pips", A_P(g_aC[0] - pocPrice), 1) + "," +
              J("shape", shape) + "," +
              Jr("bins", "[" + A_Join(bins) + "]"));
  }

//--- macro ---------------------------------------------------------------
string A_Macro(string sym, ENUM_TIMEFRAMES tf)
  {
   double d1 = 0, w1 = 0, dxy = 0, gold = 0, jpy = 0;
   double dC = xClose(sym, PERIOD_D1, 1), dCp = xClose(sym, PERIOD_D1, 2);
   double wC = xClose(sym, PERIOD_W1, 1), wCp = xClose(sym, PERIOD_W1, 2);
   bool dOk = dC > 0 && dCp > 0, wOk = wC > 0 && wCp > 0;
   if(dOk) d1 = (dC - dCp) / dCp * 100.0;
   if(wOk) w1 = (wC - wCp) / wCp * 100.0;
   bool euOk = A_SymReturn("EURUSD", PERIOD_D1, 5, dxy); dxy = -dxy;
   bool gOk = A_SymReturn("XAUUSD", PERIOD_D1, 5, gold);
   bool jOk = A_SymReturn("USDJPY", PERIOD_D1, 5, jpy);
   string regime = "UNKNOWN";
   if(gOk && jOk) regime = (gold > 0.5 && jpy < 0) ? "RISK_OFF" : (gold < 0 && jpy > 0) ? "RISK_ON" : "NEUTRAL";
   return Obj((dOk ? Jn("daily_change_pct", d1, 4) : Jnull("daily_change_pct")) + "," +
              (wOk ? Jn("weekly_change_pct", w1, 4) : Jnull("weekly_change_pct")) + "," +
              J("changes_are", "last full day / last full week") + "," +
              (euOk ? Jn("dxy_proxy_5d", dxy, 4) : Jnull("dxy_proxy_5d")) + "," +
              (gOk ? Jn("gold_5d", gold, 4) : Jnull("gold_5d")) + "," +
              (jOk ? Jn("usdjpy_5d", jpy, 4) : Jnull("usdjpy_5d")) + "," +
              J("risk_regime", regime) + "," +
              J("usd_bias", !euOk ? "UNKNOWN" : dxy > 0 ? "STRONG" : "WEAK") + "," +
              Jb("safe_haven_bid", regime == "RISK_OFF"));
  }

//--- news (MT5's economic calendar, which runs on BROKER SERVER time) -------
// The calendar is read at most once every 10 minutes (a wider window than any one answer needs)
// and kept: previous + present, so "news" answers in milliseconds. A read can make the EA wait
// while MT5 syncs the calendar -- when one took over 3 s, the next try waits an hour.
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
      if(CalendarValueHistory(fresh, nowSrv - 12 * 3600, nowSrv + 36 * 3600, NULL, NULL))
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
   if(g_calOk && nowLocal - g_calAt > 900) NotePrevious("economic calendar (" + IntegerToString((long)(nowLocal - g_calAt) / 60) + " min old)");
   return g_calOk;
  }

string A_News(string sym)
  {
   MqlCalendarValue vals[];
   string base = SymbolInfoString(sym, SYMBOL_CURRENCY_BASE), quote = SymbolInfoString(sym, SYMBOL_CURRENCY_PROFIT);
   if(base == "" || quote == "") { base = StringSubstr(sym, 0, 3); quote = StringSubstr(sym, 3, 3); }
   datetime nowSrv = TimeTradeServer();
   datetime from = nowSrv - 6 * 3600, to = nowSrv + 24 * 3600;
   string items[]; int high = 0; long minsToNext = -1; long minsToNextHigh = -1;
   bool calOk = CalendarSnapshot(nowSrv, vals);
   if(calOk)
     {
      for(int i = 0; i < ArraySize(vals) && ArraySize(items) < 15; i++)
        {
         if(vals[i].time < from || vals[i].time > to) continue;
         MqlCalendarEvent ev;
         if(!CalendarEventById(vals[i].event_id, ev)) continue;
         MqlCalendarCountry co;
         if(!CalendarCountryById(ev.country_id, co)) continue;
         if(co.currency != base && co.currency != quote) continue;
         bool isHigh = ev.importance == CALENDAR_IMPORTANCE_HIGH;
         long mins = (long)((vals[i].time - nowSrv) / 60);
         if(isHigh && mins >= 0) high++;
         if(mins > 0 && (minsToNext < 0 || mins < minsToNext)) minsToNext = mins;
         if(isHigh && mins > 0 && (minsToNextHigh < 0 || mins < minsToNextHigh)) minsToNextHigh = mins;
         A_Push(items, Obj(J("time", SrvToIso(vals[i].time)) + "," + Ji("minutes_from_now", mins) + "," + J("currency", co.currency) + "," +
                         Js("event", ev.name) + "," +
                         J("importance", isHigh ? "HIGH" : ev.importance == CALENDAR_IMPORTANCE_MODERATE ? "MEDIUM" : "LOW") + "," +
                         Ji("has_actual", vals[i].HasActualValue() ? 1 : 0)));
        }
     }
   return Obj(Jb("calendar_available", calOk) + "," + Jr("events", "[" + A_Join(items) + "]") + "," + Ji("count", ArraySize(items)) + "," +
              Ji("high_impact_count", high) + "," + Ji("minutes_to_next", minsToNext) + "," + Ji("minutes_to_next_high", minsToNextHigh) + "," +
              Jb("news_blackout", minsToNextHigh >= 0 && minsToNextHigh < 30));
  }

//--- sentiment (TECHNICAL sentiment, built from indicators) ----------------
string A_Sentiment(int confScore, string confDir)
  {
   double rsi = A_RSI(14);
   double m, s, h; A_MACD(m, s, h, 0);
   int bullBars = 0; int n = MathMin(20, g_anb - 1);
   for(int i = 1; i <= n; i++) if(g_aC[i] >= g_aO[i]) bullBars++;
   double pctBull = (double)bullBars / MathMax(1, n) * 100.0;
   double score = (rsi - 50) * 1.2 + (h > 0 ? 15 : -15) + (pctBull - 50) * 0.6;
   score = MathMax(-100, MathMin(100, score));
   return Obj(J("source", "technical sentiment from RSI, MACD and candle colours -- not trader positioning") + "," + Jn("score", score, 1) + "," +
              J("label", score > 40 ? "GREED" : score > 10 ? "BULLISH" : score < -40 ? "FEAR" : score < -10 ? "BEARISH" : "NEUTRAL") + "," +
              Jn("bull_bar_pct", pctBull, 1) + "," +
              Jn("rsi", rsi, 2) + "," +
              J("confluence_dir", confDir) + "," + Ji("confluence_score", confScore) + "," +
              Jb("extreme", MathAbs(score) > 70));
  }

//--- regime (Kaufman efficiency ratio + ADX) --------------------------------
string A_Regime()
  {
   double atr = A_ATR(14), atrLong = A_ATR(MathMin(50, g_anb - 2));
   double ma20 = A_SMA(20), ma50 = A_SMA(50);
   int n = MathMin(50, g_anb - 2);
   double rng = A_HighestHigh(1, n) - A_LowestLow(1, n);
   double net = MathAbs(g_aC[1] - g_aC[1 + n]);
   double path = 0; for(int i = 1; i <= n; i++) path += MathAbs(g_aC[i] - g_aC[i + 1]);
   double er = path > 0 ? net / path : 0;   // Kaufman: net move / the sum of every bar's move
   double adx, pdi, mdi; bool adxOk = A_ADXCalc(14, 0, adx, pdi, mdi);
   bool trending = er > 0.3 || (adxOk && adx >= 25);
   bool ranging = er < 0.15 && (!adxOk || adx < 20);
   string regime = trending ? "TRENDING" : ranging ? "RANGING" : "TRANSITIONAL";
   string vol = atr > atrLong * 1.25 ? "HIGH_VOL" : atr < atrLong * 0.75 ? "LOW_VOL" : "NORMAL_VOL";
   return Obj(J("regime", regime) + "," + J("volatility_regime", vol) + "," +
              Jn("efficiency_ratio", er, 3) + "," + J("efficiency_ratio_is", "Kaufman ER over 50 closed bars") + "," +
              (adxOk ? Jn("adx", adx, 1) : Jnull("adx")) + "," +
              J("direction", g_aC[0] > ma50 ? "UP" : "DOWN") + "," +
              Jb("trending", regime == "TRENDING") + "," + Jb("ranging", regime == "RANGING") + "," +
              Jn("range_pips", A_P(rng), 1) + "," + Jn("net_move_pips", A_P(net), 1) + "," +
              J("suggested_style", regime == "TRENDING" ? "BREAKOUT_TREND_FOLLOW" : regime == "RANGING" ? "MEAN_REVERSION" : "WAIT_FOR_CLARITY") + "," +
              Jn("ma_spread_pips", A_P(ma20 - ma50), 1));
  }

//--- backtest (MA20/50 cross on the loaded history, spread included) -------
string A_Backtest(string sym)
  {
   int trades = 0, wins = 0; double pnl = 0, best = 0, worst = 0, entry = 0; int dir = 0;
   int n = MathMin(g_anb - 55, 500);
   double spreadP = A_Pips(sym, SymbolInfoDouble(sym, SYMBOL_ASK) - SymbolInfoDouble(sym, SYMBOL_BID));
   for(int i = n; i > 0; i--)
     {
      double f = A_SMA(20, i), sl2 = A_SMA(50, i);
      int sig = f > sl2 ? 1 : -1;
      if(dir == 0) { dir = sig; entry = g_aC[i]; }
      else if(sig != dir)
        {
         double r = A_P((g_aC[i] - entry) * dir) - spreadP;
         trades++; pnl += r; if(r > 0) wins++;
         best = MathMax(best, r); worst = MathMin(worst, r);
         dir = sig; entry = g_aC[i];
        }
     }
   double wr = trades > 0 ? (double)wins / trades * 100.0 : 0;
   return Obj(Ji("strategy_trades", trades) + "," + Ji("wins", wins) + "," +
              Jn("win_rate_pct", wr, 1) + "," + Jn("net_pips", pnl, 1) + "," +
              Jn("avg_pips", trades > 0 ? pnl / trades : 0, 1) + "," +
              Jn("best_pips", best, 1) + "," + Jn("worst_pips", worst, 1) + "," +
              Jn("spread_cost_pips_per_trade", spreadP, 2) + "," +
              J("strategy", "MA20_50_CROSS") + "," + Ji("bars_tested", n) + "," +
              J("edge", trades >= 5 && wr > 50 && pnl > 0 ? "POSITIVE" : trades < 5 ? "TOO_FEW_TRADES" : "NEGATIVE"));
  }

//--- swing ---------------------------------------------------------------
string A_Swing()
  {
   double sh[], sl[]; int shB[], slB[];
   A_CollectSwings(SwingLookback, 6, sh, shB, sl, slB);
   string hs[], ls[];
   for(int i = 0; i < ArraySize(sh); i++)
      A_Push(hs, Obj(Jn("level", sh[i], g_aDigits) + "," + Ji("bar", shB[i]) + "," + J("time", A_BarTime(shB[i]))));
   for(int i = 0; i < ArraySize(sl); i++)
      A_Push(ls, Obj(Jn("level", sl[i], g_aDigits) + "," + Ji("bar", slB[i]) + "," + J("time", A_BarTime(slB[i]))));
   double lastHi = ArraySize(sh) > 0 ? sh[0] : g_aH[0];
   double lastLo = ArraySize(sl) > 0 ? sl[0] : g_aL[0];
   return Obj(Jr("highs", "[" + A_Join(hs) + "]") + "," + Jr("lows", "[" + A_Join(ls) + "]") + "," +
              Jn("last_swing_high", lastHi, g_aDigits) + "," + Jn("last_swing_low", lastLo, g_aDigits) + "," +
              Jn("swing_range_pips", A_P(lastHi - lastLo), 1) + "," +
              Ji("high_count", ArraySize(sh)) + "," + Ji("low_count", ArraySize(sl)) + "," +
              J("last_leg", ArraySize(shB) > 0 && ArraySize(slB) > 0 ? (shB[0] < slB[0] ? "UP" : "DOWN") : "UNKNOWN") + "," +
              Ji("lookback", SwingLookback));
  }

//--- order_blocks ----------------------------------------------------------
string A_OrderBlocks()
  {
   double atr = A_ATR(14, 1);
   string obs[];
   for(int i = 3; i < MathMin(g_anb - 1, 150) && ArraySize(obs) < 8; i++)
     {
      bool bullOB = g_aC[i] < g_aO[i] && g_aC[i - 1] > g_aH[i] && (g_aC[i-1] - g_aO[i-1]) > atr * 0.6;
      bool bearOB = g_aC[i] > g_aO[i] && g_aC[i - 1] < g_aL[i] && (g_aO[i-1] - g_aC[i-1]) > atr * 0.6;
      if(!bullOB && !bearOB) continue;
      // Mitigated = price came back into the block AFTER the displacement candle (i-1 is the move itself).
      bool mitigated = false, broken = false;
      for(int j = i - 2; j >= 0; j--)
        {
         if(g_aL[j] <= g_aH[i] && g_aH[j] >= g_aL[i]) mitigated = true;
         if(j >= 1 && ((bullOB && g_aC[j] < g_aL[i]) || (bearOB && g_aC[j] > g_aH[i]))) broken = true;
        }
      A_Push(obs, Obj(J("type", bullOB ? "BULL" : "BEAR") + "," +
                    Jn("high", g_aH[i], g_aDigits) + "," + Jn("low", g_aL[i], g_aDigits) + "," +
                    Jn("ce", (g_aH[i]+g_aL[i])/2, g_aDigits) + "," + Ji("bar", i) + "," +
                    J("time", A_BarTime(i)) + "," + Jb("mitigated", mitigated) + "," + Jb("broken", broken) + "," +
                    Jn("dist_pips", A_P(g_aC[0] - (g_aH[i]+g_aL[i])/2), 1) + "," +
                    Jn("size_pips", A_P(g_aH[i]-g_aL[i]), 1)));
     }
   return Obj(Jr("blocks", "[" + A_Join(obs) + "]") + "," + Ji("count", ArraySize(obs)) + "," +
              Jn("atr_ref_pips", A_P(atr), 1));
  }

//--- inducement --------------------------------------------------------------
string A_Inducement()
  {
   double sh[], sl[]; int shB[], slB[];
   A_CollectSwings(SwingLookback, 4, sh, shB, sl, slB);
   double idmLow  = ArraySize(sl) > 1 ? sl[1] : A_LowestLow(1, 30);
   double idmHigh = ArraySize(sh) > 1 ? sh[1] : A_HighestHigh(1, 30);
   int lowBar = ArraySize(slB) > 1 ? slB[1] : 30, highBar = ArraySize(shB) > 1 ? shB[1] : 30;
   bool takenLow = false, takenHigh = false;
   for(int i = 1; i < MathMin(g_anb, lowBar); i++)  if(g_aL[i] < idmLow)  { takenLow = true; break; }
   for(int i = 1; i < MathMin(g_anb, highBar); i++) if(g_aH[i] > idmHigh) { takenHigh = true; break; }
   return Obj(Jn("idm_low", idmLow, g_aDigits) + "," + Jn("idm_high", idmHigh, g_aDigits) + "," +
              Jb("idm_low_taken", takenLow) + "," + Jb("idm_high_taken", takenHigh) + "," +
              J("next_target", takenLow && !takenHigh ? "BSL" : takenHigh && !takenLow ? "SSL" : "UNCLEAR") + "," +
              Jn("dist_to_idm_low_pips", A_P(g_aC[0] - idmLow), 1) + "," +
              Jn("dist_to_idm_high_pips", A_P(idmHigh - g_aC[0]), 1) + "," +
              Jb("valid_setup", takenLow != takenHigh));
  }

//--- premium_discount ----------------------------------------------------------
string A_PremiumDiscount()
  {
   double hi = A_HighestHigh(0, 50), lo = A_LowestLow(0, 50);
   double eq = (hi + lo) / 2.0, rng = hi - lo;
   double pos = rng > 0 ? (g_aC[0] - lo) / rng : 0.5;
   return Obj(Jn("range_high", hi, g_aDigits) + "," + Jn("range_low", lo, g_aDigits) + "," +
              Jn("equilibrium", eq, g_aDigits) + "," + Jn("position", pos, 4) + "," +
              J("zone", pos > 0.7 ? "DEEP_PREMIUM" : pos > 0.5 ? "PREMIUM" : pos > 0.3 ? "DISCOUNT" : "DEEP_DISCOUNT") + "," +
              Jn("premium_start", eq, g_aDigits) + "," +
              Jn("discount_end", eq, g_aDigits) + "," +
              // Buys: the 62-79% pullback in the DISCOUNT half; sells: the mirror in the PREMIUM half.
              Jn("ote_high", lo + rng * 0.79, g_aDigits) + "," + Jn("ote_low", lo + rng * 0.62, g_aDigits) + "," +
              Jr("ote_long",  Obj(Jn("high", lo + rng * 0.38, g_aDigits) + "," + Jn("low", lo + rng * 0.21, g_aDigits))) + "," +
              Jr("ote_short", Obj(Jn("high", lo + rng * 0.79, g_aDigits) + "," + Jn("low", lo + rng * 0.62, g_aDigits))) + "," +
              Jb("in_ote", (pos >= 0.62 && pos <= 0.79) || (pos >= 0.21 && pos <= 0.38)) + "," +
              J("in_ote_side", pos >= 0.62 && pos <= 0.79 ? "SELL" : pos >= 0.21 && pos <= 0.38 ? "BUY" : "NONE") + "," +
              Jn("dist_to_eq_pips", A_P(g_aC[0] - eq), 1) + "," +
              J("bias", pos < 0.5 ? "LOOK_LONG" : "LOOK_SHORT"));
  }

// ============================== new endpoints ==============================

//--- adx -----------------------------------------------------------------
string A_Adx()
  {
   double adx, pdi, mdi, adxP, pdiP, mdiP;
   if(!A_ADXCalc(14, 0, adx, pdi, mdi)) { g_aErr = "not enough history for ADX (needs 45+ bars)"; return ""; }
   A_ADXCalc(14, 5, adxP, pdiP, mdiP);
   string strength = adx < 20 ? "WEAK_OR_NO_TREND" : adx < 25 ? "EMERGING" : adx < 40 ? "STRONG" : "VERY_STRONG";
   return Obj(J("method", "Wilder ADX(14) with +DI/-DI") + "," + Jn("adx", adx, 2) + "," + Jn("plus_di", pdi, 2) + "," + Jn("minus_di", mdi, 2) + "," +
              Jn("adx_5_bars_ago", adxP, 2) + "," + Jb("adx_rising", adx > adxP) + "," +
              J("trend_strength", strength) + "," + J("direction", pdi > mdi ? "BULL" : "BEAR") + "," +
              Jb("di_cross_recent", (pdi > mdi) != (pdiP > mdiP)));
  }

//--- mtf: multi-timeframe summary (NOT part of "all") ---------------------
// One read of the trader's trend system (SMMA 6/20/100), RSI, ATR and ADX on M5, M15, H1, H4 and D1.
string A_Mtf(string sym)
  {
   string tfs[5] = {"M5", "M15", "H1", "H4", "D1"};
   string rows[]; int bullN = 0, bearN = 0, okN = 0;
   for(int t = 0; t < 5; t++)
     {
      ENUM_TIMEFRAMES tf = TimeframeFromString(tfs[t]);
      if(!LoadAnalysisSeries(sym, tf)) { A_Push(rows, "\"" + tfs[t] + "\":null"); continue; }
      okN++;
      double c = g_aC[0];
      double s6 = A_SMMA(6), s20 = A_SMMA(20), s100 = A_SMMA(100);
      int score = 0;
      if(c > s6) score++; else score--;
      if(c > s20) score++; else score--;
      if(c > s100) score++; else score--;
      if(s6 > s20) score++; else score--;
      if(s20 > s100) score++; else score--;
      string bias = score >= 4 ? "STRONG_BULL" : score >= 2 ? "BULL" : score <= -4 ? "STRONG_BEAR" : score <= -2 ? "BEAR" : "NEUTRAL";
      if(score >= 2) bullN++; else if(score <= -2) bearN++;
      double adx, pdi, mdi; bool adxOk = A_ADXCalc(14, 0, adx, pdi, mdi);
      double atr = A_ATR(14);
      double rsi = A_RSI(14);
      A_Push(rows, "\"" + tfs[t] + "\":" + Obj(J("bias", bias) + "," + Ji("score", score) + "," +
             Jn("rsi", rsi, 1) + "," + J("rsi_zone", rsi > 70 ? "OVERBOUGHT" : rsi < 30 ? "OVERSOLD" : "NEUTRAL") + "," +
             Jn("atr", atr, g_aDigits) + "," + Jn("atr_pips", A_Pips(sym, atr), 1) + "," +
             (adxOk ? Jn("adx", adx, 1) : Jnull("adx")) + "," + J("adx_direction", pdi > mdi ? "BULL" : "BEAR") + "," +
             Jn("close", c, g_aDigits) + "," + Jn("smma6", s6, g_aDigits) + "," + Jn("smma20", s20, g_aDigits) + "," + Jn("smma100", s100, g_aDigits) + "," +
             J("last_bar_open_utc", A_BarTime(0)) + "," + Jb("from_cache", g_fromCache)));
     }
   if(okN == 0) { g_aErr = "no timeframe of " + sym + " has enough history loaded yet"; return ""; }
   string align = bullN == okN ? "ALL_BULL" : bearN == okN ? "ALL_BEAR" : bullN > bearN ? "MOSTLY_BULL" : bearN > bullN ? "MOSTLY_BEAR" : "MIXED";
   return Obj(Js("symbol", sym) + "," + J("method", "SMMA 6/20/100 trend score per timeframe (same as get_trend), Wilder RSI(14), ATR(14), ADX(14)") + "," +
              Jr("timeframes", Obj(A_Join(rows))) + "," + J("alignment", align) + "," +
              Ji("bull_timeframes", bullN) + "," + Ji("bear_timeframes", bearN) + "," + Ji("timeframes_read", okN) + "," +
              J("computed_at_utc", A_IsoTime(TimeGMT())) + "," + J("ea_version", EA_VERSION));
  }

//--- position_size: exact lots from entry, stop and risk, using MT5's own calculator ----
string A_PositionSize(string sym, string obj)
  {
   string side = JsonGetString(obj, "side"); StringToLower(side);
   if(side != "sell") side = "buy";
   bool buy = side == "buy";
   double sl = JsonGetNumber(obj, "sl", 0);
   double entry = JsonGetNumber(obj, "entry", 0);
   double riskPct = JsonGetNumber(obj, "risk_pct", 0);
   double riskMoney = JsonGetNumber(obj, "risk_money", 0);
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
   double raw = riskMoney / lossPerLot;
   double lots = A_RoundLots(sym, raw);
   bool belowMin = lots < vmin;
   double sizedLots = belowMin ? 0 : lots;
   double margin = 0;
   OrderCalcMargin(ot, sym, belowMin ? vmin : lots, entry, margin);
   double freeMargin = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
   double stopsLevel = SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * SymbolInfoDouble(sym, SYMBOL_POINT);
   string f[];
   A_Push(f, Js("symbol", sym)); A_Push(f, J("side", side));
   A_Push(f, Jn("entry", entry, g_aDigits)); A_Push(f, Jn("sl", sl, g_aDigits));
   A_Push(f, Jn("sl_distance_pips", A_Pips(sym, MathAbs(entry - sl)), 1));
   A_Push(f, Jb("sl_inside_broker_min_distance", stopsLevel > 0 && MathAbs(entry - sl) < stopsLevel));
   A_Push(f, J("account_currency", AccountInfoString(ACCOUNT_CURRENCY)));
   A_Push(f, Jn("balance", bal, 2));
   A_Push(f, Jn("risk_pct", riskPct, 2)); A_Push(f, Jn("risk_money_target", riskMoney, 2));
   A_Push(f, Jn("loss_per_1_lot", lossPerLot, 2));
   A_Push(f, Jn("lots", sizedLots, 2));
   A_Push(f, Jn("raw_lots", raw, 4));
   A_Push(f, Jn("actual_risk_money", sizedLots * lossPerLot, 2));
   A_Push(f, Jb("below_min_lot", belowMin));
   A_Push(f, Jn("min_lot", vmin, 2)); A_Push(f, Jn("max_lot", vmax, 2)); A_Push(f, Jn("lot_step", vstep, 2));
   A_Push(f, Jn("risk_at_min_lot", vmin * lossPerLot, 2));
   A_Push(f, Jn("margin_required", margin, 2));
   A_Push(f, Jn("free_margin", freeMargin, 2));
   A_Push(f, Jb("fits_free_margin", margin <= freeMargin));
   A_Push(f, J("method", "MT5 OrderCalcProfit (exact loss per lot at the stop) and OrderCalcMargin"));
   return Obj(A_Join(f));
  }

//--- symbol_info: the contract, costs, limits and trading hours ------------------
string A_SymbolInfo(string sym)
  {
   if(SymbolInfoDouble(sym, SYMBOL_POINT) <= 0) { g_aErr = "\"" + sym + "\" isn't on this broker"; return ""; }
   MqlTick tk; SymbolInfoTick(sym, tk);
   datetime nowSrv = TimeTradeServer();
   long qAge = tk.time > 0 ? (long)nowSrv - (long)tk.time : -1;
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   double pip = (digits == 3 || digits == 5) ? point * 10 : point;
   double mBuy = 0, mSell = 0;
   OrderCalcMargin(ORDER_TYPE_BUY, sym, 1.0, tk.ask, mBuy);
   OrderCalcMargin(ORDER_TYPE_SELL, sym, 1.0, tk.bid, mSell);
   // Today's trading sessions (MT5 gives them in server time -> shown in UTC).
   MqlDateTime sd; TimeToStruct(nowSrv, sd);
   string sess[]; bool inSession = false;
   int secOfDay = sd.hour * 3600 + sd.min * 60 + sd.sec;
   for(uint k = 0; k < 10; k++)
     {
      datetime from, to;
      if(!SymbolInfoSessionTrade(sym, (ENUM_DAY_OF_WEEK)sd.day_of_week, k, from, to)) break;
      int a = (int)from, b = (int)to;
      if(secOfDay >= a && secOfDay < (b == 0 ? 86400 : b)) inSession = true;
      int au = (int)(((a - g_srvOffset) % 86400 + 86400) % 86400), bu = (int)(((b - g_srvOffset) % 86400 + 86400) % 86400);
      A_Push(sess, Obj(J("from_utc", StringFormat("%02d:%02d", au / 3600, (au % 3600) / 60)) + "," +
                      J("to_utc", StringFormat("%02d:%02d", bu / 3600, (bu % 3600) / 60))));
     }
   bool tradeable = SymbolInfoInteger(sym, SYMBOL_TRADE_MODE) != SYMBOL_TRADE_MODE_DISABLED;
   long fill = SymbolInfoInteger(sym, SYMBOL_FILLING_MODE);
   string f[];
   A_Push(f, Js("symbol", sym));
   A_Push(f, Js("description", SymbolInfoString(sym, SYMBOL_DESCRIPTION)));
   A_Push(f, Js("path", SymbolInfoString(sym, SYMBOL_PATH)));
   A_Push(f, J("currency_base", SymbolInfoString(sym, SYMBOL_CURRENCY_BASE)));
   A_Push(f, J("currency_profit", SymbolInfoString(sym, SYMBOL_CURRENCY_PROFIT)));
   A_Push(f, J("currency_margin", SymbolInfoString(sym, SYMBOL_CURRENCY_MARGIN)));
   A_Push(f, Ji("digits", digits)); A_Push(f, Jn("point", point, 8)); A_Push(f, Jn("pip", pip, 8));
   A_Push(f, Jn("contract_size", SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE), 2));
   A_Push(f, Jn("tick_size", SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE), 8));
   A_Push(f, Jn("tick_value", SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE), 6));
   A_Push(f, Jn("pip_value_per_lot", SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE) > 0 ? SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE) * pip / SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE) : 0, 4));
   A_Push(f, Jn("min_lot", SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), 2));
   A_Push(f, Jn("max_lot", SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX), 2));
   A_Push(f, Jn("lot_step", SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP), 2));
   A_Push(f, Jn("margin_per_lot_buy", mBuy, 2)); A_Push(f, Jn("margin_per_lot_sell", mSell, 2));
   A_Push(f, J("account_currency", AccountInfoString(ACCOUNT_CURRENCY)));
   A_Push(f, Ji("stops_level_points", SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL)));
   A_Push(f, Jn("stops_level_pips", pip > 0 ? SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL) * point / pip : 0, 1));
   A_Push(f, Ji("freeze_level_points", SymbolInfoInteger(sym, SYMBOL_TRADE_FREEZE_LEVEL)));
   A_Push(f, Ji("spread_points", SymbolInfoInteger(sym, SYMBOL_SPREAD)));
   A_Push(f, Jb("spread_floating", SymbolInfoInteger(sym, SYMBOL_SPREAD_FLOAT) != 0));
   A_Push(f, Jn("swap_long", SymbolInfoDouble(sym, SYMBOL_SWAP_LONG), 4));
   A_Push(f, Jn("swap_short", SymbolInfoDouble(sym, SYMBOL_SWAP_SHORT), 4));
   A_Push(f, J("swap_mode", EnumToString((ENUM_SYMBOL_SWAP_MODE)SymbolInfoInteger(sym, SYMBOL_SWAP_MODE))));
   A_Push(f, J("trade_mode", A_TradeModeName(sym)));
   A_Push(f, J("execution_mode", EnumToString((ENUM_SYMBOL_TRADE_EXECUTION)SymbolInfoInteger(sym, SYMBOL_TRADE_EXEMODE))));
   A_Push(f, Jb("fill_fok", (fill & SYMBOL_FILLING_FOK) != 0)); A_Push(f, Jb("fill_ioc", (fill & SYMBOL_FILLING_IOC) != 0));
   A_Push(f, Jr("sessions_today_utc", "[" + A_Join(sess) + "]"));
   A_Push(f, J("quote_time_utc", SrvToIso((datetime)tk.time)));
   A_Push(f, Ji("quote_age_sec", qAge));
   A_Push(f, Jb("market_open_now", tradeable && (ArraySize(sess) == 0 || inSession) && qAge >= 0 && qAge < 600));
   A_Push(f, Jn("bid", tk.bid, digits)); A_Push(f, Jn("ask", tk.ask, digits));
   A_Push(f, J("ea_version", EA_VERSION));
   return Obj(A_Join(f));
  }

//--- history: real closed trades from MT5, every fee included ---------------------
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
      if(dtype == DEAL_TYPE_BALANCE)
        {
         double amt = HistoryDealGetDouble(dt, DEAL_PROFIT);
         if(amt > 0) deposits += amt; else withdrawals += -amt;
         continue;
        }
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
         if(types[k] == "") types[k] = dtype == DEAL_TYPE_BUY ? "sell" : "buy"; // closing deal is the opposite side
        }
     }
   string rows[]; int wins = 0, losses = 0, closedN = 0; double net = 0, grossWin = 0, grossLoss = 0, totCom = 0, totSwap = 0;
   for(int i = ArraySize(ids) - 1; i >= 0; i--)
     {
      if(vols[i] <= 0) continue; // still open
      closedN++;
      double pnl = prof[i] + swp[i] + com[i];
      net += pnl; totCom += com[i]; totSwap += swp[i];
      if(pnl > 0) { wins++; grossWin += pnl; } else if(pnl < 0) { losses++; grossLoss += -pnl; }
      if(ArraySize(rows) >= 100) continue;
      int dg = (int)SymbolInfoInteger(syms[i], SYMBOL_DIGITS);
      A_Push(rows, Obj(J("ticket", IntegerToString((long)ids[i])) + "," + Js("symbol", syms[i]) + "," + J("type", types[i]) + "," +
             Jn("volume", vols[i], 2) + "," + (opx[i] > 0 ? Jn("open_price", opx[i], dg) : Jnull("open_price")) + "," + Jn("close_price", cpx[i], dg) + "," +
             J("open_time", ot[i] > 0 ? SrvToIso(ot[i]) : "") + "," + J("close_time", SrvToIso(ct[i])) + "," +
             Jn("profit", prof[i], 2) + "," + Jn("swap", swp[i], 2) + "," + Jn("commission", com[i], 2) + "," + Jn("net", pnl, 2) + "," +
             J("reason", reasons[i]) + "," + Jb("by_dave", mag[i] == MagicNumber) + "," + Jb("opened_before_window", ot[i] == 0)));
     }
   return Obj(Ji("days", days) + "," + J("account_currency", AccountInfoString(ACCOUNT_CURRENCY)) + "," +
              Jr("summary", Obj(Ji("closed_trades", closedN) + "," + Ji("wins", wins) + "," + Ji("losses", losses) + "," +
                  Jn("win_rate_pct", closedN > 0 ? (double)wins / closedN * 100.0 : 0, 1) + "," +
                  Jn("net", net, 2) + "," + Jn("gross_profit", grossWin, 2) + "," + Jn("gross_loss", grossLoss, 2) + "," +
                  Jn("profit_factor", grossLoss > 0 ? grossWin / grossLoss : 0, 2) + "," +
                  Jn("commissions", totCom, 2) + "," + Jn("swaps", totSwap, 2) + "," +
                  Jn("deposits", deposits, 2) + "," + Jn("withdrawals", withdrawals, 2))) + "," +
              J("order", "newest_first") + "," + J("times", "UTC") + "," +
              Jr("trades", "[" + A_Join(rows) + "]"));
  }

/** "all" -- every endpoint for the requested symbol+timeframe in one response (the multi-timeframe
 * summary is deliberately NOT in here -- it is its own tool). */
string A_All(string sym, ENUM_TIMEFRAMES tf)
  {
   int confScore = 0; string confDir = "NEUTRAL";
   string confluence = A_Confluence(confScore, confDir);
   string d[];
   A_Push(d, Jr("price",            A_Price(sym)));
   A_Push(d, Jr("structure",        A_Structure(sym)));
   A_Push(d, Jr("zones",            A_Zones(sym)));
   A_Push(d, Jr("liquidity",        A_Liquidity(sym)));
   A_Push(d, Jr("trend",            A_Trend(sym)));
   A_Push(d, Jr("momentum",         A_Momentum()));
   A_Push(d, Jr("volatility",       A_Volatility(sym)));
   A_Push(d, Jr("volume",           A_Volume()));
   string ichi = A_Ichimoku(); g_aErr = "";
   A_Push(d, Jr("ichimoku",         ichi == "" ? "null" : ichi));
   A_Push(d, Jr("fibonacci",        A_Fibonacci(sym)));
   A_Push(d, Jr("candles",          A_Candles(sym, 21)));
   string pats = A_Patterns(); g_aErr = "";
   A_Push(d, Jr("patterns",         pats == "" ? "null" : pats));
   A_Push(d, Jr("ict",              A_Ict(sym, tf)));
   A_Push(d, Jr("wyckoff",          A_Wyckoff()));
   A_Push(d, Jr("divergence",       A_Divergence()));
   A_Push(d, Jr("session",          A_Session(sym)));
   string piv = A_Pivots(sym); g_aErr = "";
   A_Push(d, Jr("pivots",           piv == "" ? "null" : piv));
   A_Push(d, Jr("levels",           A_Levels(sym)));
   A_Push(d, Jr("orderflow",        A_OrderFlow()));
   A_Push(d, Jr("confluence",       confluence));
   A_Push(d, Jr("risk_metrics",     A_RiskMetrics(sym)));
   A_Push(d, Jr("synthetic",        A_Synthetic(sym)));
   A_Push(d, Jr("elliott",          A_Elliott()));
   A_Push(d, Jr("correlation",      A_Correlation(sym, tf)));
   A_Push(d, Jr("strength",         A_Strength(sym, tf)));
   A_Push(d, Jr("heatmap",          A_Heatmap(tf)));
   A_Push(d, Jr("fractal",          A_Fractal()));
   A_Push(d, Jr("harmonic",         A_Harmonic()));
   A_Push(d, Jr("mean_reversion",   A_MeanReversion()));
   A_Push(d, Jr("tape",             A_Tape(sym)));
   A_Push(d, Jr("seasonality",      A_Seasonality()));
   A_Push(d, Jr("spread_analysis",  A_SpreadAnalysis(sym)));
   A_Push(d, Jr("gann",             A_Gann()));
   A_Push(d, Jr("market_profile",   A_MarketProfile()));
   A_Push(d, Jr("tape_flow",        A_TapeFlow()));
   A_Push(d, Jr("macro",            A_Macro(sym, tf)));
   A_Push(d, Jr("news",             A_News(sym)));
   A_Push(d, Jr("sentiment",        A_Sentiment(confScore, confDir)));
   A_Push(d, Jr("regime",           A_Regime()));
   A_Push(d, Jr("backtest",         A_Backtest(sym)));
   A_Push(d, Jr("swing",            A_Swing()));
   A_Push(d, Jr("order_blocks",     A_OrderBlocks()));
   A_Push(d, Jr("inducement",       A_Inducement()));
   A_Push(d, Jr("premium_discount", A_PremiumDiscount()));
   return Obj(A_Join(d));
  }

// Puts the freshness label first inside an object answer.
string WithMeta(string data, string meta)
  {
   if(StringLen(data) < 2 || StringGetCharacter(data, 0) != '{') return data;
   string rest = StringSubstr(data, 1);
   return "{\"_meta\":" + meta + (rest == "}" ? "" : ",") + rest;
  }

/** Loads the REQUESTED symbol+timeframe's bars, computes the endpoint, adds the freshness label.
 * An endpoint that can't answer (bad input, not enough history) reports an honest error. */
void RunAnalysis(string commandId, string endpoint, string symbol, string tfStr, string obj)
  {
   g_srvOffset = SrvOffset();
   g_aErr = "";
   ArrayFree(g_prevUsed);
   g_warmBudget = 4;
   if(endpoint == "ping")
     {
      AppendResultData(commandId, Obj(J("status", "ok") + "," + J("time", A_IsoTime(TimeGMT())) + "," + J("source", "DaveEA") + "," + J("ea_version", EA_VERSION)));
      return;
     }
   string data = "";
   bool noSeries = true;
   if(endpoint == "history") data = A_History(obj, symbol);
   else if(endpoint == "symbol_info") data = A_SymbolInfo(symbol);
   else if(endpoint == "position_size")
     {
      if(SymbolInfoDouble(symbol, SYMBOL_POINT) <= 0) g_aErr = "\"" + symbol + "\" isn't on this broker";
      else { SetSymbolInfo(symbol); data = A_PositionSize(symbol, obj); }
     }
   else if(endpoint == "mtf")
     {
      if(SymbolInfoDouble(symbol, SYMBOL_POINT) <= 0) g_aErr = "\"" + symbol + "\" isn't on this broker";
      else data = A_Mtf(symbol);
     }
   else noSeries = false;
   if(noSeries)
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
   if(!LoadAnalysisSeries(symbol, tf))
     {
      AppendResult(commandId, false, "not enough real history loaded yet for " + symbol + " " + tfStr, "");
      return;
     }
   if(endpoint == "trend") data = A_Trend(symbol);
   else if(endpoint == "momentum") data = A_Momentum();
   else if(endpoint == "volatility") data = A_Volatility(symbol);
   else if(endpoint == "price") data = A_Price(symbol);
   else if(endpoint == "structure") data = A_Structure(symbol);
   else if(endpoint == "zones") data = A_Zones(symbol);
   else if(endpoint == "liquidity") data = A_Liquidity(symbol);
   else if(endpoint == "volume") data = A_Volume();
   else if(endpoint == "ichimoku") data = A_Ichimoku();
   else if(endpoint == "fibonacci") data = A_Fibonacci(symbol);
   else if(endpoint == "candles") data = A_Candles(symbol, (int)JsonGetNumber(obj, "count", 21));
   else if(endpoint == "patterns") data = A_Patterns();
   else if(endpoint == "ict") data = A_Ict(symbol, tf);
   else if(endpoint == "wyckoff") data = A_Wyckoff();
   else if(endpoint == "divergence") data = A_Divergence();
   else if(endpoint == "session") data = A_Session(symbol);
   else if(endpoint == "pivots") data = A_Pivots(symbol);
   else if(endpoint == "levels") data = A_Levels(symbol);
   else if(endpoint == "orderflow") data = A_OrderFlow();
   else if(endpoint == "confluence") { int cs = 0; string cd = "NEUTRAL"; data = A_Confluence(cs, cd); }
   else if(endpoint == "risk_metrics") data = A_RiskMetrics(symbol);
   else if(endpoint == "synthetic") data = A_Synthetic(symbol);
   else if(endpoint == "elliott") data = A_Elliott();
   else if(endpoint == "correlation") data = A_Correlation(symbol, tf);
   else if(endpoint == "strength") data = A_Strength(symbol, tf);
   else if(endpoint == "heatmap") data = A_Heatmap(tf);
   else if(endpoint == "fractal") data = A_Fractal();
   else if(endpoint == "harmonic") data = A_Harmonic();
   else if(endpoint == "mean_reversion") data = A_MeanReversion();
   else if(endpoint == "tape") data = A_Tape(symbol);
   else if(endpoint == "tape_flow") data = A_TapeFlow();
   else if(endpoint == "seasonality") data = A_Seasonality();
   else if(endpoint == "spread_analysis") data = A_SpreadAnalysis(symbol);
   else if(endpoint == "gann") data = A_Gann();
   else if(endpoint == "market_profile") data = A_MarketProfile();
   else if(endpoint == "macro") data = A_Macro(symbol, tf);
   else if(endpoint == "news") data = A_News(symbol);
   else if(endpoint == "sentiment") { int cs2 = 0; string cd2 = "NEUTRAL"; A_Confluence(cs2, cd2); data = A_Sentiment(cs2, cd2); }
   else if(endpoint == "regime") data = A_Regime();
   else if(endpoint == "backtest") data = A_Backtest(symbol);
   else if(endpoint == "swing") data = A_Swing();
   else if(endpoint == "order_blocks") data = A_OrderBlocks();
   else if(endpoint == "inducement") data = A_Inducement();
   else if(endpoint == "premium_discount") data = A_PremiumDiscount();
   else if(endpoint == "adx") data = A_Adx();
   else if(endpoint == "all") data = A_All(symbol, tf);
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
   AppendResultData(commandId, WithMeta(data, A_Meta(symbol, tfStr)));
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
