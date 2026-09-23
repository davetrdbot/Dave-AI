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
#define DAVEEA_BARS 220
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
   Print("Dave EA starting. Webhook: ", WebhookURL, ", magic=", MagicNumber);
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
   int rawLen = StringToCharArray(body, post, 0, StringLen(body));
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

   string response = CharArrayToString(result);
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
string BuildReportJson()
  {
   string positions = "";
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      if(positions != "") positions += ",";
      string psym = PositionGetString(POSITION_SYMBOL);
      bool   isBuy = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY);
      string dir = isBuy ? "buy" : "sell";
      // Real current price this position could close at RIGHT NOW -- feeds
      // Dave-side breakeven/trailing (Part 1 item 6) without a second
      // DAVEMA round-trip just to know where price is for an open ticket.
      double curPrice = isBuy ? SymbolInfoDouble(psym, SYMBOL_BID) : SymbolInfoDouble(psym, SYMBOL_ASK);
      positions += "{\"ticket\":\"" + IntegerToString((int)ticket) + "\"," +
                   "\"symbol\":\"" + psym + "\"," +
                   "\"type\":\"" + dir + "\"," +
                   "\"lots\":" + DoubleToString(PositionGetDouble(POSITION_VOLUME), 2) + "," +
                   "\"openPrice\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), 5) + "," +
                   "\"sl\":" + DoubleToString(PositionGetDouble(POSITION_SL), 5) + "," +
                   "\"tp\":" + DoubleToString(PositionGetDouble(POSITION_TP), 5) + "," +
                   "\"currentPrice\":" + DoubleToString(curPrice, 5) + "," +
                   "\"pnl\":" + DoubleToString(PositionGetDouble(POSITION_PROFIT), 2) + "}";
     }

   string pendingOrders = "";
   int totalOrders = OrdersTotal();
   for(int i = 0; i < totalOrders; i++)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      if(pendingOrders != "") pendingOrders += ",";
      ENUM_ORDER_TYPE ot = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      string typeStr = OrderTypeToString(ot);
      pendingOrders += "{\"ticket\":\"" + IntegerToString((int)ticket) + "\"," +
                        "\"symbol\":\"" + OrderGetString(ORDER_SYMBOL) + "\"," +
                        "\"type\":\"" + typeStr + "\"," +
                        "\"lots\":" + DoubleToString(OrderGetDouble(ORDER_VOLUME_CURRENT), 2) + "," +
                        "\"price\":" + DoubleToString(OrderGetDouble(ORDER_PRICE_OPEN), 5) + "}";
     }

   string results = LastResultsJson();
   string closedPositions = BuildClosedPositionsJson();

   return "{\"type\":\"heartbeat\"," +
          "\"account\":\"" + IntegerToString((int)AccountInfoInteger(ACCOUNT_LOGIN)) + "\"," +
          "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + "," +
          "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + "," +
          // Real gap fixed: margin/free margin were never reported at all,
          // so Dave had no way to see how much the account could actually
          // still risk. Real MT5 fields, not derived/approximated.
          "\"margin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN), 2) + "," +
          "\"freeMargin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) + "," +
          // Item 12 real gap fixed: leverage was never reported at all, so Dave had no real
          // basis for position sizing beyond raw balance/equity. Real MT5 field, not guessed.
          "\"leverage\":" + IntegerToString((int)AccountInfoInteger(ACCOUNT_LEVERAGE)) + "," +
          // Whether this EA may place trades right now: the terminal's Algo Trading button AND the
          // EA's own "allow algo trading" permission. Off = every order fails, so Dave says so up
          // front instead of discovering it on the first trade.
          "\"algoTrading\":" + ((TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) && MQLInfoInteger(MQL_TRADE_ALLOWED)) ? "true" : "false") + "," +
          "\"positions\":[" + positions + "]," +
          "\"pendingOrders\":[" + pendingOrders + "]," +
          "\"results\":[" + results + "]," +
          "\"closedPositions\":[" + closedPositions + "]}";
  }

//+------------------------------------------------------------------+
//| Update 10 (trade notifications): a position that vanished since   |
//| the last report gets a REAL deal-history lookup here -- MT5's own |
//| DEAL_REASON tells TP/SL/manual/EA-initiated apart, real data, not  |
//| guessed Dave-side from a position diff alone. DEAL_REASON_EXPERT   |
//| is real and specific: it means an Expert Advisor (this EA, acting  |
//| on Dave's own queued "close" command) closed it -- DEAL_REASON_    |
//| CLIENT means the terminal/mobile/web UI did, i.e. the user closed  |
//| it manually. Confirmed real MQL5 enum values, not guessed.         |
//+------------------------------------------------------------------+
ulong g_lastTickets[];

string BuildClosedPositionsJson()
  {
   ulong currentTickets[];
   int total = PositionsTotal();
   ArrayResize(currentTickets, total);
   for(int i = 0; i < total; i++)
      currentTickets[i] = PositionGetTicket(i);

   string out = "";
   for(int i = 0; i < ArraySize(g_lastTickets); i++)
     {
      ulong ticket = g_lastTickets[i];
      bool stillOpen = false;
      for(int j = 0; j < ArraySize(currentTickets); j++)
         if(currentTickets[j] == ticket) { stillOpen = true; break; }
      if(stillOpen) continue;

      string symbol = "";
      double pnl = 0;
      string reason = "manual"; // honest default if history lookup somehow finds nothing
      if(HistorySelectByPosition((long)ticket))
        {
         int deals = HistoryDealsTotal();
         for(int d = 0; d < deals; d++)
           {
            ulong dealTicket = HistoryDealGetTicket(d);
            if(dealTicket == 0) continue;
            if((int)HistoryDealGetInteger(dealTicket, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;
            symbol = HistoryDealGetString(dealTicket, DEAL_SYMBOL);
            pnl = HistoryDealGetDouble(dealTicket, DEAL_PROFIT)
                + HistoryDealGetDouble(dealTicket, DEAL_SWAP)
                + HistoryDealGetDouble(dealTicket, DEAL_COMMISSION);
            long dealReason = HistoryDealGetInteger(dealTicket, DEAL_REASON);
            if(dealReason == DEAL_REASON_TP) reason = "tp";
            else if(dealReason == DEAL_REASON_SL) reason = "sl";
            else if(dealReason == DEAL_REASON_EXPERT) reason = "dave";
            else if(dealReason == DEAL_REASON_CLIENT || dealReason == DEAL_REASON_MOBILE || dealReason == DEAL_REASON_WEB) reason = "manual";
            else reason = "manual";
           }
        }
      if(out != "") out += ",";
      out += "{\"ticket\":\"" + IntegerToString((int)ticket) + "\"," +
             "\"symbol\":\"" + symbol + "\"," +
             "\"pnl\":" + DoubleToString(pnl, 2) + "," +
             "\"reason\":\"" + reason + "\"}";
     }

   ArrayResize(g_lastTickets, ArraySize(currentTickets));
   for(int i = 0; i < ArraySize(currentTickets); i++)
      g_lastTickets[i] = currentTickets[i];

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
                           "\"message\":\"" + message + "\"" +
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
/**
 * Real batch-scan timeout fix (user, live: a full pair-group scan timed out on EVERY symbol
 * while single-symbol calls worked fine). Root cause confirmed: this EA processes a whole
 * drained command batch strictly serially in one blocking OnTimer tick, and LoadAnalysisSeries
 * blocked up to ~4s per NOT-YET-SYNCHRONIZED symbol (Sleep(200) x20) -- for a batch of N
 * "analyze" commands landing in the same tick, that's up to N*4s of serial stalling before any
 * of them finish, on top of results only shipping on the NEXT report. This kicks off MT5's
 * background history sync for every "analyze" command's symbol/timeframe UP FRONT, in one quick
 * pass, before the real (still serial) per-command execution loop below -- so by the time
 * LoadAnalysisSeries gets to the 3rd, 4th, 5th... symbol in the batch, MT5 has already been
 * downloading its history in the background for the time the earlier symbols took to process,
 * shrinking (often eliminating) the per-symbol Sleep-wait instead of paying it N times over.
 */
void PrewarmAnalysisSymbols(string arrBody)
  {
   int pos = 0;
   while(pos < StringLen(arrBody))
     {
      int objStart = StringFind(arrBody, "{", pos);
      if(objStart < 0) break;
      int objEnd = StringFind(arrBody, "}", objStart);
      if(objEnd < 0) break;
      string obj = StringSubstr(arrBody, objStart, objEnd - objStart + 1);
      if(JsonGetString(obj, "action") == "analyze")
        {
         string symbol = ResolveBrokerSymbol(JsonGetString(obj, "symbol"));
         ENUM_TIMEFRAMES tf = TimeframeFromString(JsonGetString(obj, "timeframe"));
         SymbolSelect(symbol, true);
         MqlRates warm[];
         CopyRates(symbol, tf, 0, DAVEEA_BARS, warm); // non-blocking kickoff -- return value/result unused here
        }
      pos = objEnd + 1;
     }
  }

void ExecuteCommandsFromResponse(string response)
  {
   int arrStart = StringFind(response, "\"commands\":[");
   if(arrStart < 0) return;
   arrStart += StringLen("\"commands\":[");
   int arrEnd = StringFind(response, "]", arrStart);
   if(arrEnd < 0) return;
   string arrBody = StringSubstr(response, arrStart, arrEnd - arrStart);
   if(StringLen(arrBody) == 0) return; // no commands this cycle

   PrewarmAnalysisSymbols(arrBody);

   int pos = 0;
   while(pos < StringLen(arrBody))
     {
      int objStart = StringFind(arrBody, "{", pos);
      if(objStart < 0) break;
      int objEnd = StringFind(arrBody, "}", objStart);
      if(objEnd < 0) break;
      string obj = StringSubstr(arrBody, objStart, objEnd - objStart + 1);
      ExecuteOneCommand(obj);
      pos = objEnd + 1;
     }
  }

string JsonGetString(string obj, string key)
  {
   string needle = "\"" + key + "\":\"";
   int start = StringFind(obj, needle);
   if(start < 0) return "";
   start += StringLen(needle);
   int end = StringFind(obj, "\"", start);
   if(end < 0) return "";
   return StringSubstr(obj, start, end - start);
  }

double JsonGetNumber(string obj, string key, double fallback)
  {
   string needle = "\"" + key + "\":";
   int start = StringFind(obj, needle);
   if(start < 0) return fallback;
   start += StringLen(needle);
   int end = start;
   while(end < StringLen(obj) && (StringGetCharacter(obj, end) == '-' || StringGetCharacter(obj, end) == '.' ||
         (StringGetCharacter(obj, end) >= '0' && StringGetCharacter(obj, end) <= '9')))
      end++;
   if(end == start) return fallback;
   return StringToDouble(StringSubstr(obj, start, end - start));
  }

// Real bug fixed (Part 1 item 2): the "modify" handler used to fetch sl/tp
// via JsonGetNumber(obj,"sl",0) -- fallback 0 for a KEY THAT WASN'T EVEN
// SENT. dave-ea-bridge's real modify command shape only ever includes the
// field(s) actually being changed (`{action:"modify",ticket,sl:null}` to
// remove SL only, `{...,tp:1.2345}` to change just TP, sl omitted
// entirely to leave it untouched). Falling back to 0 for an OMITTED key
// silently wiped whichever field wasn't in this particular command --
// there was never a way to touch just one side. These two helpers tell
// "field absent" (don't touch), explicit JSON `null` (remove -> 0), and a
// real number (set to that) apart.
bool JsonHasKey(string obj, string key)
  {
   return StringFind(obj, "\"" + key + "\":") >= 0;
  }

bool JsonIsNull(string obj, string key)
  {
   string needle = "\"" + key + "\":";
   int p = StringFind(obj, needle);
   if(p < 0) return false;
   p += StringLen(needle);
   return StringSubstr(obj, p, 4) == "null";
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
      if(!PositionSelectByTicket(ticket))
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
      RunAnalysis(id, endpoint, symbol, tfStr);
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

// Real bars loaded for the REQUESTED symbol+timeframe, index 0 = most recent (series order) --
// same convention the reference DAVEMA EA's O/H/L/C arrays used. g_aV/g_aT (volume/time) and
// g_aDigits/g_aPoint/g_aPip added when the other 43 endpoints were ported -- the original 3
// (trend/momentum/volatility) never needed them, but volume/session/candle-shape/order-flow/
// market-profile endpoints genuinely do.
int      g_anb = 0;
double   g_aO[], g_aH[], g_aL[], g_aC[];
long     g_aV[];
datetime g_aT[];
int      g_aDigits = 5;
double   g_aPoint = 0.00001, g_aPip = 0.0001;

// Real gap fixed (user: "the bars shouldn't [need to] fill [before it can] start working -- it
// can just use from the previous"). A real per-symbol+timeframe cache of the last successfully
// loaded bar series: when a fresh CopyRates() genuinely doesn't have enough bars yet (MT5 still
// downloading history for a symbol/timeframe combo nothing has asked for recently), this reuses
// the last real series already loaded for that exact combo instead of blocking on a live
// resync -- the real root cause of the reported analysis timeouts. Bounded to
// DAVEEA_CACHE_SLOTS combos (round-robin eviction) -- a real pair group's active symbols/
// timeframes all fit comfortably within that.
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

void SaveAnalysisCache(string key, int copied, MqlRates &rates[])
  {
   int slot = FindCacheSlot(key);
   if(slot < 0)
     {
      slot = g_cacheNextSlot;
      g_cacheNextSlot = (g_cacheNextSlot + 1) % DAVEEA_CACHE_SLOTS;
      g_cacheKey[slot] = key;
     }
   int n = MathMin(copied, DAVEEA_BARS);
   g_cacheNb[slot] = n;
   for(int i = 0; i < n; i++)
     {
      g_cacheO[slot][i] = rates[i].open;  g_cacheH[slot][i] = rates[i].high;
      g_cacheL[slot][i] = rates[i].low;   g_cacheC[slot][i] = rates[i].close;
      g_cacheV[slot][i] = rates[i].tick_volume; g_cacheT[slot][i] = rates[i].time;
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

// Real gap fixed (user report: "the bars are still entering" -- get_trend/get_momentum/
// get_volatility failing right after the EA is attached to a fresh symbol/timeframe): MT5
// caches price history PER symbol+timeframe and downloads it from the broker asynchronously
// the first time anything asks for it -- CopyRates() on a symbol nothing has touched yet can
// legitimately return 0 or a handful of bars on the FIRST call, even though the broker has
// years of real history available.
//
// Real gap fixed again (user: "the bars shouldn't [need to] fill [before it can] start
// working... it can just use from the previous"): a live, blocking Sleep-wait for a fresh
// resync was still the real cause of reported analysis timeouts. Now the real cached series
// from this exact symbol+timeframe's last successful load (DAVEEA_CACHE_SLOTS, above) is used
// FIRST when a fresh CopyRates() doesn't have enough bars yet -- genuinely real, previously
// loaded data, not fabricated -- so analysis never blocks on a live resync for a symbol/
// timeframe it has already seen before. The bounded live wait is now a LAST resort, only for a
// symbol+timeframe combo this EA has genuinely never loaded before (nothing cached to fall
// back to).
bool LoadAnalysisSeries(string sym, ENUM_TIMEFRAMES tf)
  {
   string key = sym + "|" + IntegerToString((int)tf);
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int copied = CopyRates(sym, tf, 0, DAVEEA_BARS, rates);
   if(copied > 20)
     {
      g_anb = copied;
      ArrayResize(g_aO, copied); ArrayResize(g_aH, copied); ArrayResize(g_aL, copied); ArrayResize(g_aC, copied);
      ArrayResize(g_aV, copied); ArrayResize(g_aT, copied);
      for(int i = 0; i < copied; i++)
        {
         g_aO[i] = rates[i].open; g_aH[i] = rates[i].high; g_aL[i] = rates[i].low; g_aC[i] = rates[i].close;
         g_aV[i] = rates[i].tick_volume; g_aT[i] = rates[i].time;
        }
      g_aDigits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      g_aPoint  = SymbolInfoDouble(sym, SYMBOL_POINT);
      g_aPip    = (g_aDigits == 3 || g_aDigits == 5) ? g_aPoint * 10 : g_aPoint;
      if(g_aPip <= 0) g_aPip = g_aPoint > 0 ? g_aPoint : 0.0001;
      SaveAnalysisCache(key, copied, rates);
      return true;
     }
   // Not enough freshly-copied bars -- use the real, previously loaded series for this EXACT
   // symbol+timeframe if we have one, instead of blocking on a live resync.
   if(LoadAnalysisCache(key))
     {
      g_aDigits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      g_aPoint  = SymbolInfoDouble(sym, SYMBOL_POINT);
      g_aPip    = (g_aDigits == 3 || g_aDigits == 5) ? g_aPoint * 10 : g_aPoint;
      if(g_aPip <= 0) g_aPip = g_aPoint > 0 ? g_aPoint : 0.0001;
      return true;
     }
   // Genuinely never loaded this symbol+timeframe before -- nothing cached to fall back to. One
   // real, bounded wait (not blocking indefinitely) since MT5 is downloading it right now;
   // PrewarmAnalysisSymbols already gave it a real head start before this per-command loop began.
   for(int attempt = 0; attempt < 10 && !SeriesInfoInteger(sym, tf, SERIES_SYNCHRONIZED); attempt++)
      Sleep(150);
   copied = CopyRates(sym, tf, 0, DAVEEA_BARS, rates);
   if(copied <= 20) return false; // genuinely no real history available at all, even after waiting
   g_anb = copied;
   ArrayResize(g_aO, copied); ArrayResize(g_aH, copied); ArrayResize(g_aL, copied); ArrayResize(g_aC, copied);
   ArrayResize(g_aV, copied); ArrayResize(g_aT, copied);
   for(int i = 0; i < copied; i++)
     {
      g_aO[i] = rates[i].open; g_aH[i] = rates[i].high; g_aL[i] = rates[i].low; g_aC[i] = rates[i].close;
      g_aV[i] = rates[i].tick_volume; g_aT[i] = rates[i].time;
     }
   g_aDigits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   g_aPoint  = SymbolInfoDouble(sym, SYMBOL_POINT);
   g_aPip    = (g_aDigits == 3 || g_aDigits == 5) ? g_aPoint * 10 : g_aPoint;
   if(g_aPip <= 0) g_aPip = g_aPoint > 0 ? g_aPoint : 0.0001;
   SaveAnalysisCache(key, copied, rates);
   return true;
  }

// --- Real indicator math, ported verbatim from the reference DAVEMA EA ---
double A_SMA(int period, int shift = 0)
  {
   if(shift + period > g_anb) return 0;
   double s = 0; for(int i = shift; i < shift + period; i++) s += g_aC[i];
   return s / period;
  }
double A_EMA(int period, int shift = 0)
  {
   int span = MathMin(g_anb - shift, period * 4);
   if(span < period) return 0;
   double k = 2.0 / (period + 1.0);
   double e = g_aC[shift + span - 1];
   for(int i = shift + span - 2; i >= shift; i--) e = g_aC[i] * k + e * (1 - k);
   return e;
  }
// Real gap fixed (user, SMC/ICT audit: "SMMA 6,20,100" -- genuinely missing before, only plain
// SMA/EMA existed at any period). A true smoothed moving average (Wilder-style RMA), NOT the same
// math as A_EMA above -- seeded with a real SMA over the oldest `period` bars in the bounded
// window, then smoothed forward one bar at a time toward the newest, same real recompute-from-
// scratch-every-call shape as A_EMA (no persisted state needed across ticks).
double A_SMMA(int period, int shift = 0)
  {
   int span = MathMin(g_anb - shift, period * 4);
   if(span < period) return 0;
   double s = 0;
   for(int i = shift + span - period; i < shift + span; i++) s += g_aC[i];
   double smma = s / period;
   for(int i = shift + span - period - 1; i >= shift; i--) smma = (smma * (period - 1) + g_aC[i]) / period;
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
double A_ATR(int period, int shift = 0)
  {
   if(shift + period + 1 > g_anb) return 0;
   double s = 0; for(int i = shift; i < shift + period; i++) s += A_TrueRange(i);
   return s / period;
  }
double A_RSI(int period, int shift = 0)
  {
   if(shift + period + 1 >= g_anb) return 50;
   double g = 0, l = 0;
   for(int i = shift; i < shift + period; i++)
     {
      double d = g_aC[i] - g_aC[i + 1];
      if(d > 0) g += d; else l -= d;
     }
   g /= period; l /= period;
   if(l == 0) return 100;
   double rs = g / l;
   return 100.0 - (100.0 / (1.0 + rs));
  }
void A_MACD(double &main, double &sig, double &hist)
  {
   main = A_EMA(12) - A_EMA(26);
   double vals[9];
   for(int i = 0; i < 9; i++) vals[i] = A_EMA(12, i) - A_EMA(26, i);
   double k = 2.0 / 10.0, e = vals[8];
   for(int i = 7; i >= 0; i--) e = vals[i] * k + e * (1 - k);
   sig  = e;
   hist = main - sig;
  }
void A_Stochastic(int kP, int dP, double &k, double &d)
  {
   k = 50; d = 50;
   if(kP + dP >= g_anb) return;
   double ks[]; ArrayResize(ks, dP);
   for(int j = 0; j < dP; j++)
     {
      double hi = g_aH[j], lo = g_aL[j];
      for(int i = j; i < j + kP; i++) { hi = MathMax(hi, g_aH[i]); lo = MathMin(lo, g_aL[i]); }
      ks[j] = (hi - lo) > 0 ? (g_aC[j] - lo) / (hi - lo) * 100.0 : 50;
     }
   k = ks[0];
   double s = 0; for(int j = 0; j < dP; j++) s += ks[j];
   d = s / dP;
  }
double A_CCI(int period)
  {
   if(period + 1 >= g_anb) return 0;
   double tp[]; ArrayResize(tp, period);
   for(int i = 0; i < period; i++) tp[i] = (g_aH[i] + g_aL[i] + g_aC[i]) / 3.0;
   double m = 0; for(int i = 0; i < period; i++) m += tp[i]; m /= period;
   double dev = 0; for(int i = 0; i < period; i++) dev += MathAbs(tp[i] - m); dev /= period;
   return dev > 0 ? (tp[0] - m) / (0.015 * dev) : 0;
  }
double A_WilliamsR(int period)
  {
   if(period >= g_anb) return -50;
   double hi = g_aH[0], lo = g_aL[0];
   for(int i = 0; i < period; i++) { hi = MathMax(hi, g_aH[i]); lo = MathMin(lo, g_aL[i]); }
   return (hi - lo) > 0 ? (hi - g_aC[0]) / (hi - lo) * -100.0 : -50;
  }

double A_Pips(string sym, double priceDiff)
  {
   double point = SymbolInfoDouble(sym, SYMBOL_POINT);
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   double pip = (digits == 3 || digits == 5) ? point * 10 : point;
   return pip > 0 ? priceDiff / pip : 0;
  }

// --- Real endpoint builders, ported verbatim from Ep_Trend/Ep_Momentum/Ep_Volatility ---
string A_Trend(string sym)
  {
   double ma20 = A_SMA(20), ma50 = A_SMA(50), ma200 = A_SMA(MathMin(200, g_anb - 1));
   double ema9 = A_EMA(9), ema21 = A_EMA(21);
   double ma20p = A_SMA(20, 5), ma50p = A_SMA(50, 5), ma200p = A_SMA(MathMin(200, g_anb - 6), 5);
   // Real gap fixed (user, SMC/ICT audit: "SMMA 6,20,100"). A genuinely smoothed MA, distinct
   // from the plain SMA/EMA above -- 100-period needs a real 400-bar window (period*4 inside
   // A_SMMA), so on a genuinely fresh symbol this honestly returns 0 like every other insufficient-
   // history case in this file, not a fabricated number.
   double smma6 = A_SMMA(6), smma20 = A_SMMA(20), smma100 = A_SMMA(100);
   // Real correction (trader, live strategy build-out): the real bias/score below now come from
   // SMMA(6,20,100), not the SMA/EMA stack -- the trader's own real trend system. SMA20/50/200 and
   // EMA9/21 stay in the JSON as supplementary context only; they no longer drive bias/score.
   int score = 0;
   if(g_aC[0] > smma6)     score++; else score--;
   if(g_aC[0] > smma20)    score++; else score--;
   if(g_aC[0] > smma100)   score++; else score--;
   if(smma6 > smma20)      score++; else score--;
   if(smma20 > smma100)    score++; else score--;
   string bias = score >= 4 ? "STRONG_BULL" : score >= 2 ? "BULL" : score <= -4 ? "STRONG_BEAR" : score <= -2 ? "BEAR" : "NEUTRAL";
   bool allBull = g_aC[0] > ma20 && ma20 > ma50 && ma50 > ma200;
   bool allBear = g_aC[0] < ma20 && ma20 < ma50 && ma50 < ma200;
   bool smmaAllBull = smma100 > 0 && g_aC[0] > smma6 && smma6 > smma20 && smma20 > smma100;
   bool smmaAllBear = smma100 > 0 && g_aC[0] < smma6 && smma6 < smma20 && smma20 < smma100;
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   return "{\"bias\":\"" + bias + "\",\"score\":" + IntegerToString(score) + "," +
          "\"slope_20\":" + DoubleToString(A_Pips(sym, ma20 - ma20p), 2) + "," +
          "\"slope_50\":" + DoubleToString(A_Pips(sym, ma50 - ma50p), 2) + "," +
          "\"ma20\":" + DoubleToString(ma20, digits) + ",\"ma50\":" + DoubleToString(ma50, digits) + ",\"ma200\":" + DoubleToString(ma200, digits) + "," +
          "\"ema9\":" + DoubleToString(ema9, digits) + ",\"ema21\":" + DoubleToString(ema21, digits) + "," +
          "\"price_vs_ma20\":\"" + (g_aC[0] > ma20 ? "ABOVE" : "BELOW") + "\"," +
          "\"price_vs_ma50\":\"" + (g_aC[0] > ma50 ? "ABOVE" : "BELOW") + "\"," +
          "\"price_vs_ma200\":\"" + (g_aC[0] > ma200 ? "ABOVE" : "BELOW") + "\"," +
          "\"ema9_vs_ema21\":\"" + (ema9 > ema21 ? "ABOVE" : "BELOW") + "\"," +
          "\"ma_rising_20\":" + (ma20 > ma20p ? "true" : "false") + ",\"ma_rising_50\":" + (ma50 > ma50p ? "true" : "false") + "," +
          "\"ma_rising_200\":" + (ma200 > ma200p ? "true" : "false") + "," +
          "\"golden_cross\":" + ((ma50 > ma200 && A_SMA(50, 3) <= A_SMA(MathMin(200, g_anb - 4), 3)) ? "true" : "false") + "," +
          "\"death_cross\":" + ((ma50 < ma200 && A_SMA(50, 3) >= A_SMA(MathMin(200, g_anb - 4), 3)) ? "true" : "false") + "," +
          "\"price_above_all_mas\":" + (allBull ? "true" : "false") + "," +
          "\"ma_alignment\":\"" + (allBull ? "PERFECT_BULL" : allBear ? "PERFECT_BEAR" : "MIXED") + "\"," +
          "\"dist_ma200_pips\":" + DoubleToString(A_Pips(sym, g_aC[0] - ma200), 1) + "," +
          "\"dist_ma50_pips\":" + DoubleToString(A_Pips(sym, g_aC[0] - ma50), 1) + "," +
          "\"smma6\":" + DoubleToString(smma6, digits) + ",\"smma20\":" + DoubleToString(smma20, digits) + ",\"smma100\":" + DoubleToString(smma100, digits) + "," +
          "\"price_vs_smma6\":\"" + (g_aC[0] > smma6 ? "ABOVE" : "BELOW") + "\"," +
          "\"price_vs_smma20\":\"" + (g_aC[0] > smma20 ? "ABOVE" : "BELOW") + "\"," +
          "\"price_vs_smma100\":\"" + (g_aC[0] > smma100 ? "ABOVE" : "BELOW") + "\"," +
          "\"smma_alignment\":\"" + (smmaAllBull ? "PERFECT_BULL" : smmaAllBear ? "PERFECT_BEAR" : "MIXED") + "\"}";
  }

string A_Momentum()
  {
   double rsi = A_RSI(14), rsiPrev = A_RSI(14, 1);
   double m, s, h; A_MACD(m, s, h);
   double mPrev = A_EMA(12, 1) - A_EMA(26, 1);
   double k, d; A_Stochastic(14, 3, k, d);
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
          "\"rsi_zone\":\"" + (rsi > 70 ? "OVERBOUGHT" : rsi < 30 ? "OVERSOLD" : "NEUTRAL") + "\"," +
          "\"rsi_slope\":" + DoubleToString(rsi - rsiPrev, 2) + "," +
          "\"macd_main\":" + DoubleToString(m, 8) + ",\"macd_signal\":" + DoubleToString(s, 8) + ",\"macd_hist\":" + DoubleToString(h, 8) + "," +
          "\"macd_dir\":\"" + (h > 0 ? "BULL" : "BEAR") + "\"," +
          "\"macd_above_zero\":" + (m > 0 ? "true" : "false") + "," +
          "\"macd_hist_growing\":" + (MathAbs(h) > MathAbs(mPrev - s) ? "true" : "false") + "," +
          "\"stoch_k\":" + DoubleToString(k, 2) + ",\"stoch_d\":" + DoubleToString(d, 2) + "," +
          "\"stoch_zone\":\"" + (k > 80 ? "OVERBOUGHT" : k < 20 ? "OVERSOLD" : "NEUTRAL") + "\"," +
          "\"stoch_cross\":\"" + (k > d ? "BULL" : "BEAR") + "\"," +
          "\"cci\":" + DoubleToString(cci, 2) + ",\"cci_zone\":\"" + (cci > 100 ? "OVERBOUGHT" : cci < -100 ? "OVERSOLD" : "NEUTRAL") + "\"," +
          "\"williams_r\":" + DoubleToString(wr, 2) + ",\"williams_zone\":\"" + (wr > -20 ? "OVERBOUGHT" : wr < -80 ? "OVERSOLD" : "NEUTRAL") + "\"," +
          "\"roc\":" + DoubleToString(roc, 4) + "," +
          "\"momentum_score\":" + IntegerToString(bull - bear) + ",\"max_score\":6," +
          "\"overall_signal\":\"" + (bull > bear ? "BULL" : bull < bear ? "BEAR" : "NEUTRAL") + "\"," +
          "\"bull_signals_count\":" + IntegerToString(bull) + ",\"bear_signals_count\":" + IntegerToString(bear) + "}";
  }

string A_Volatility(string sym)
  {
   double atr = A_ATR(14), atrPrev = A_ATR(14, 5), atrLong = A_ATR(MathMin(50, g_anb - 2));
   double sd = A_StdDev(20), ma20 = A_SMA(20);
   double bbU = ma20 + 2 * sd, bbL = ma20 - 2 * sd;
   double kcU = ma20 + 1.5 * atr, kcL = ma20 - 1.5 * atr;
   double pctB = (bbU - bbL) > 0 ? (g_aC[0] - bbL) / (bbU - bbL) : 0.5;
   int above = 0, total = 0;
   for(int i = 0; i < MathMin(g_anb - 15, 100); i++) { total++; if(A_ATR(14, i) < atr) above++; }
   double pctile = total > 0 ? (double)above / total * 100.0 : 50;
   double hv = A_StdDev(10) / MathMax(g_aC[0], SymbolInfoDouble(sym, SYMBOL_POINT)) * 100.0;
   int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
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
          "\"regime\":\"" + (pctile > 70 ? "HIGH" : pctile < 30 ? "LOW" : "NORMAL") + "\"}";
  }

//+------------------------------------------------------------------+
//| Item 8/DAVEMA retirement (batch 2): the remaining 43 of 46 real   |
//| endpoints, ported directly from the user's own real reference    |
//| DAVEMA_EA_1.mq5 -- same math, same thresholds, adapted only to    |
//| this file's naming (g_a* arrays/g_a* symbol info instead of the   |
//| reference's bare globals, A_ prefix instead of Ep_) and to        |
//| operate on the REQUESTED symbol/timeframe's series (item 13),     |
//| not just the chart's own. Nothing here is invented -- it is a     |
//| direct, careful port of real, working logic the user already had.|
//+------------------------------------------------------------------+

// --- Generic JSON-building helpers, ported verbatim from the reference EA ---
string J(string k, string v)          { return "\"" + k + "\":\"" + v + "\""; }
string Jn(string k, double v, int d=6){ return "\"" + k + "\":" + DoubleToString(v, d); }
string Ji(string k, long v)           { return "\"" + k + "\":" + IntegerToString(v); }
string Jb(string k, bool v)           { return "\"" + k + "\":" + (v ? "true" : "false"); }
string Jr(string k, string rawJson)   { return "\"" + k + "\":" + rawJson; }
string Obj(string body)               { return "{" + body + "}"; }
string A_Join(string &a[], string sep=",")
  {
   string s = "";
   for(int i = 0; i < ArraySize(a); i++) { if(i > 0) s += sep; s += a[i]; }
   return s;
  }
void A_Push(string &arr[], string v) { int n = ArraySize(arr); ArrayResize(arr, n + 1); arr[n] = v; }
string A_IsoTime(datetime t)
  {
   MqlDateTime d; TimeToStruct(t, d);
   return StringFormat("%04d-%02d-%02dT%02d:%02d:%02dZ", d.year, d.mon, d.day, d.hour, d.min, d.sec);
  }

// --- Swing/structure helpers, ported verbatim (operate on the loaded g_a* series) ---
double A_HighestHigh(int from, int count){ double v = g_aH[from]; for(int i = from; i < MathMin(g_anb, from + count); i++) v = MathMax(v, g_aH[i]); return v; }
double A_LowestLow (int from, int count){ double v = g_aL[from]; for(int i = from; i < MathMin(g_anb, from + count); i++) v = MathMin(v, g_aL[i]); return v; }
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
void A_CollectSwings(int k, int maxOut, double &hi[], int &hiBar[], double &lo[], int &loBar[])
  {
   ArrayResize(hi, 0); ArrayResize(lo, 0);
   ArrayResize(hiBar, 0); ArrayResize(loBar, 0);
   for(int i = k; i < g_anb - k && (ArraySize(hi) < maxOut || ArraySize(lo) < maxOut); i++)
     {
      if(ArraySize(hi) < maxOut && A_IsSwingHigh(i, k))
        { int n = ArraySize(hi); ArrayResize(hi, n+1); ArrayResize(hiBar, n+1); hi[n] = g_aH[i]; hiBar[n] = i; }
      if(ArraySize(lo) < maxOut && A_IsSwingLow(i, k))
        { int n = ArraySize(lo); ArrayResize(lo, n+1); ArrayResize(loBar, n+1); lo[n] = g_aL[i]; loBar[n] = i; }
     }
  }

// --- Session/time helpers ---
int A_UtcHour(){ MqlDateTime d; TimeToStruct(TimeGMT(), d); return d.hour; }
int A_UtcMin() { MqlDateTime d; TimeToStruct(TimeGMT(), d); return d.min; }
string A_KillzoneName()
  {
   int h = A_UtcHour();
   if(h >= 0 && h < 5)   return "ASIA";
   if(h >= 7 && h < 10)  return "LONDON_OPEN";
   if(h >= 12 && h < 15) return "NY_OPEN";
   if(h >= 15 && h < 17) return "LONDON_CLOSE";
   return "NONE";
  }

// --- Cross-symbol helpers (real reads via iClose, independent of the loaded g_a* series) ---
double A_SymReturn(string sym, ENUM_TIMEFRAMES tf, int bars)
  {
   double c0 = iClose(sym, tf, 0), cn = iClose(sym, tf, bars);
   return (cn != 0) ? (c0 - cn) / cn * 100.0 : 0;
  }
void A_CurrencyStrengths(ENUM_TIMEFRAMES tf, string &cur[], double &str[])
  {
   string ccy[8] = {"USD","EUR","GBP","JPY","AUD","NZD","CAD","CHF"};
   string pairs[28] = {"EURUSD","GBPUSD","AUDUSD","NZDUSD","USDJPY","USDCAD","USDCHF",
                       "EURGBP","EURJPY","EURAUD","EURNZD","EURCAD","EURCHF",
                       "GBPJPY","GBPAUD","GBPNZD","GBPCAD","GBPCHF",
                       "AUDJPY","AUDNZD","AUDCAD","AUDCHF",
                       "NZDJPY","NZDCAD","NZDCHF","CADJPY","CADCHF","CHFJPY"};
   ArrayResize(cur, 8); ArrayResize(str, 8);
   for(int i = 0; i < 8; i++) { cur[i] = ccy[i]; str[i] = 0; }
   for(int p = 0; p < 28; p++)
     {
      double r = A_SymReturn(pairs[p], tf, 20);
      if(r == 0) continue;
      string base  = StringSubstr(pairs[p], 0, 3);
      string quote = StringSubstr(pairs[p], 3, 3);
      for(int i = 0; i < 8; i++)
        {
         if(cur[i] == base)  str[i] += r;
         if(cur[i] == quote) str[i] -= r;
        }
     }
  }

//--- 01 price --------------------------------------------------------
string A_Price(string sym)
  {
   MqlTick tk; SymbolInfoTick(sym, tk);
   double bid = tk.bid, ask = tk.ask, mid = (bid + ask) / 2.0;
   double spread = ask - bid;
   double dayHi = A_HighestHigh(0, 24), dayLo = A_LowestLow(0, 24);
   double wkHi  = A_HighestHigh(0, 120), wkLo = A_LowestLow(0, 120);
   double mnHi  = A_HighestHigh(0, 480), mnLo = A_LowestLow(0, 480);
   double yHi   = A_HighestHigh(0, g_anb), yLo = A_LowestLow(0, g_anb);
   double prevC = g_anb > 1 ? g_aC[1] : g_aC[0], prevO = g_anb > 1 ? g_aO[1] : g_aO[0];
   string f[];
   A_Push(f, Jn("bid", bid, g_aDigits));  A_Push(f, Jn("ask", ask, g_aDigits));
   A_Push(f, Jn("mid", mid, g_aDigits));
   A_Push(f, Jn("spread_pts", g_aPoint > 0 ? spread / g_aPoint : 0, 1));
   A_Push(f, Jn("spread_pips", A_Pips(sym, spread), 2));
   A_Push(f, Jn("day_high", dayHi, g_aDigits)); A_Push(f, Jn("day_low", dayLo, g_aDigits));
   A_Push(f, Jn("day_range_pips", A_Pips(sym, dayHi - dayLo), 1));
   A_Push(f, Jn("prev_close", prevC, g_aDigits)); A_Push(f, Jn("prev_open", prevO, g_aDigits));
   A_Push(f, Jn("change_pts", g_aPoint > 0 ? (g_aC[0] - prevC) / g_aPoint : 0, 1));
   A_Push(f, Jn("change_pct", prevC != 0 ? (g_aC[0] - prevC) / prevC * 100.0 : 0, 4));
   A_Push(f, Jn("week_high", wkHi, g_aDigits)); A_Push(f, Jn("week_low", wkLo, g_aDigits));
   A_Push(f, Jn("week_range_pips", A_Pips(sym, wkHi - wkLo), 1));
   A_Push(f, Jn("month_high", mnHi, g_aDigits)); A_Push(f, Jn("month_low", mnLo, g_aDigits));
   A_Push(f, Jn("hi_52w", yHi, g_aDigits)); A_Push(f, Jn("lo_52w", yLo, g_aDigits));
   A_Push(f, Ji("digits", g_aDigits));
   A_Push(f, Jn("point", g_aPoint, 8)); A_Push(f, Jn("pip", g_aPip, 8));
   A_Push(f, Jn("tick_value", SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE), 6));
   A_Push(f, Jn("tick_size",  SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE), 8));
   A_Push(f, Jn("swap_long",  SymbolInfoDouble(sym, SYMBOL_SWAP_LONG), 4));
   A_Push(f, Jn("swap_short", SymbolInfoDouble(sym, SYMBOL_SWAP_SHORT), 4));
   A_Push(f, Jn("min_lot",  SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN), 2));
   A_Push(f, Jn("max_lot",  SymbolInfoDouble(sym, SYMBOL_VOLUME_MAX), 2));
   A_Push(f, Jn("lot_step", SymbolInfoDouble(sym, SYMBOL_VOLUME_STEP), 2));
   return Obj(A_Join(f));
  }

//--- 02 structure ------------------------------------------------------
string A_Structure(string sym)
  {
   double sh[], sl[]; int shB[], slB[];
   A_CollectSwings(SwingLookback, 5, sh, shB, sl, slB);
   double swingHigh = ArraySize(sh) > 0 ? sh[0] : A_HighestHigh(0, 50);
   double swingLow  = ArraySize(sl) > 0 ? sl[0] : A_LowestLow(0, 50);
   double prevHigh  = ArraySize(sh) > 1 ? sh[1] : swingHigh;
   double prevLow   = ArraySize(sl) > 1 ? sl[1] : swingLow;
   bool hh = swingHigh > prevHigh, hl = swingLow > prevLow;
   bool lh = swingHigh < prevHigh, ll = swingLow < prevLow;
   string trend = hh && hl ? "HH_HL" : (lh && ll ? "LH_LL" : (hh && ll ? "HH_LL" : "LH_HL"));
   string bos = "NONE", choch = "NONE", mss = "NONE", cisd = "NONE";
   int barsSinceBos = -1;
   for(int i = 1; i < MathMin(g_anb, 60); i++)
     {
      if(g_aC[i] > swingHigh && bos == "NONE") { bos = "BULL"; barsSinceBos = i; }
      if(g_aC[i] < swingLow  && bos == "NONE") { bos = "BEAR"; barsSinceBos = i; }
     }
   if(g_aC[0] > swingHigh) { bos = "BULL"; barsSinceBos = 0; }
   if(g_aC[0] < swingLow)  { bos = "BEAR"; barsSinceBos = 0; }
   if(bos == "BULL" && trend == "LH_LL") choch = "BULL";
   if(bos == "BEAR" && trend == "HH_HL") choch = "BEAR";
   if(choch != "NONE") mss = choch;
   if(g_anb > 3)
     {
      if(g_aC[0] > g_aO[1] && g_aC[1] < g_aO[1] && g_aC[2] < g_aO[2]) cisd = "BULL";
      if(g_aC[0] < g_aO[1] && g_aC[1] > g_aO[1] && g_aC[2] > g_aO[2]) cisd = "BEAR";
     }
   double dr_hi = A_HighestHigh(0, 50), dr_lo = A_LowestLow(0, 50);
   double eq    = (dr_hi + dr_lo) / 2.0;
   string pd    = g_aC[0] > eq ? "PREMIUM" : "DISCOUNT";
   double oteHi = dr_lo + (dr_hi - dr_lo) * 0.79;
   double oteLo = dr_lo + (dr_hi - dr_lo) * 0.62;
   string eqH[], eqL[];
   double tol = EqTolerancePips * g_aPip;
   for(int i = 0; i + 1 < ArraySize(sh); i++)
      if(MathAbs(sh[i] - sh[i+1]) <= tol) A_Push(eqH, DoubleToString(sh[i], g_aDigits));
   for(int i = 0; i + 1 < ArraySize(sl); i++)
      if(MathAbs(sl[i] - sl[i+1]) <= tol) A_Push(eqL, DoubleToString(sl[i], g_aDigits));
   string shArr[], slArr[];
   for(int i = 0; i < ArraySize(sh); i++) A_Push(shArr, DoubleToString(sh[i], g_aDigits));
   for(int i = 0; i < ArraySize(sl); i++) A_Push(slArr, DoubleToString(sl[i], g_aDigits));
   double idmLevel = ArraySize(sl) > 1 ? sl[1] : swingLow;
   string idm = Obj(Jb("detected", ArraySize(sl) > 1) + "," + Jn("level", idmLevel, g_aDigits) + "," +
                    J("type", bos == "BULL" ? "SSL" : "BSL") + "," + Ji("bar", ArraySize(slB) > 1 ? slB[1] : 0));
   string qml = Obj(Jb("detected", choch != "NONE") + "," + Jn("level", choch == "BULL" ? prevLow : prevHigh, g_aDigits) + "," +
                    J("type", choch));
   double strength = MathMin(100.0, MathAbs(A_Pips(sym, g_aC[0] - eq)) / MathMax(1.0, A_Pips(sym, dr_hi - dr_lo)) * 200.0);
   string f[];
   A_Push(f, J("trend", trend));   A_Push(f, J("bos", bos));   A_Push(f, J("choch", choch));
   A_Push(f, J("mss", mss));       A_Push(f, J("cisd", cisd));
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
   A_Push(f, Jn("ote_zone_high", oteHi, g_aDigits)); A_Push(f, Jn("ote_zone_low", oteLo, g_aDigits));
   A_Push(f, Jn("ce", eq, g_aDigits));
   A_Push(f, J("internal_bos", bos)); A_Push(f, J("external_bos", bos));
   A_Push(f, Ji("bars_since_bos", barsSinceBos));
   A_Push(f, Jn("trend_strength", strength, 1));
   A_Push(f, Jr("swing_highs_array", "[" + A_Join(shArr) + "]"));
   A_Push(f, Jr("swing_lows_array",  "[" + A_Join(slArr) + "]"));
   return Obj(A_Join(f));
  }

//--- 03 zones ------------------------------------------------------
string A_Zones(string sym)
  {
   string sup[], dem[];
   double nearestSupply = 0, nearestDemand = 0;
   double strongestLvl = 0; string strongestType = "NONE"; double strongestScore = -1;
   for(int i = 2; i < MathMin(g_anb - 2, 200) && (ArraySize(sup) < ZoneMax || ArraySize(dem) < ZoneMax); i++)
     {
      double body = MathAbs(g_aC[i] - g_aO[i]), rng = MathMax(g_aH[i] - g_aL[i], g_aPoint);
      double ratio = body / rng;
      bool downMove = g_aC[i - 1] < g_aL[i], upMove = g_aC[i - 1] > g_aH[i];
      if(ArraySize(sup) < ZoneMax && g_aC[i] > g_aO[i] && downMove)
        {
         int tests = 0;
         for(int j = i - 1; j >= 0; j--) if(g_aH[j] >= g_aL[i] && g_aH[j] <= g_aH[i]) tests++;
         double mit = 0; if(g_aH[0] > g_aL[i]) mit = MathMin(100.0, (g_aH[0] - g_aL[i]) / rng * 100.0);
         double score = (100.0 - tests * 15.0) * ratio;
         A_Push(sup, Obj(Jn("top", g_aH[i], g_aDigits) + "," + Jn("bot", g_aL[i], g_aDigits) + "," +
                       Ji("bar", i) + "," + Jb("fresh", tests == 0) + "," + Jn("strength", score, 1) + "," +
                       Ji("tests", tests) + "," + Jn("body_ratio", ratio, 3) + "," + Jn("mitigation_pct", mit, 1)));
         if(nearestSupply == 0 && g_aL[i] > g_aC[0]) nearestSupply = g_aL[i];
         if(score > strongestScore) { strongestScore = score; strongestLvl = (g_aH[i]+g_aL[i])/2; strongestType = "SUPPLY"; }
        }
      if(ArraySize(dem) < ZoneMax && g_aC[i] < g_aO[i] && upMove)
        {
         int tests = 0;
         for(int j = i - 1; j >= 0; j--) if(g_aL[j] <= g_aH[i] && g_aL[j] >= g_aL[i]) tests++;
         double mit = 0; if(g_aL[0] < g_aH[i]) mit = MathMin(100.0, (g_aH[i] - g_aL[0]) / rng * 100.0);
         double score = (100.0 - tests * 15.0) * ratio;
         A_Push(dem, Obj(Jn("top", g_aH[i], g_aDigits) + "," + Jn("bot", g_aL[i], g_aDigits) + "," +
                       Ji("bar", i) + "," + Jb("fresh", tests == 0) + "," + Jn("strength", score, 1) + "," +
                       Ji("tests", tests) + "," + Jn("body_ratio", ratio, 3) + "," + Jn("mitigation_pct", mit, 1)));
         if(nearestDemand == 0 && g_aH[i] < g_aC[0]) nearestDemand = g_aH[i];
         if(score > strongestScore) { strongestScore = score; strongestLvl = (g_aH[i]+g_aL[i])/2; strongestType = "DEMAND"; }
        }
     }
   bool inZone = (nearestSupply > 0 && g_aC[0] >= nearestSupply) || (nearestDemand > 0 && g_aC[0] <= nearestDemand);
   // Real gap fixed (user, SMC/ICT audit: "retest logic... nothing distinguishes a clean rejection
   // retest from a retest that broke through"). `tests`/`mitigation_pct` above only ever answer
   // "has this been touched" -- this genuinely reads the CURRENT real candle's wick against the
   // real nearest zone boundary: a real wick into the zone that closes back out is a clean
   // rejection; a real close through the zone boundary is a genuine break, not a rejection at all.
   string retestQuality = "NONE"; string retestZoneType = "NONE";
   if(nearestSupply > 0 && g_aH[0] >= nearestSupply)
     { retestZoneType = "SUPPLY"; retestQuality = g_aC[0] < nearestSupply ? "CLEAN_REJECTION" : "BROKEN_THROUGH"; }
   else if(nearestDemand > 0 && g_aL[0] <= nearestDemand)
     { retestZoneType = "DEMAND"; retestQuality = g_aC[0] > nearestDemand ? "CLEAN_REJECTION" : "BROKEN_THROUGH"; }
   // Real gap fixed (trader, live strategy build-out): "add support and resistant level" --
   // classic horizontal S/R, distinct from the SMC-style supply/demand zones above. Reuses the
   // same real swing-collection + equal-level clustering pattern A_Liquidity already uses for
   // BSL/SSL (SwingLookback/EqTolerancePips), but reports every real cluster with 2+ touches as
   // a genuine S/R level (not just exact-equal pairs), split into resistance (above price) and
   // support (below price).
   double sh2[], sl2[]; int sh2B[], sl2B[];
   A_CollectSwings(SwingLookback, 20, sh2, sh2B, sl2, sl2B);
   double srTol = EqTolerancePips * g_aPip;
   string resist[], support[];
   double nearestResistance = 0, nearestSupport = 0;
   for(int i = 0; i < ArraySize(sh2) && ArraySize(resist) < ZoneMax; i++)
     {
      bool used = false;
      for(int u = 0; u < ArraySize(resist); u++) if(StringFind(resist[u], DoubleToString(sh2[i], g_aDigits)) >= 0) { used = true; break; }
      if(used) continue;
      int touches = 0;
      for(int j = 0; j < ArraySize(sh2); j++) if(MathAbs(sh2[j] - sh2[i]) <= srTol) touches++;
      if(touches < 2) continue;
      A_Push(resist, Obj(Jn("level", sh2[i], g_aDigits) + "," + Ji("touches", touches) + "," + Jn("dist_pips", A_Pips(sym, sh2[i] - g_aC[0]), 1)));
      if((nearestResistance == 0 || sh2[i] < nearestResistance) && sh2[i] > g_aC[0]) nearestResistance = sh2[i];
     }
   for(int i = 0; i < ArraySize(sl2) && ArraySize(support) < ZoneMax; i++)
     {
      bool used = false;
      for(int u = 0; u < ArraySize(support); u++) if(StringFind(support[u], DoubleToString(sl2[i], g_aDigits)) >= 0) { used = true; break; }
      if(used) continue;
      int touches = 0;
      for(int j = 0; j < ArraySize(sl2); j++) if(MathAbs(sl2[j] - sl2[i]) <= srTol) touches++;
      if(touches < 2) continue;
      A_Push(support, Obj(Jn("level", sl2[i], g_aDigits) + "," + Ji("touches", touches) + "," + Jn("dist_pips", A_Pips(sym, g_aC[0] - sl2[i]), 1)));
      if((nearestSupport == 0 || sl2[i] > nearestSupport) && sl2[i] < g_aC[0]) nearestSupport = sl2[i];
     }
   string f[];
   A_Push(f, Jr("supply", "[" + A_Join(sup) + "]"));
   A_Push(f, Jr("demand", "[" + A_Join(dem) + "]"));
   A_Push(f, Ji("supply_count", ArraySize(sup)));
   A_Push(f, Ji("demand_count", ArraySize(dem)));
   A_Push(f, Jr("nearest_supply", Obj(Jn("level", nearestSupply, g_aDigits) + "," + Jn("dist_pips", A_Pips(sym, nearestSupply - g_aC[0]), 1))));
   A_Push(f, Jr("nearest_demand", Obj(Jn("level", nearestDemand, g_aDigits) + "," + Jn("dist_pips", A_Pips(sym, g_aC[0] - nearestDemand), 1))));
   A_Push(f, Jb("price_in_zone", inZone));
   A_Push(f, J("zone_at_price", inZone ? (g_aC[0] >= nearestSupply && nearestSupply > 0 ? "SUPPLY" : "DEMAND") : "NONE"));
   A_Push(f, Jr("strongest_zone", Obj(J("type", strongestType) + "," + Jn("level", strongestLvl, g_aDigits))));
   A_Push(f, Jr("retest", Obj(J("zone_type", retestZoneType) + "," + J("quality", retestQuality))));
   A_Push(f, Jr("resistance", "[" + A_Join(resist) + "]"));
   A_Push(f, Jr("support", "[" + A_Join(support) + "]"));
   A_Push(f, Jr("nearest_resistance", Obj(Jn("level", nearestResistance, g_aDigits) + "," + Jn("dist_pips", A_Pips(sym, nearestResistance - g_aC[0]), 1))));
   A_Push(f, Jr("nearest_support", Obj(Jn("level", nearestSupport, g_aDigits) + "," + Jn("dist_pips", A_Pips(sym, g_aC[0] - nearestSupport), 1))));
   return Obj(A_Join(f));
  }

//--- 04 liquidity --------------------------------------------------
string A_Liquidity(string sym)
  {
   double sh[], sl[]; int shB[], slB[];
   A_CollectSwings(SwingLookback, 8, sh, shB, sl, slB);
   double tol = EqTolerancePips * g_aPip;
   string bsl[], ssl[], eqH[], eqL[], irl[], erl[];
   double nearBsl = 0, nearSsl = 0;
   for(int i = 0; i + 1 < ArraySize(sh); i++)
     {
      if(MathAbs(sh[i] - sh[i+1]) <= tol)
        {
         A_Push(bsl, Obj(Jn("level", sh[i], g_aDigits) + "," + Ji("bar1", shB[i]) + "," +
                       Ji("bar2", shB[i+1]) + "," + Jn("dist_pips", A_Pips(sym, sh[i] - g_aC[0]), 1)));
         A_Push(eqH, DoubleToString(sh[i], g_aDigits));
         if(nearBsl == 0 && sh[i] > g_aC[0]) nearBsl = sh[i];
        }
     }
   for(int i = 0; i + 1 < ArraySize(sl); i++)
     {
      if(MathAbs(sl[i] - sl[i+1]) <= tol)
        {
         A_Push(ssl, Obj(Jn("level", sl[i], g_aDigits) + "," + Ji("bar1", slB[i]) + "," +
                       Ji("bar2", slB[i+1]) + "," + Jn("dist_pips", A_Pips(sym, g_aC[0] - sl[i]), 1)));
         A_Push(eqL, DoubleToString(sl[i], g_aDigits));
         if(nearSsl == 0 && sl[i] < g_aC[0]) nearSsl = sl[i];
        }
     }
   if(nearBsl == 0 && ArraySize(sh) > 0) nearBsl = sh[0];
   if(nearSsl == 0 && ArraySize(sl) > 0) nearSsl = sl[0];
   for(int i = 0; i < MathMin(3, ArraySize(sh)); i++) A_Push(irl, Obj(Jn("level", sh[i], g_aDigits) + "," + J("type", "HIGH")));
   for(int i = 0; i < MathMin(3, ArraySize(sl)); i++) A_Push(erl, Obj(Jn("level", sl[i], g_aDigits) + "," + J("type", "LOW")));
   bool bslSwept = false, sslSwept = false;
   string sweepType = "NONE"; double sweepLevel = 0; int sweepBar = -1;
   for(int i = 0; i < MathMin(g_anb, 20); i++)
     {
      if(nearBsl > 0 && g_aH[i] > nearBsl && g_aC[i] < nearBsl && !bslSwept)
        { bslSwept = true; sweepType = "BSL"; sweepLevel = nearBsl; sweepBar = i; }
      if(nearSsl > 0 && g_aL[i] < nearSsl && g_aC[i] > nearSsl && !sslSwept)
        { sslSwept = true; if(sweepBar < 0) { sweepType = "SSL"; sweepLevel = nearSsl; sweepBar = i; } }
     }
   bool voidAbove = false, voidBelow = false;
   for(int i = 1; i + 1 < MathMin(g_anb, 30); i++)
     {
      if(g_aL[i - 1] > g_aH[i + 1]) voidAbove = true;
      if(g_aH[i - 1] < g_aL[i + 1]) voidBelow = true;
     }
   string f[];
   A_Push(f, Jr("bsl", "[" + A_Join(bsl) + "]"));  A_Push(f, Jr("ssl", "[" + A_Join(ssl) + "]"));
   A_Push(f, Ji("bsl_count", ArraySize(bsl)));   A_Push(f, Ji("ssl_count", ArraySize(ssl)));
   A_Push(f, Jb("bsl_swept", bslSwept));         A_Push(f, Jb("ssl_swept", sslSwept));
   A_Push(f, Jr("nearest_bsl", Obj(Jn("level", nearBsl, g_aDigits) + "," + Jn("dist_pips", A_Pips(sym, nearBsl - g_aC[0]), 1))));
   A_Push(f, Jr("nearest_ssl", Obj(Jn("level", nearSsl, g_aDigits) + "," + Jn("dist_pips", A_Pips(sym, g_aC[0] - nearSsl), 1))));
   A_Push(f, Jr("idm", Obj(Jn("level", nearSsl, g_aDigits) + "," + J("type", "SSL"))));
   A_Push(f, Jr("irl", "[" + A_Join(irl) + "]"));  A_Push(f, Jr("erl", "[" + A_Join(erl) + "]"));
   A_Push(f, Jb("liquidity_void_above", voidAbove));
   A_Push(f, Jb("liquidity_void_below", voidBelow));
   A_Push(f, Jr("equal_highs", "[" + A_Join(eqH) + "]"));
   A_Push(f, Jr("equal_lows",  "[" + A_Join(eqL) + "]"));
   A_Push(f, Jr("most_recent_sweep", Obj(J("type", sweepType) + "," + Jn("level", sweepLevel, g_aDigits) + "," + Ji("bar", sweepBar))));
   return Obj(A_Join(f));
  }

//--- 08 volume -----------------------------------------------------
string A_Volume()
  {
   double cur = (double)g_aV[0], a20 = 0, a50 = 0;
   int n20 = MathMin(20, g_anb), n50 = MathMin(50, g_anb);
   for(int i = 0; i < n20; i++) a20 += (double)g_aV[i]; a20 /= n20;
   for(int i = 0; i < n50; i++) a50 += (double)g_aV[i]; a50 /= n50;
   double bullV = 0, bearV = 0;
   for(int i = 0; i < n20; i++) { if(g_aC[i] >= g_aO[i]) bullV += (double)g_aV[i]; else bearV += (double)g_aV[i]; }
   double delta = (bullV + bearV) > 0 ? (bullV - bearV) / (bullV + bearV) * 100.0 : 0;
   string last[];
   for(int i = 0; i < MathMin(10, g_anb); i++) A_Push(last, IntegerToString((long)g_aV[i]));
   string f[];
   A_Push(f, Jn("current", cur, 0)); A_Push(f, Jn("avg_20", a20, 1)); A_Push(f, Jn("avg_50", a50, 1));
   A_Push(f, J("state", cur > a20 * 1.5 ? "HIGH" : cur < a20 * 0.5 ? "LOW" : "NORMAL"));
   A_Push(f, Jn("vs_avg20", a20 > 0 ? cur / a20 : 1, 3));
   A_Push(f, Jb("trending_up", a20 > a50));
   A_Push(f, Jn("bull_vol", bullV, 0)); A_Push(f, Jn("bear_vol", bearV, 0));
   A_Push(f, Jn("delta_pct", delta, 2));
   A_Push(f, J("vol_bias", delta > 10 ? "BULL" : delta < -10 ? "BEAR" : "NEUTRAL"));
   A_Push(f, Jb("vol_spike", cur > a20 * 2.0));
   A_Push(f, Jb("vol_climax", cur > a50 * 3.0));
   A_Push(f, Jb("rising_price_rising_vol", g_anb > 1 && g_aC[0] > g_aC[1] && cur > a20));
   A_Push(f, Jb("rising_price_falling_vol", g_anb > 1 && g_aC[0] > g_aC[1] && cur < a20));
   A_Push(f, Jr("last_10", "[" + A_Join(last) + "]"));
   return Obj(A_Join(f));
  }

//--- 09 ichimoku ---------------------------------------------------
string A_Ichimoku()
  {
   double tenkan = (A_HighestHigh(0, 9) + A_LowestLow(0, 9)) / 2.0;
   double kijun  = (A_HighestHigh(0, 26) + A_LowestLow(0, 26)) / 2.0;
   double spanA  = (tenkan + kijun) / 2.0;
   double spanB  = (A_HighestHigh(0, 52) + A_LowestLow(0, 52)) / 2.0;
   double chikou = g_aC[0];
   double top = MathMax(spanA, spanB), bot = MathMin(spanA, spanB);
   double tenkanPrev = (A_HighestHigh(3, 9) + A_LowestLow(3, 9)) / 2.0;
   double kijunPrev  = (A_HighestHigh(3, 26) + A_LowestLow(3, 26)) / 2.0;
   // Real correction (trader): tk_cross is not needed -- removed from both the score and the
   // output below. max_score drops from 6 to 5, thresholds rescaled proportionally.
   int score = 0;
   if(g_aC[0] > top)       score++;
   if(spanA > spanB)    score++;
   if(g_aC[0] > tenkan)    score++;
   if(g_aC[0] > kijun)     score++;
   if(g_anb > 26 && chikou > g_aC[26]) score++;
   string f[];
   A_Push(f, Jn("tenkan", tenkan, g_aDigits)); A_Push(f, Jn("kijun", kijun, g_aDigits));
   A_Push(f, Jn("senkou_a", spanA, g_aDigits)); A_Push(f, Jn("senkou_b", spanB, g_aDigits));
   A_Push(f, Jn("chikou", chikou, g_aDigits));
   A_Push(f, Jr("cloud", Obj(J("color", spanA > spanB ? "BULL" : "BEAR") + "," +
        Jn("top", top, g_aDigits) + "," + Jn("bottom", bot, g_aDigits) + "," +
        Jn("thickness_pips", (top - bot) / MathMax(g_aPip, 1e-10), 1) + "," + Jb("price_inside", g_aC[0] <= top && g_aC[0] >= bot))));
   A_Push(f, J("price_vs_cloud", g_aC[0] > top ? "ABOVE" : g_aC[0] < bot ? "BELOW" : "INSIDE"));
   A_Push(f, J("price_vs_tenkan", g_aC[0] > tenkan ? "ABOVE" : "BELOW"));
   A_Push(f, J("price_vs_kijun",  g_aC[0] > kijun  ? "ABOVE" : "BELOW"));
   A_Push(f, Jn("tenkan_slope", (tenkan - tenkanPrev) / MathMax(g_aPip, 1e-10), 2));
   A_Push(f, Jn("kijun_slope",  (kijun - kijunPrev) / MathMax(g_aPip, 1e-10), 2));
   A_Push(f, J("chikou_vs_price", g_anb > 26 && chikou > g_aC[26] ? "ABOVE" : "BELOW"));
   A_Push(f, J("chikou_vs_cloud", chikou > top ? "ABOVE" : chikou < bot ? "BELOW" : "INSIDE"));
   A_Push(f, Jb("flat_kijun", MathAbs(kijun - kijunPrev) < g_aPip));
   A_Push(f, Jb("kijun_support", g_aC[0] > kijun && MathAbs(g_aC[0]-kijun) < A_ATR(14)));
   A_Push(f, Jb("kijun_resistance", g_aC[0] < kijun && MathAbs(g_aC[0]-kijun) < A_ATR(14)));
   A_Push(f, Jb("kumo_twist", (spanA > spanB) != ((tenkanPrev + kijunPrev) / 2.0 > spanB)));
   A_Push(f, J("signal", score >= 4 ? "STRONG_BULL" : score == 3 ? "BULL" : score == 1 ? "BEAR" : score == 0 ? "STRONG_BEAR" : "NEUTRAL"));
   A_Push(f, Ji("score", score)); A_Push(f, Ji("max_score", 5));
   A_Push(f, Jn("dist_tenkan_pips", (g_aC[0] - tenkan) / MathMax(g_aPip, 1e-10), 1));
   A_Push(f, Jn("dist_kijun_pips",  (g_aC[0] - kijun) / MathMax(g_aPip, 1e-10), 1));
   A_Push(f, Jb("all_conditions_bull", score == 5));
   A_Push(f, Jb("all_conditions_bear", score == 0));
   return Obj(A_Join(f));
  }

//--- 10 fibonacci --------------------------------------------------
string A_Fibonacci(string sym)
  {
   int look = MathMin(100, g_anb - 1);
   double hi = A_HighestHigh(0, look), lo = A_LowestLow(0, look);
   int hiBar = 0, loBar = 0;
   for(int i = 0; i < look; i++) { if(g_aH[i] == hi) hiBar = i; if(g_aL[i] == lo) loBar = i; }
   bool swingUp = loBar > hiBar;
   double rng = hi - lo;
   double f0   = swingUp ? hi : lo;
   double f100 = swingUp ? lo : hi;
   double lv[7], px[7];
   double ratios[7] = {0.0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0};
   for(int i = 0; i < 7; i++) { lv[i] = ratios[i]; px[i] = f0 + (f100 - f0) * ratios[i]; }
   double best = 1e18; int bestI = 0;
   for(int i = 0; i < 7; i++) { double dd = MathAbs(g_aC[0] - px[i]); if(dd < best) { best = dd; bestI = i; } }
   double oteHi = swingUp ? lo + rng * 0.79 : hi - rng * 0.62;
   double oteLo = swingUp ? lo + rng * 0.62 : hi - rng * 0.79;
   double pos   = rng > 0 ? (g_aC[0] - lo) / rng : 0.5;
   double ma50  = A_SMA(50);
   string f[];
   A_Push(f, Jn("high", hi, g_aDigits)); A_Push(f, Jn("low", lo, g_aDigits));
   A_Push(f, Jn("range_pips", A_Pips(sym, rng), 1)); A_Push(f, Jb("swing_up", swingUp));
   A_Push(f, Jn("f0", px[0], g_aDigits));   A_Push(f, Jn("f236", px[1], g_aDigits));
   A_Push(f, Jn("f382", px[2], g_aDigits)); A_Push(f, Jn("f500", px[3], g_aDigits));
   A_Push(f, Jn("f618", px[4], g_aDigits)); A_Push(f, Jn("f786", px[5], g_aDigits));
   A_Push(f, Jn("f100", px[6], g_aDigits));
   A_Push(f, Jn("e127", f0 + (f100 - f0) * 1.272, g_aDigits));
   A_Push(f, Jn("e161", f0 + (f100 - f0) * 1.618, g_aDigits));
   A_Push(f, Jn("e200", f0 + (f100 - f0) * 2.0, g_aDigits));
   A_Push(f, Jn("e261", f0 + (f100 - f0) * 2.618, g_aDigits));
   A_Push(f, Jn("nearest_level", lv[bestI], 3));
   A_Push(f, Jn("nearest_price", px[bestI], g_aDigits));
   A_Push(f, Jn("dist_to_nearest_pips", A_Pips(sym, best), 1));
   A_Push(f, Jn("pos_in_range", pos, 3));
   A_Push(f, J("price_zone", pos > 0.5 ? "PREMIUM" : "DISCOUNT"));
   A_Push(f, Jr("ote", Obj(Jn("high", oteHi, g_aDigits) + "," + Jn("low", oteLo, g_aDigits))));
   A_Push(f, Jb("in_ote", g_aC[0] <= MathMax(oteHi, oteLo) && g_aC[0] >= MathMin(oteHi, oteLo)));
   A_Push(f, Jn("retracement_depth_pct", rng > 0 ? MathAbs(g_aC[0] - f0) / rng * 100.0 : 0, 2));
   A_Push(f, Jb("confluence_with_ma", MathAbs(px[bestI] - ma50) < A_ATR(14)));
   A_Push(f, Jb("golden_ratio_bounce", MathAbs(g_aC[0] - px[4]) < A_ATR(14) * 0.3));
   return Obj(A_Join(f));
  }

//--- 11 candles ----------------------------------------------------
string A_Candles()
  {
   double atr = A_ATR(14);
   string arr[];
   // Real, live change (user: wants the last 20 closed candles PLUS the current forming candle,
   // not just 10). g_aC[0]/g_aO[0]/etc is always the current (still-forming) bar -- i=0..20 is
   // that forming candle plus the 20 fully-closed candles before it, 21 total.
   for(int i = 0; i < MathMin(21, g_anb); i++)
     {
      double body = MathAbs(g_aC[i] - g_aO[i]);
      double rng  = MathMax(g_aH[i] - g_aL[i], g_aPoint);
      double uw   = g_aH[i] - MathMax(g_aO[i], g_aC[i]);
      double lw   = MathMin(g_aO[i], g_aC[i]) - g_aL[i];
      bool   bull = g_aC[i] >= g_aO[i];
      double gap  = (i + 1 < g_anb) ? g_aO[i] - g_aC[i + 1] : 0;
      bool   imb  = (i > 0 && i + 1 < g_anb) && (g_aL[i - 1] > g_aH[i + 1] || g_aH[i - 1] < g_aL[i + 1]);
      string b[];
      A_Push(b, J("t", A_IsoTime(g_aT[i])));
      A_Push(b, Jn("o", g_aO[i], g_aDigits)); A_Push(b, Jn("h", g_aH[i], g_aDigits));
      A_Push(b, Jn("l", g_aL[i], g_aDigits)); A_Push(b, Jn("c", g_aC[i], g_aDigits));
      A_Push(b, Ji("v", g_aV[i]));
      A_Push(b, J("d", bull ? "BULL" : "BEAR"));
      A_Push(b, Jn("body", body, g_aDigits));
      A_Push(b, Jn("upper_wick", uw, g_aDigits)); A_Push(b, Jn("lower_wick", lw, g_aDigits));
      A_Push(b, Jn("body_ratio", body / rng, 3));
      A_Push(b, Jn("wick_ratio", (uw + lw) / rng, 3));
      A_Push(b, Jn("size_pips", A_Pips(_Symbol, rng), 1));
      A_Push(b, Jn("size_vs_atr", atr > 0 ? rng / atr : 0, 3));
      A_Push(b, J("type", body / rng > 0.7 ? "MARUBOZU" : body / rng < 0.1 ? "DOJI" :
                        (lw > body * 2 ? "HAMMER" : uw > body * 2 ? "SHOOTING_STAR" : "NORMAL")));
      A_Push(b, Jn("gap", gap, g_aDigits));
      A_Push(b, J("gap_type", MathAbs(gap) < g_aPip ? "NONE" : gap > 0 ? "UP" : "DOWN"));
      A_Push(b, Jb("is_imbalance", imb));
      A_Push(arr, Obj(A_Join(b)));
     }
   return "[" + A_Join(arr) + "]";
  }

//--- 12 patterns ---------------------------------------------------
string A_Patterns()
  {
   double body0 = MathAbs(g_aC[0] - g_aO[0]), rng0 = MathMax(g_aH[0] - g_aL[0], g_aPoint);
   double uw0 = g_aH[0] - MathMax(g_aO[0], g_aC[0]), lw0 = MathMin(g_aO[0], g_aC[0]) - g_aL[0];
   bool bull0 = g_aC[0] >= g_aO[0];
   bool bull1 = g_anb > 1 && g_aC[1] >= g_aO[1];
   bool bull2 = g_anb > 2 && g_aC[2] >= g_aO[2];
   double body1 = g_anb > 1 ? MathAbs(g_aC[1] - g_aO[1]) : 0;
   bool doji = body0 / rng0 < 0.1;
   bool hammer = lw0 > body0 * 2 && uw0 < body0;
   bool invHammer = uw0 > body0 * 2 && lw0 < body0;
   bool shooting = invHammer && !bull0;
   bool maru = body0 / rng0 > 0.9;
   bool pinbar = (uw0 > rng0 * 0.6) || (lw0 > rng0 * 0.6);
   bool spin = body0 / rng0 < 0.3 && uw0 > body0 && lw0 > body0;
   bool engulf = g_anb > 1 && body0 > body1 && bull0 != bull1 &&
                 MathMax(g_aO[0],g_aC[0]) >= MathMax(g_aO[1],g_aC[1]) && MathMin(g_aO[0],g_aC[0]) <= MathMin(g_aO[1],g_aC[1]);
   bool harami = g_anb > 1 && body0 < body1 &&
                 MathMax(g_aO[0],g_aC[0]) <= MathMax(g_aO[1],g_aC[1]) && MathMin(g_aO[0],g_aC[0]) >= MathMin(g_aO[1],g_aC[1]);
   bool haramiX = harami && doji;
   bool tweezer = g_anb > 1 && (MathAbs(g_aH[0]-g_aH[1]) < g_aPip || MathAbs(g_aL[0]-g_aL[1]) < g_aPip);
   bool piercing = g_anb > 1 && bull0 && !bull1 && g_aC[0] > (g_aO[1] + g_aC[1]) / 2 && g_aC[0] < g_aO[1];
   bool darkcloud= g_anb > 1 && !bull0 && bull1 && g_aC[0] < (g_aO[1] + g_aC[1]) / 2 && g_aC[0] > g_aO[1];
   bool inside   = g_anb > 1 && g_aH[0] < g_aH[1] && g_aL[0] > g_aL[1];
   bool outside  = g_anb > 1 && g_aH[0] > g_aH[1] && g_aL[0] < g_aL[1];
   bool morning = g_anb > 2 && !bull2 && body1 < MathAbs(g_aC[2]-g_aO[2]) * 0.5 && bull0 && g_aC[0] > (g_aO[2]+g_aC[2])/2;
   bool evening = g_anb > 2 &&  bull2 && body1 < MathAbs(g_aC[2]-g_aO[2]) * 0.5 && !bull0 && g_aC[0] < (g_aO[2]+g_aC[2])/2;
   bool tws = g_anb > 2 && bull0 && bull1 && bull2 && g_aC[0] > g_aC[1] && g_aC[1] > g_aC[2];
   bool tbc = g_anb > 2 && !bull0 && !bull1 && !bull2 && g_aC[0] < g_aC[1] && g_aC[1] < g_aC[2];
   bool tiu = g_anb > 2 && harami && bull0 && !bull2;
   bool tid = g_anb > 2 && harami && !bull0 && bull2;
   // Real gap fixed (user, SMC/ICT audit: "institutional candle detection" -- genuinely absent
   // before, distinct from the generic candlestick patterns above). A real composite signature:
   // a large real body relative to its range (like `maru` above but a slightly looser 0.6 bar,
   // since real institutional candles aren't always a pure marubozu), genuinely elevated real
   // volume vs its own recent real average (not just a big body on thin volume, which is not the
   // same real thing), and a real close near the candle's own extreme in its own direction
   // (top 20% of range for a bull candle, bottom 20% for a bear one) -- all three together, not
   // any one alone, since each individually is common and not institutional-specific.
   double volAvg20 = 0; int volN = MathMin(20, g_anb - 1);
   for(int i = 1; i <= volN; i++) volAvg20 += (double)g_aV[i];
   if(volN > 0) volAvg20 /= volN;
   bool bigBody = body0 / rng0 > 0.6;
   bool bigVolume = volAvg20 > 0 && (double)g_aV[0] > volAvg20 * 1.5;
   bool closeNearExtreme = bull0 ? (g_aH[0] - g_aC[0]) / rng0 < 0.2 : (g_aC[0] - g_aL[0]) / rng0 < 0.2;
   bool institutional = bigBody && bigVolume && closeNearExtreme;
   string strongest = "NONE"; string bias = "NEUTRAL"; int reliability = 0;
   if(engulf)  { strongest = bull0 ? "BULLISH_ENGULFING" : "BEARISH_ENGULFING"; bias = bull0 ? "BULL":"BEAR"; reliability = 80; }
   else if(morning) { strongest = "MORNING_STAR"; bias = "BULL"; reliability = 85; }
   else if(evening) { strongest = "EVENING_STAR"; bias = "BEAR"; reliability = 85; }
   else if(tws)     { strongest = "THREE_WHITE_SOLDIERS"; bias = "BULL"; reliability = 78; }
   else if(tbc)     { strongest = "THREE_BLACK_CROWS"; bias = "BEAR"; reliability = 78; }
   else if(hammer)  { strongest = "HAMMER"; bias = "BULL"; reliability = 65; }
   else if(shooting){ strongest = "SHOOTING_STAR"; bias = "BEAR"; reliability = 65; }
   else if(doji)    { strongest = "DOJI"; bias = "NEUTRAL"; reliability = 40; }
   string single = Obj(Jb("doji", doji) + "," + Jb("hammer", hammer) + "," + Jb("inverted_hammer", invHammer) + "," +
                       Jb("shooting_star", shooting) + "," + Jb("marubozu", maru) + "," +
                       Jb("pin_bar", pinbar) + "," + Jb("spinning_top", spin));
   string dbl = Obj(Jb("engulfing", engulf) + "," + Jb("harami", harami) + "," + Jb("harami_cross", haramiX) + "," +
                    Jb("tweezers", tweezer) + "," + Jb("piercing_line", piercing) + "," +
                    Jb("dark_cloud_cover", darkcloud) + "," + Jb("inside_bar", inside) + "," + Jb("outside_bar", outside));
   string tri = Obj(Jb("morning_star", morning) + "," + Jb("evening_star", evening) + "," +
                    Jb("three_white_soldiers", tws) + "," + Jb("three_black_crows", tbc) + "," +
                    Jb("three_inside_up", tiu) + "," + Jb("three_inside_down", tid));
   return Obj(Jr("single", single) + "," + Jr("double", dbl) + "," + Jr("triple", tri) + "," +
              J("strongest", strongest) + "," + J("bias", bias) + "," + Ji("reliability", reliability) + "," +
              Jr("institutional_candle", Obj(Jb("detected", institutional) + "," + J("direction", institutional ? (bull0 ? "BULL" : "BEAR") : "NONE") + "," +
                   Jb("big_body", bigBody) + "," + Jb("big_volume", bigVolume) + "," + Jb("close_near_extreme", closeNearExtreme))));
  }

//--- 13 ict ----------------------------------------------------------
string A_Ict(string sym, ENUM_TIMEFRAMES tf)
  {
   string fvg[], ifvg[], vi[];
   double atr = A_ATR(14);
   for(int i = 1; i + 1 < MathMin(g_anb, 80); i++)
     {
      if(g_aL[i - 1] > g_aH[i + 1])
        {
         bool filled = g_aL[0] <= g_aH[i + 1];
         A_Push(fvg, Obj(J("type", "BULL") + "," + Jn("top", g_aL[i-1], g_aDigits) + "," + Jn("bot", g_aH[i+1], g_aDigits) + "," +
                       Jn("ce", (g_aL[i-1]+g_aH[i+1])/2, g_aDigits) + "," + Jb("filled", filled) + "," + Ji("bar", i)));
         if(filled) A_Push(ifvg, Obj(J("type", "BULL") + "," + Jn("top", g_aL[i-1], g_aDigits) + "," + Jn("bot", g_aH[i+1], g_aDigits) + "," + Ji("bar", i)));
         A_Push(vi, Obj(Jn("gap", A_Pips(sym, g_aL[i-1] - g_aH[i+1]), 1) + "," + Ji("bar", i)));
        }
      if(g_aH[i - 1] < g_aL[i + 1])
        {
         bool filled = g_aH[0] >= g_aL[i + 1];
         A_Push(fvg, Obj(J("type", "BEAR") + "," + Jn("top", g_aL[i+1], g_aDigits) + "," + Jn("bot", g_aH[i-1], g_aDigits) + "," +
                       Jn("ce", (g_aL[i+1]+g_aH[i-1])/2, g_aDigits) + "," + Jb("filled", filled) + "," + Ji("bar", i)));
         if(filled) A_Push(ifvg, Obj(J("type", "BEAR") + "," + Jn("top", g_aL[i+1], g_aDigits) + "," + Jn("bot", g_aH[i-1], g_aDigits) + "," + Ji("bar", i)));
         A_Push(vi, Obj(Jn("gap", A_Pips(sym, g_aL[i+1] - g_aH[i-1]), 1) + "," + Ji("bar", i)));
        }
      if(ArraySize(fvg) >= 8) break;
     }
   string obType = "NONE"; double obH = 0, obL = 0; int obBar = -1; bool obTested = false;
   for(int i = 2; i < MathMin(g_anb, 60); i++)
     {
      if(g_aC[i] < g_aO[i] && g_aC[i - 1] > g_aH[i] && (g_aC[i-1]-g_aO[i-1]) > atr * 0.7)
        { obType = "BULL"; obH = g_aH[i]; obL = g_aL[i]; obBar = i; break; }
      if(g_aC[i] > g_aO[i] && g_aC[i - 1] < g_aL[i] && (g_aO[i-1]-g_aC[i-1]) > atr * 0.7)
        { obType = "BEAR"; obH = g_aH[i]; obL = g_aL[i]; obBar = i; break; }
     }
   if(obBar > 0) for(int j = obBar - 1; j >= 0; j--) if(g_aL[j] <= obH && g_aH[j] >= obL) { obTested = true; break; }
   double obCe = (obH + obL) / 2.0;
   double asiaHi = 0, asiaLo = 0;
     {
      int cnt = 0;
      for(int i = 0; i < MathMin(g_anb, 200) && cnt < 60; i++)
        {
         MqlDateTime d; TimeToStruct(g_aT[i], d);
         if(d.hour >= 0 && d.hour < 6)
           {
            if(asiaHi == 0) { asiaHi = g_aH[i]; asiaLo = g_aL[i]; }
            asiaHi = MathMax(asiaHi, g_aH[i]); asiaLo = MathMin(asiaLo, g_aL[i]);
            cnt++;
           }
        }
      if(asiaHi == 0) { asiaHi = A_HighestHigh(0, 24); asiaLo = A_LowestLow(0, 24); }
     }
   double dr_hi = A_HighestHigh(0, 50), dr_lo = A_LowestLow(0, 50), eq = (dr_hi + dr_lo) / 2.0;
   string kz = A_KillzoneName();
   int hUtc = A_UtcHour();
   bool sbWindow = (hUtc == 10) || (hUtc == 14);
   bool judas = MathAbs(g_aC[0] - asiaHi) < atr * 0.5 || MathAbs(g_aC[0] - asiaLo) < atr * 0.5;
   string amd = hUtc < 7 ? "ACCUMULATION" : hUtc < 13 ? "MANIPULATION" : "DISTRIBUTION";
   string dol = g_aC[0] < eq ? "BSL_ABOVE" : "SSL_BELOW";
   double ndogGap = g_anb > 1 ? g_aO[0] - g_aC[1] : 0;
   string bslArr[], sslArr[];
   double sh[], sl[]; int shB[], slB[]; A_CollectSwings(SwingLookback, 4, sh, shB, sl, slB);
   for(int i = 0; i < ArraySize(sh); i++) A_Push(bslArr, DoubleToString(sh[i], g_aDigits));
   for(int i = 0; i < ArraySize(sl); i++) A_Push(sslArr, DoubleToString(sl[i], g_aDigits));
   string f[];
   A_Push(f, Jr("fvg", "[" + A_Join(fvg) + "]"));
   A_Push(f, Jr("ifvg", "[" + A_Join(ifvg) + "]"));
   A_Push(f, Jr("bpr", Obj(Jb("detected", ArraySize(ifvg) > 1) + "," +
        Jn("top", obH, g_aDigits) + "," + Jn("bot", obL, g_aDigits))));
   A_Push(f, Jr("vi", "[" + A_Join(vi) + "]"));
   A_Push(f, Jr("ob", Obj(J("type", obType) + "," + Jn("high", obH, g_aDigits) + "," + Jn("low", obL, g_aDigits) + "," +
        Jn("ce", obCe, g_aDigits) + "," + Jn("mt", obCe, g_aDigits) + "," + Ji("bar", obBar) + "," +
        Jb("valid", obBar > 0) + "," + Jb("tested", obTested))));
   // Real gap fixed (user, SMC/ICT audit: "breaker blocks have no reversal-candle confirmation --
   // just an OB type-flip"). `breakerType` alone was always emitted the instant an OB existed,
   // regardless of whether price had genuinely broken through it -- this now requires a real close
   // beyond the OB's far boundary since it formed (`breakerValid`, a genuine break, not just the
   // `obTested` wick-back-in check above), AND a real confirming candle -- the CURRENT bar closing
   // decisively (>50% real body-to-range) in the breaker's own direction -- before calling it
   // confirmed, so the model isn't told a breaker is active off a bare type-flip alone.
   string breakerType = obType == "BULL" ? "BEAR" : obType == "BEAR" ? "BULL" : "NONE";
   bool breakerValid = false;
   if(obBar > 0)
     for(int j = obBar - 1; j >= 0; j--)
       {
        if(obType == "BULL" && g_aC[j] < obL) { breakerValid = true; break; }
        if(obType == "BEAR" && g_aC[j] > obH) { breakerValid = true; break; }
       }
   double body0Ict = MathAbs(g_aC[0] - g_aO[0]), rng0Ict = MathMax(g_aH[0] - g_aL[0], g_aPoint);
   bool bull0Ict = g_aC[0] >= g_aO[0];
   bool breakerConfirmed = breakerValid && (body0Ict / rng0Ict > 0.5) && (breakerType == "BULL" ? bull0Ict : (breakerType == "BEAR" ? !bull0Ict : false));
   A_Push(f, Jr("breaker", Obj(J("type", breakerType) + "," +
        Jn("high", obH, g_aDigits) + "," + Jn("low", obL, g_aDigits) + "," + Ji("bar", obBar) + "," +
        Jb("valid", breakerValid) + "," + Jb("confirmed", breakerConfirmed))));
   A_Push(f, Jr("mb", Obj(Jb("detected", ArraySize(fvg) > 0) + "," + Jn("level", eq, g_aDigits))));
   A_Push(f, Jr("sweep", Obj(J("type", g_aH[0] > dr_hi ? "BSL" : g_aL[0] < dr_lo ? "SSL" : "NONE") + "," +
        Jn("level", g_aH[0] > dr_hi ? dr_hi : dr_lo, g_aDigits) + "," + Ji("bar", 0))));
   A_Push(f, Jr("bsl", "[" + A_Join(bslArr) + "]"));
   A_Push(f, Jr("ssl", "[" + A_Join(sslArr) + "]"));
   A_Push(f, Jr("idm", Obj(Jn("level", ArraySize(sl) > 1 ? sl[1] : dr_lo, g_aDigits) + "," + J("type", "SSL") + "," + Ji("bar", ArraySize(slB) > 1 ? slB[1] : 0))));
   A_Push(f, Jr("ndog", Obj(Jb("detected", MathAbs(ndogGap) > g_aPip) + "," + Jn("open", g_aO[0], g_aDigits) + "," +
        Jn("prev_close", g_anb > 1 ? g_aC[1] : g_aC[0], g_aDigits) + "," + Jn("gap_pips", A_Pips(sym, ndogGap), 1))));
   A_Push(f, Jr("nwog", Obj(Jb("detected", MathAbs(ndogGap) > g_aPip * 3) + "," + Jn("open", g_aO[0], g_aDigits) + "," +
        Jn("prev_close", g_anb > 1 ? g_aC[1] : g_aC[0], g_aDigits) + "," + Jn("gap_pips", A_Pips(sym, ndogGap), 1))));
   A_Push(f, Jn("mop", (g_aO[0] + g_aC[0]) / 2.0, g_aDigits));
   A_Push(f, Jr("asian_range", Obj(Jn("high", asiaHi, g_aDigits) + "," + Jn("low", asiaLo, g_aDigits) + "," +
        Jn("range_pips", A_Pips(sym, asiaHi - asiaLo), 1))));
   A_Push(f, J("killzone", kz));
   A_Push(f, Jb("silver_bullet", sbWindow));
   A_Push(f, J("silver_bullet_window", sbWindow ? (hUtc == 10 ? "LONDON" : "NY_AM") : "CLOSED"));
   A_Push(f, Jb("judas_swing", judas));
   A_Push(f, J("amd_phase", amd));
   A_Push(f, Jr("cbdr", Obj(Jb("active", hUtc >= 20 || hUtc < 2) + "," +
        Jn("high", asiaHi, g_aDigits) + "," + Jn("low", asiaLo, g_aDigits))));
   A_Push(f, J("dol", dol));
   A_Push(f, J("dol_dir", g_aC[0] < eq ? "UP" : "DOWN"));
   A_Push(f, J("premium_discount", g_aC[0] > eq ? "PREMIUM" : "DISCOUNT"));
   A_Push(f, Jr("ote_zone", Obj(Jn("high", dr_lo + (dr_hi-dr_lo)*0.79, g_aDigits) + "," +
        Jn("low", dr_lo + (dr_hi-dr_lo)*0.62, g_aDigits))));
   A_Push(f, Ji("poi_count", ArraySize(fvg) + (obBar > 0 ? 1 : 0)));
   // Real gap fixed (user, SMC/ICT audit: "smt is a hardcoded false stub -- never computed at
   // all"). Genuine SMT (Smart Money Divergence): this symbol makes a real new swing high/low
   // (its two most recent real swings, sh/sl already collected above) while the real EURUSD proxy
   // -- the same correlation proxy A_Correlation already uses -- moves the OPPOSITE way over the
   // same real bar window. That divergence between two instruments that should move together is
   // the real definition; `sym == "EURUSD"` itself can never diverge against its own proxy, so it
   // honestly reports not-detected rather than comparing against itself.
   bool smtDetected = false; string smtDir = "NONE";
   if(sym != "EURUSD" && ArraySize(sh) > 1 && ArraySize(sl) > 1)
     {
      double euRet = A_SymReturn("EURUSD", tf, 20);
      bool higherHigh = sh[0] > sh[1];
      bool lowerLow   = sl[0] < sl[1];
      if(higherHigh && euRet <= 0) { smtDetected = true; smtDir = "BEARISH"; }   // this symbol strong, EURUSD not confirming
      else if(lowerLow && euRet >= 0) { smtDetected = true; smtDir = "BULLISH"; } // this symbol weak, EURUSD not confirming
     }
   A_Push(f, Jr("smt", Obj(Jb("detected", smtDetected) + "," + J("direction", smtDir))));
   A_Push(f, Jb("mmbm", obType == "BULL" && g_aC[0] < eq));
   A_Push(f, Jb("mmsm", obType == "BEAR" && g_aC[0] > eq));
   return Obj(A_Join(f));
  }

//--- 14 wyckoff ----------------------------------------------------
string A_Wyckoff()
  {
   double trHi = A_HighestHigh(0, 50), trLo = A_LowestLow(0, 50);
   double prevHi = A_HighestHigh(50, 50), prevLo = A_LowestLow(50, 50);
   double recentRange = trHi - trLo, prevRange = prevHi - prevLo;
   double avgVol = 0, recVol = 0;
   int n = MathMin(50, g_anb);
   for(int i = 0; i < n; i++) avgVol += (double)g_aV[i]; avgVol /= n;
   for(int i = 0; i < MathMin(5, g_anb); i++) recVol += (double)g_aV[i]; recVol /= MathMin(5, g_anb);
   double volRatio = avgVol > 0 ? recVol / avgVol : 1;
   double moved = MathAbs(g_aC[0] - g_aC[MathMin(g_anb-1, 5)]);
   string phase = "RANGING", sub = "", ev = "NONE", schem = "NEUTRAL";
   bool nearLo = g_aC[0] < trLo + recentRange * 0.25;
   bool nearHi = g_aC[0] > trHi - recentRange * 0.25;
   if(nearLo && volRatio > 1.3) { phase = "ACCUMULATION"; sub = "PHASE_C"; ev = "SPRING"; schem = "ACCUMULATION"; }
   else if(nearLo)              { phase = "ACCUMULATION"; sub = "PHASE_B"; ev = "ST"; schem = "ACCUMULATION"; }
   else if(nearHi && volRatio > 1.3) { phase = "DISTRIBUTION"; sub = "PHASE_C"; ev = "UTAD"; schem = "DISTRIBUTION"; }
   else if(nearHi)              { phase = "DISTRIBUTION"; sub = "PHASE_B"; ev = "UT"; schem = "DISTRIBUTION"; }
   else if(recentRange > prevRange * 1.3) { phase = "MARKUP"; sub = "PHASE_D"; ev = "SOS"; }
   string er = "NEUTRAL";
   if(volRatio > 1.3 && moved < recentRange * 0.15) er = "EFFORT_NO_RESULT";
   else if(volRatio < 0.8 && moved > recentRange * 0.3) er = "RESULT_NO_EFFORT";
   else if(volRatio > 1.1 && moved > recentRange * 0.2) er = "HARMONY";
   string f[];
   A_Push(f, J("phase", phase)); A_Push(f, J("sub_phase", sub));
   A_Push(f, J("event", ev));    A_Push(f, J("schematic", schem));
   A_Push(f, Jn("avg_vol", avgVol, 1)); A_Push(f, Jn("recent_vol", recVol, 1));
   A_Push(f, Jn("vol_ratio", volRatio, 3));
   A_Push(f, J("effort_result", er));
   A_Push(f, Jn("trading_range_high", trHi, g_aDigits));
   A_Push(f, Jn("trading_range_low",  trLo, g_aDigits));
   A_Push(f, J("breakout_direction", g_aC[0] > trHi ? "UP" : g_aC[0] < trLo ? "DOWN" : "NONE"));
   A_Push(f, Ji("cause_bars", n));
   A_Push(f, Jn("recent_range", recentRange / MathMax(g_aPip, 1e-10), 1));
   A_Push(f, Jn("prev_range", prevRange / MathMax(g_aPip, 1e-10), 1));
   return Obj(A_Join(f));
  }

//--- 15 divergence -------------------------------------------------
string A_Divergence()
  {
   double sh[], sl[]; int shB[], slB[];
   A_CollectSwings(SwingLookback, 3, sh, shB, sl, slB);
   double rsiNow = A_RSI(14);
   double rsiAtHi = ArraySize(shB) > 0 ? A_RSI(14, shB[0]) : rsiNow;
   double rsiAtLo = ArraySize(slB) > 0 ? A_RSI(14, slB[0]) : rsiNow;
   double rsiPrevHi = ArraySize(shB) > 1 ? A_RSI(14, shB[1]) : rsiNow;
   double rsiPrevLo = ArraySize(slB) > 1 ? A_RSI(14, slB[1]) : rsiNow;
   double ph1 = ArraySize(sh) > 0 ? sh[0] : g_aH[0], ph2 = ArraySize(sh) > 1 ? sh[1] : ph1;
   double pl1 = ArraySize(sl) > 0 ? sl[0] : g_aL[0], pl2 = ArraySize(sl) > 1 ? sl[1] : pl1;
   bool rsiBear = ph1 > ph2 && rsiAtHi < rsiPrevHi;
   bool rsiBull = pl1 < pl2 && rsiAtLo > rsiPrevLo;
   bool hidBull = pl1 > pl2 && rsiAtLo < rsiPrevLo;
   bool hidBear = ph1 < ph2 && rsiAtHi > rsiPrevHi;
   double m0, s0, h0; A_MACD(m0, s0, h0);
   bool macdBear = ph1 > ph2 && h0 < 0;
   bool macdBull = pl1 < pl2 && h0 > 0;
   double k, d; A_Stochastic(14, 3, k, d);
   bool stochBull = pl1 < pl2 && k > 20 && k > d;
   string strongest = rsiBull ? "RSI_BULL" : rsiBear ? "RSI_BEAR" :
                      hidBull ? "HIDDEN_BULL" : hidBear ? "HIDDEN_BEAR" :
                      macdBull ? "MACD_BULL" : macdBear ? "MACD_BEAR" : "NONE";
   int barsSince = ArraySize(shB) > 0 ? MathMin(shB[0], ArraySize(slB) > 0 ? slB[0] : shB[0]) : -1;
   string f[];
   A_Push(f, Jb("rsi_bull_div", rsiBull)); A_Push(f, Jb("rsi_bear_div", rsiBear));
   A_Push(f, Jb("rsi_hidden_bull", hidBull)); A_Push(f, Jb("rsi_hidden_bear", hidBear));
   A_Push(f, Jb("macd_bull_div", macdBull)); A_Push(f, Jb("macd_bear_div", macdBear));
   A_Push(f, Jb("macd_hidden_bull", macdBull && hidBull)); A_Push(f, Jb("macd_hidden_bear", macdBear && hidBear));
   A_Push(f, Jb("stoch_bull_div", stochBull));
   A_Push(f, Jn("price_high1", ph1, g_aDigits)); A_Push(f, Jn("price_high2", ph2, g_aDigits));
   A_Push(f, Jn("price_low1", pl1, g_aDigits));  A_Push(f, Jn("price_low2", pl2, g_aDigits));
   A_Push(f, Jn("rsi_now", rsiNow, 2));
   A_Push(f, Jn("rsi_at_prev_high", rsiPrevHi, 2));
   A_Push(f, Jn("rsi_at_prev_low", rsiPrevLo, 2));
   A_Push(f, J("strongest", strongest));
   A_Push(f, Jb("confirmed", strongest != "NONE" && MathAbs(rsiNow - 50) > 10));
   A_Push(f, Ji("bars_since_div", barsSince));
   return Obj(A_Join(f));
  }

//--- 16 session ----------------------------------------------------
string A_Session()
  {
   int h = A_UtcHour(), m = A_UtcMin();
   bool tokyo  = (h >= 0 && h < 9);
   bool london = (h >= 7 && h < 16);
   bool ny     = (h >= 12 && h < 21);
   bool sydney = (h >= 21 || h < 6);
   bool overlap = (london && ny) || (tokyo && london);
   string ovType = (london && ny) ? "LONDON_NY" : (tokyo && london) ? "TOKYO_LONDON" : "NONE";
   string cur = ny && london ? "LONDON_NY" : ny ? "NEW_YORK" : london ? "LONDON" : tokyo ? "TOKYO" : sydney ? "SYDNEY" : "CLOSED";
   int toLondon = ((7 - h + 24) % 24) * 60 - m;
   int toNy     = ((12 - h + 24) % 24) * 60 - m;
   int toTokyo  = ((0 - h + 24) % 24) * 60 - m;
   int toSydney = ((21 - h + 24) % 24) * 60 - m;
   double sHi = A_HighestHigh(0, 12), sLo = A_LowestLow(0, 12);
   double aHi = A_HighestHigh(0, 24), aLo = A_LowestLow(0, 24);
   string f[];
   A_Push(f, J("current", cur));
   A_Push(f, Jb("tokyo", tokyo)); A_Push(f, Jb("london", london));
   A_Push(f, Jb("new_york", ny)); A_Push(f, Jb("sydney", sydney));
   A_Push(f, Jb("overlap", overlap)); A_Push(f, J("overlap_type", ovType));
   A_Push(f, Ji("hour_utc", h)); A_Push(f, Ji("min_utc", m));
   A_Push(f, Ji("to_london_min", toLondon)); A_Push(f, Ji("to_ny_min", toNy));
   A_Push(f, Ji("to_tokyo_min", toTokyo));   A_Push(f, Ji("to_sydney_min", toSydney));
   A_Push(f, Jb("silver_bullet_window", h == 10 || h == 14));
   A_Push(f, Jb("cbdr_active", h >= 20 || h < 2));
   A_Push(f, Jb("high_impact_hours", (h >= 12 && h <= 15) || (h >= 7 && h <= 9)));
   A_Push(f, Jn("session_open_price", g_aO[MathMin(g_anb - 1, 12)], g_aDigits));
   A_Push(f, Jn("session_high", sHi, g_aDigits)); A_Push(f, Jn("session_low", sLo, g_aDigits));
   A_Push(f, Jn("asian_range_high", aHi, g_aDigits)); A_Push(f, Jn("asian_range_low", aLo, g_aDigits));
   A_Push(f, Jn("asian_range_pips", (aHi - aLo) / MathMax(g_aPip, 1e-10), 1));
   A_Push(f, Ji("session_time_elapsed_min", h * 60 + m));
   return Obj(A_Join(f));
  }

//--- 17 pivots -----------------------------------------------------
string A_Pivots(string sym)
  {
   double pdh = iHigh(sym, PERIOD_D1, 1),  pdl = iLow(sym, PERIOD_D1, 1);
   double pdc = iClose(sym, PERIOD_D1, 1), pdo = iOpen(sym, PERIOD_D1, 1);
   double pwh = iHigh(sym, PERIOD_W1, 1),  pwl = iLow(sym, PERIOD_W1, 1);
   double pwc = iClose(sym, PERIOD_W1, 1);
   double pmh = iHigh(sym, PERIOD_MN1, 1), pml = iLow(sym, PERIOD_MN1, 1);
   double pmc = iClose(sym, PERIOD_MN1, 1);
   if(pdh == 0) { pdh = A_HighestHigh(1, 24); pdl = A_LowestLow(1, 24); pdc = g_aC[1]; pdo = g_aO[1]; }
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
   A_Push(f, Jr("weekly", Obj(Jn("p", wp, digits) + "," + Jn("r1", 2*wp - pwl, digits) + "," +
        Jn("s1", 2*wp - pwh, digits) + "," + Jn("high", pwh, digits) + "," + Jn("low", pwl, digits))));
   A_Push(f, Jr("monthly", Obj(Jn("p", mp, digits) + "," + Jn("r1", 2*mp - pml, digits) + "," + Jn("s1", 2*mp - pmh, digits))));
   A_Push(f, Jn("pdh", pdh, digits)); A_Push(f, Jn("pdl", pdl, digits));
   A_Push(f, Jn("pdc", pdc, digits)); A_Push(f, Jn("pdo", pdo, digits));
   A_Push(f, Jn("pwh", pwh, digits)); A_Push(f, Jn("pwl", pwl, digits));
   A_Push(f, J("nearest_pivot", nm[bi]));
   A_Push(f, Jn("dist_to_nearest_pips", A_Pips(sym, bd), 1));
   A_Push(f, J("price_vs_pivot", g_aC[0] > p ? "ABOVE" : "BELOW"));
   return Obj(A_Join(f));
  }

//--- 18 levels -----------------------------------------------------
string A_Levels()
  {
   double step = g_aPip * 50;
   double big  = g_aPip * 100, half = g_aPip * 50;
   double nearest = MathRound(g_aC[0] / step) * step;
   double above = nearest > g_aC[0] ? nearest : nearest + step;
   double below = nearest < g_aC[0] ? nearest : nearest - step;
   double bigF  = MathRound(g_aC[0] / big) * big;
   double halfF = MathRound(g_aC[0] / half) * half;
   double hi52 = A_HighestHigh(0, g_anb), lo52 = A_LowestLow(0, g_anb);
   string nearby[];
   for(int i = -2; i <= 2; i++) A_Push(nearby, DoubleToString(nearest + i * step, g_aDigits));
   string f[];
   A_Push(f, Jn("nearest", nearest, g_aDigits));
   A_Push(f, Jn("above", above, g_aDigits)); A_Push(f, Jn("below", below, g_aDigits));
   A_Push(f, Jn("mid", (above + below) / 2, g_aDigits));
   A_Push(f, Jn("dist_pips", MathAbs(g_aC[0] - nearest) / MathMax(g_aPip, 1e-10), 1));
   A_Push(f, Jn("step_size", step, g_aDigits));
   A_Push(f, Jn("big_figure", bigF, g_aDigits));
   A_Push(f, Jn("half_figure", halfF, g_aDigits));
   A_Push(f, Jn("dist_to_big_figure_pips", MathAbs(g_aC[0] - bigF) / MathMax(g_aPip, 1e-10), 1));
   A_Push(f, Jn("dist_to_half_figure_pips", MathAbs(g_aC[0] - halfF) / MathMax(g_aPip, 1e-10), 1));
   A_Push(f, Jn("psychological_level", bigF, g_aDigits));
   A_Push(f, Jn("magnet_level", MathAbs(g_aC[0]-bigF) < MathAbs(g_aC[0]-halfF) ? bigF : halfF, g_aDigits));
   A_Push(f, Jr("nearby_rounds", "[" + A_Join(nearby) + "]"));
   A_Push(f, Jn("hi_52w", hi52, g_aDigits)); A_Push(f, Jn("lo_52w", lo52, g_aDigits));
   A_Push(f, Jn("dist_to_52h_pips", (hi52 - g_aC[0]) / MathMax(g_aPip, 1e-10), 1));
   A_Push(f, Jn("dist_to_52l_pips", (g_aC[0] - lo52) / MathMax(g_aPip, 1e-10), 1));
   return Obj(A_Join(f));
  }

//--- 19 orderflow --------------------------------------------------
string A_OrderFlow()
  {
   double buyV = 0, sellV = 0;
   int n = MathMin(20, g_anb);
   for(int i = 0; i < n; i++) { if(g_aC[i] >= g_aO[i]) buyV += (double)g_aV[i]; else sellV += (double)g_aV[i]; }
   double delta = buyV - sellV;
   int consec = 1; bool up = g_aC[0] >= g_aO[0];
   for(int i = 1; i < n; i++) { if((g_aC[i] >= g_aO[i]) == up) consec++; else break; }
   double atr = A_ATR(14);
   int absorption = 0;
   double avgV = (buyV + sellV) / n;
   for(int i = 0; i < n; i++) if((double)g_aV[i] > avgV * 1.5 && MathAbs(g_aC[i] - g_aO[i]) < atr * 0.3) absorption++;
   double accel = g_anb > 3 ? MathAbs(g_aC[0]-g_aC[1]) - MathAbs(g_aC[2]-g_aC[3]) : 0;
   bool climaxBuy  = g_aC[0] > g_aO[0] && (double)g_aV[0] > avgV * 2.5;
   bool climaxSell = g_aC[0] < g_aO[0] && (double)g_aV[0] > avgV * 2.5;
   bool stopRun = g_anb > 2 && ((g_aH[0] > g_aH[1] && g_aC[0] < g_aC[1]) || (g_aL[0] < g_aL[1] && g_aC[0] > g_aC[1]));
   string f[];
   A_Push(f, Jn("delta", delta, 0));
   A_Push(f, J("bias", delta > 0 ? "BULL" : delta < 0 ? "BEAR" : "NEUTRAL"));
   A_Push(f, Jn("buy_vol", buyV, 0)); A_Push(f, Jn("sell_vol", sellV, 0));
   A_Push(f, Ji("consecutive", consec));
   A_Push(f, J("consecutive_dir", up ? "BULL" : "BEAR"));
   A_Push(f, Ji("absorption_bars", absorption));
   A_Push(f, Jn("momentum_acceleration", accel / MathMax(g_aPip, 1e-10), 2));
   A_Push(f, Jb("climax_buy", climaxBuy)); A_Push(f, Jb("climax_sell", climaxSell));
   A_Push(f, Jb("initiative_buyers", delta > 0 && consec >= 3));
   A_Push(f, Jb("initiative_sellers", delta < 0 && consec >= 3));
   A_Push(f, Jb("responsive_buyers", delta > 0 && g_aC[0] < A_SMA(20)));
   A_Push(f, Jb("responsive_sellers", delta < 0 && g_aC[0] > A_SMA(20)));
   A_Push(f, Jb("stop_run", stopRun));
   A_Push(f, Jb("momentum_ignition", MathAbs(g_aC[0]-g_aO[0]) > atr * 1.5));
   return Obj(A_Join(f));
  }

//--- 20 confluence ---------------------------------------------------
string A_Confluence(int &outScore, string &outDir)
  {
   double ma20 = A_SMA(20), ma50 = A_SMA(50);
   double rsi = A_RSI(14);
   double m, s, h; A_MACD(m, s, h);
   double atr = A_ATR(14);
   int bull = 0, bear = 0;
   int maT = g_aC[0] > ma20 && ma20 > ma50 ? 1 : (g_aC[0] < ma20 && ma20 < ma50 ? -1 : 0);
   int rsiS = rsi > 55 ? 1 : rsi < 45 ? -1 : 0;
   int macdS = h > 0 ? 1 : h < 0 ? -1 : 0;
   int adxS  = MathAbs(g_aC[0] - ma50) > atr ? (g_aC[0] > ma50 ? 1 : -1) : 0;
   int paS   = g_aC[0] > g_aO[0] ? 1 : -1;
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
   A_Push(f, Jr("signal_breakdown", bd));
   return Obj(A_Join(f));
  }

//--- 21 risk_metrics -----------------------------------------------
string A_RiskMetrics(string sym)
  {
   double atr = A_ATR(14), atrP = A_Pips(sym, atr);
   double spread = A_Pips(sym, SymbolInfoDouble(sym, SYMBOL_ASK) - SymbolInfoDouble(sym, SYMBOL_BID));
   double tickVal = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
   double tickSz  = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
   double pipVal  = (tickSz > 0) ? tickVal * (g_aPip / tickSz) : 10.0;
   double bal = AccountInfoDouble(ACCOUNT_BALANCE);
   double dayRange = A_Pips(sym, A_HighestHigh(0, 24) - A_LowestLow(0, 24));
   double sl2 = atrP * 2.0;
   double lot1 = (pipVal > 0 && sl2 > 0) ? (bal * 0.01) / (sl2 * pipVal) : 0;
   string f[];
   A_Push(f, Jn("atr_pips", atrP, 1));
   A_Push(f, Jn("sl_1x_pips", atrP, 1));   A_Push(f, Jn("sl_1_5x_pips", atrP * 1.5, 1));
   A_Push(f, Jn("sl_2x_pips", sl2, 1));    A_Push(f, Jn("sl_3x_pips", atrP * 3, 1));
   A_Push(f, Jn("tp_1_5x_pips", atrP * 1.5, 1)); A_Push(f, Jn("tp_2x_pips", atrP * 2, 1));
   A_Push(f, Jn("tp_3x_pips", atrP * 3, 1));     A_Push(f, Jn("tp_5x_pips", atrP * 5, 1));
   A_Push(f, Jn("rr_1_5", 1.5, 2)); A_Push(f, Jn("rr_2", 2.0, 2)); A_Push(f, Jn("rr_3", 3.0, 2));
   A_Push(f, Jn("pip_value", pipVal, 4));
   A_Push(f, Jn("spread_pips", spread, 2));
   A_Push(f, Jn("spread_pct_of_sl", sl2 > 0 ? spread / sl2 * 100.0 : 0, 2));
   A_Push(f, Jn("daily_range_pips", dayRange, 1));
   A_Push(f, Jn("atr_pct_of_daily_range", dayRange > 0 ? atrP / dayRange * 100.0 : 0, 1));
   A_Push(f, Jn("max_recommended_sl_pips", atrP * 3, 1));
   A_Push(f, Jr("position_sizing", Obj(Jn("lot_per_1pct_risk", lot1, 2) + "," + Jn("lot_per_2pct_risk", lot1 * 2, 2))));
   return Obj(A_Join(f));
  }

//--- 22 synthetic --------------------------------------------------
string A_Synthetic(string sym)
  {
   string s = sym; StringToUpper(s);
   string type = "FOREX";
   int tick = 0;
   if(StringFind(s, "BOOM") >= 0)   { type = "BOOM"; }
   else if(StringFind(s, "CRASH") >= 0) { type = "CRASH"; }
   else if(StringFind(s, "VOLATILITY") >= 0 || StringFind(s, "V75") >= 0 || StringFind(s, "VOL") >= 0) type = "VOL";
   else if(StringFind(s, "STORM") >= 0) type = "STORM";
   else if(StringFind(s, "FLAME") >= 0) type = "FLAME";
   else if(StringFind(s, "HWI") >= 0 || StringFind(s, "HW ") >= 0) type = "HW_INDEX";
   for(int i = 0; i < StringLen(s); i++)
     {
      ushort ch = StringGetCharacter(s, i);
      if(ch >= '0' && ch <= '9') tick = tick * 10 + (int)(ch - '0');
     }
   double atr = A_ATR(14);
   double threshold = atr * 3.0;
   string spikes[]; int spikeCount = 0, lastSpikeBar = -1, sumGap = 0, prevBar = -1;
   string spikeDir = type == "BOOM" ? "UP" : type == "CRASH" ? "DOWN" : "BOTH";
   for(int i = 0; i < MathMin(g_anb, 300); i++)
     {
      double mv = g_aC[i] - g_aO[i];
      if(MathAbs(mv) > threshold)
        {
         spikeCount++;
         if(lastSpikeBar < 0) lastSpikeBar = i;
         if(prevBar >= 0) sumGap += (i - prevBar);
         prevBar = i;
         if(ArraySize(spikes) < 5)
            A_Push(spikes, Obj(Ji("bar", i) + "," + J("dir", mv > 0 ? "UP" : "DOWN") + "," + Jn("size_pips", A_Pips(sym, MathAbs(mv)), 1)));
        }
     }
   double avgBetween = spikeCount > 1 ? (double)sumGap / (spikeCount - 1) : 0;
   int barsSince = lastSpikeBar < 0 ? -1 : lastSpikeBar;
   bool due = avgBetween > 0 && barsSince >= avgBetween * 0.8;
   bool overdue = avgBetween > 0 && barsSince > avgBetween * 1.3;
   double prob = avgBetween > 0 ? MathMin(99.0, barsSince / avgBetween * 70.0) : 0;
   double avgRange = 0; int n = MathMin(50, g_anb);
   for(int i = 0; i < n; i++) avgRange += (g_aH[i] - g_aL[i]); avgRange /= n;
   string f[];
   A_Push(f, J("type", type));
   A_Push(f, Ji("tick_interval_number", tick));
   A_Push(f, J("spike_dir", spikeDir));
   A_Push(f, Ji("spike_count", spikeCount));
   A_Push(f, Ji("bars_since_spike", barsSince));
   A_Push(f, Jn("avg_between", avgBetween, 1));
   A_Push(f, Jb("is_due", due)); A_Push(f, Jb("is_overdue", overdue));
   A_Push(f, Jn("estimated_bars_to_spike", MathMax(0.0, avgBetween - barsSince), 1));
   A_Push(f, Jn("spike_probability", prob, 1));
   A_Push(f, J("dominant_dir", g_aC[0] > A_SMA(50) ? "UP" : "DOWN"));
   A_Push(f, J("micro_trend", g_aC[0] > A_SMA(5) ? "UP" : "DOWN"));
   A_Push(f, Jn("spike_threshold", A_Pips(sym, threshold), 1));
   A_Push(f, Jn("avg_candle_range", A_Pips(sym, avgRange), 1));
   A_Push(f, J("volatility_class", atr > avgRange * 1.5 ? "EXTREME" : atr > avgRange ? "HIGH" : "NORMAL"));
   A_Push(f, Jr("recent_spikes", "[" + A_Join(spikes) + "]"));
   return Obj(A_Join(f));
  }

//--- 23 elliott ----------------------------------------------------
string A_Elliott()
  {
   double sh[], sl[]; int shB[], slB[];
   A_CollectSwings(SwingLookback, 5, sh, shB, sl, slB);
   int pivots = ArraySize(sh) + ArraySize(sl);
   double a = ArraySize(sh) > 0 && ArraySize(sl) > 0 ? MathAbs(sh[0] - sl[0]) : 0;
   double b = ArraySize(sh) > 1 && ArraySize(sl) > 0 ? MathAbs(sh[1] - sl[0]) : 0;
   double c = ArraySize(sh) > 1 && ArraySize(sl) > 1 ? MathAbs(sh[1] - sl[1]) : 0;
   double d = ArraySize(sh) > 2 && ArraySize(sl) > 1 ? MathAbs(sh[2] - sl[1]) : 0;
   bool impulse = pivots >= 5 && g_aC[0] > A_SMA(50);
   int wave = pivots >= 8 ? 5 : pivots >= 6 ? 4 : pivots >= 4 ? 3 : pivots >= 2 ? 2 : 1;
   double whi = ArraySize(sh) > 0 ? sh[0] : g_aH[0];
   double wlo = ArraySize(sl) > 0 ? sl[0] : g_aL[0];
   double target = impulse ? whi + (whi - wlo) * 0.618 : wlo - (whi - wlo) * 0.618;
   string f[];
   A_Push(f, Ji("wave", wave)); A_Push(f, Jb("impulse", impulse)); A_Push(f, Ji("pivots", pivots));
   A_Push(f, Jn("ab_ratio", b > 0 ? a / b : 0, 3));
   A_Push(f, Jn("bc_ratio", c > 0 ? b / c : 0, 3));
   A_Push(f, Jn("cd_ratio", d > 0 ? c / d : 0, 3));
   A_Push(f, Jn("current_wave_high", whi, g_aDigits));
   A_Push(f, Jn("current_wave_low", wlo, g_aDigits));
   A_Push(f, Jn("wave_target", target, g_aDigits));
   A_Push(f, Jn("wave_invalidation", impulse ? wlo : whi, g_aDigits));
   A_Push(f, J("correction_type", wave == 4 ? "ABC" : wave == 2 ? "ZIGZAG" : "NONE"));
   A_Push(f, Ji("confidence", MathMin(90, pivots * 12)));
   A_Push(f, J("wave_degree", "MINOR"));
   A_Push(f, Ji("bars_in_wave", ArraySize(shB) > 0 ? shB[0] : 0));
   return Obj(A_Join(f));
  }

//--- 24 correlation --------------------------------------------------
string A_Correlation(string sym, ENUM_TIMEFRAMES tf)
  {
   double r5  = g_anb > 5  && g_aC[5]  != 0 ? (g_aC[0] - g_aC[5])  / g_aC[5]  * 100.0 : 0;
   double r20 = g_anb > 20 && g_aC[20] != 0 ? (g_aC[0] - g_aC[20]) / g_aC[20] * 100.0 : 0;
   double eu  = A_SymReturn("EURUSD", tf, 20);
   double dxyProxy = -eu;
   double sameSign = (r20 * eu) > 0 ? 1 : -1;
   string lab = MathAbs(eu) < 0.01 ? "UNKNOWN" : (sameSign > 0 ? "POSITIVE" : "NEGATIVE");
   string s = sym; StringToUpper(s);
   bool haven = StringFind(s, "XAU") >= 0 || StringFind(s, "JPY") >= 0 || StringFind(s, "CHF") >= 0;
   string f[];
   A_Push(f, Jn("ret_5bar", r5, 4)); A_Push(f, Jn("ret_20bar", r20, 4));
   A_Push(f, Jn("vs_eurusd", eu, 4)); A_Push(f, J("corr_label", lab));
   A_Push(f, Jn("vs_dxy", dxyProxy, 4));
   A_Push(f, Jb("risk_on", r20 > 0 && !haven));
   A_Push(f, Jb("safe_haven", haven));
   A_Push(f, Jb("momentum_sync", sameSign > 0));
   A_Push(f, Ji("positive_pairs", sameSign > 0 ? 1 : 0));
   A_Push(f, Ji("negative_pairs", sameSign < 0 ? 1 : 0));
   return Obj(A_Join(f));
  }

//--- 25 strength / 26 heatmap ---------------------------------------
string A_Strength(string sym, ENUM_TIMEFRAMES tf)
  {
   string cur[]; double str[]; A_CurrencyStrengths(tf, cur, str);
   string base = StringSubstr(sym, 0, 3), quote = StringSubstr(sym, 3, 3);
   double bs = 0, qs = 0;
   int strongestI = 0, weakestI = 0;
   for(int i = 0; i < ArraySize(cur); i++)
     {
      if(cur[i] == base) bs = str[i];
      if(cur[i] == quote) qs = str[i];
      if(str[i] > str[strongestI]) strongestI = i;
      if(str[i] < str[weakestI])   weakestI = i;
     }
   string items[];
   for(int i = 0; i < ArraySize(cur); i++) A_Push(items, "\"" + cur[i] + "\":" + DoubleToString(str[i], 3));
   string f[];
   A_Push(f, J("base", base)); A_Push(f, J("quote", quote));
   A_Push(f, Jn("base_strength", bs, 3)); A_Push(f, Jn("quote_strength", qs, 3));
   A_Push(f, Jn("differential", bs - qs, 3));
   A_Push(f, J("bias", bs > qs ? "LONG_BASE" : "SHORT_BASE"));
   A_Push(f, J("strongest", cur[strongestI])); A_Push(f, J("weakest", cur[weakestI]));
   A_Push(f, Jr("all", Obj(A_Join(items))));
   return Obj(A_Join(f));
  }

string A_Heatmap(ENUM_TIMEFRAMES tf)
  {
   string cur[]; double str[]; A_CurrencyStrengths(tf, cur, str);
   string rows[];
   for(int i = 0; i < ArraySize(cur); i++)
      A_Push(rows, Obj(J("ccy", cur[i]) + "," + Jn("score", str[i], 3) + "," +
                     J("state", str[i] > 0.5 ? "STRONG" : str[i] < -0.5 ? "WEAK" : "NEUTRAL")));
   return Obj(Jr("currencies", "[" + A_Join(rows) + "]") + "," + Ji("count", ArraySize(cur)));
  }

//--- 27 fractal ----------------------------------------------------
string A_Fractal()
  {
   string up[], dn[];
   for(int i = 2; i < MathMin(g_anb - 2, 120) && (ArraySize(up) < 6 || ArraySize(dn) < 6); i++)
     {
      if(ArraySize(up) < 6 && A_IsSwingHigh(i, 2)) A_Push(up, Obj(Ji("bar", i) + "," + Jn("level", g_aH[i], g_aDigits)));
      if(ArraySize(dn) < 6 && A_IsSwingLow(i, 2))  A_Push(dn, Obj(Ji("bar", i) + "," + Jn("level", g_aL[i], g_aDigits)));
     }
   double atr = A_ATR(14);
   return Obj(Jr("up_fractals", "[" + A_Join(up) + "]") + "," + Jr("down_fractals", "[" + A_Join(dn) + "]") + "," +
              Ji("up_count", ArraySize(up)) + "," + Ji("down_count", ArraySize(dn)) + "," +
              J("last_fractal", ArraySize(up) > 0 && ArraySize(dn) > 0 ? "MIXED" : ArraySize(up) > 0 ? "UP" : "DOWN") + "," +
              Jn("fractal_atr", atr / MathMax(g_aPip, 1e-10), 1));
  }

//--- 28 harmonic ---------------------------------------------------
string A_Harmonic()
  {
   double sh[], sl[]; int shB[], slB[];
   A_CollectSwings(SwingLookback, 4, sh, shB, sl, slB);
   double X = ArraySize(sh) > 1 ? sh[1] : g_aH[0];
   double A = ArraySize(sl) > 1 ? sl[1] : g_aL[0];
   double B = ArraySize(sh) > 0 ? sh[0] : g_aH[0];
   double Cp= ArraySize(sl) > 0 ? sl[0] : g_aL[0];
   double D = g_aC[0];
   double xa = MathAbs(X - A), ab = MathAbs(A - B), bc = MathAbs(B - Cp), cd = MathAbs(Cp - D);
   double abXa = xa > 0 ? ab / xa : 0;
   double bcAb = ab > 0 ? bc / ab : 0;
   double cdBc = bc > 0 ? cd / bc : 0;
   string pattern = "NONE"; int conf = 0;
   if(abXa > 0.55 && abXa < 0.68 && cdBc > 1.2 && cdBc < 1.7) { pattern = "GARTLEY"; conf = 70; }
   else if(abXa > 0.35 && abXa < 0.52 && cdBc > 1.5) { pattern = "BAT"; conf = 65; }
   else if(abXa > 0.7 && abXa < 0.9) { pattern = "BUTTERFLY"; conf = 60; }
   else if(abXa > 0.35 && abXa < 0.65 && bcAb > 1.1) { pattern = "CRAB"; conf = 55; }
   return Obj(J("pattern", pattern) + "," + Ji("confidence", conf) + "," +
              Jn("x", X, g_aDigits) + "," + Jn("a", A, g_aDigits) + "," + Jn("b", B, g_aDigits) + "," +
              Jn("c", Cp, g_aDigits) + "," + Jn("d", D, g_aDigits) + "," +
              Jn("ab_xa", abXa, 3) + "," + Jn("bc_ab", bcAb, 3) + "," + Jn("cd_bc", cdBc, 3) + "," +
              J("direction", D < B ? "BULL" : "BEAR") + "," +
              Jn("prz_high", MathMax(Cp, D), g_aDigits) + "," + Jn("prz_low", MathMin(Cp, D), g_aDigits));
  }

//--- 29 mean_reversion -----------------------------------------------
string A_MeanReversion()
  {
   double ma20 = A_SMA(20), sd = A_StdDev(20), atr = A_ATR(14);
   double z = sd > 0 ? (g_aC[0] - ma20) / sd : 0;
   double devPips = (g_aC[0] - ma20) / MathMax(g_aPip, 1e-10);
   int barsAway = 0;
   for(int i = 0; i < MathMin(g_anb, 50); i++) { if((g_aC[i] > ma20) == (g_aC[0] > ma20)) barsAway++; else break; }
   return Obj(Jn("mean", ma20, g_aDigits) + "," + Jn("zscore", z, 3) + "," +
              Jn("deviation_pips", devPips, 1) + "," +
              J("state", z > 2 ? "OVEREXTENDED_UP" : z < -2 ? "OVEREXTENDED_DOWN" : "NORMAL") + "," +
              Jb("revert_long", z < -1.5) + "," + Jb("revert_short", z > 1.5) + "," +
              Ji("bars_from_mean", barsAway) + "," +
              Jn("half_life_est", MathMax(1.0, barsAway / 2.0), 1) + "," +
              Jn("target", ma20, g_aDigits) + "," +
              Jn("target_dist_pips", MathAbs(g_aC[0] - ma20) / MathMax(g_aPip, 1e-10), 1) + "," +
              Jn("atr_multiple", atr > 0 ? MathAbs(g_aC[0] - ma20) / atr : 0, 3));
  }

//--- 30 tape / 34 tape_flow -------------------------------------------
string A_Tape(string sym)
  {
   MqlTick ticks[];
   int got = CopyTicks(sym, ticks, COPY_TICKS_ALL, 0, 200);
   int upT = 0, dnT = 0; double lastP = 0;
   for(int i = 0; i < got; i++)
     {
      double p = ticks[i].bid > 0 ? ticks[i].bid : ticks[i].last;
      if(lastP > 0) { if(p > lastP) upT++; else if(p < lastP) dnT++; }
      lastP = p;
     }
   double ratio = (upT + dnT) > 0 ? (double)upT / (upT + dnT) * 100.0 : 50;
   return Obj(Ji("ticks_sampled", got) + "," + Ji("up_ticks", upT) + "," + Ji("down_ticks", dnT) + "," +
              Jn("uptick_pct", ratio, 2) + "," +
              J("tape_bias", ratio > 55 ? "BULL" : ratio < 45 ? "BEAR" : "NEUTRAL") + "," +
              Jn("last_price", lastP, g_aDigits) + "," +
              Jb("fast_tape", got > 150));
  }

string A_TapeFlow()
  {
   int n = MathMin(30, g_anb);
   double up = 0, dn = 0;
   for(int i = 0; i < n; i++) { if(g_aC[i] >= g_aO[i]) up += (double)g_aV[i]; else dn += (double)g_aV[i]; }
   double cvd = up - dn;
   double imb = (up + dn) > 0 ? (up - dn) / (up + dn) : 0;
   return Obj(Jn("cvd", cvd, 0) + "," + Jn("imbalance", imb, 4) + "," +
              J("flow_bias", imb > 0.1 ? "BUY" : imb < -0.1 ? "SELL" : "BALANCED") + "," +
              Jn("buy_flow", up, 0) + "," + Jn("sell_flow", dn, 0) + "," +
              Ji("window_bars", n) + "," +
              Jb("aggressive_buyers", imb > 0.25) + "," + Jb("aggressive_sellers", imb < -0.25));
  }

//--- 31 seasonality ----------------------------------------------------
string A_Seasonality()
  {
   MqlDateTime d; TimeToStruct(TimeGMT(), d);
   double hourly[24]; int hcnt[24];
   for(int i = 0; i < 24; i++) { hourly[i] = 0; hcnt[i] = 0; }
   for(int i = 0; i < MathMin(g_anb, 400); i++)
     {
      MqlDateTime b; TimeToStruct(g_aT[i], b);
      hourly[b.hour] += (g_aH[i] - g_aL[i]) / MathMax(g_aPip, 1e-10); hcnt[b.hour]++;
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
              Ji("most_volatile_hour", bestH) + "," + Jn("most_volatile_hour_pips", bestV, 1) + "," +
              Jr("hourly_avg_range_pips", "[" + A_Join(rows) + "]") + "," +
              Jb("is_month_end", d.day >= 28) + "," + Jb("is_friday", d.day_of_week == 5));
  }

//--- 32 spread_analysis ------------------------------------------------
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

//--- 33 gann -------------------------------------------------------
string A_Gann()
  {
   double hi = A_HighestHigh(0, 50), lo = A_LowestLow(0, 50), rng = hi - lo;
   double g[9]; double ratios[9]; ratios[0]=0.125; ratios[1]=0.25; ratios[2]=0.333; ratios[3]=0.375; ratios[4]=0.5;
   ratios[5]=0.625; ratios[6]=0.667; ratios[7]=0.75; ratios[8]=0.875;
   string lines[];
   for(int i = 0; i < 9; i++) { g[i] = lo + rng * ratios[i]; A_Push(lines, DoubleToString(g[i], g_aDigits)); }
   int bi = 0; double bd = 1e18;
   for(int i = 0; i < 9; i++) { double dd = MathAbs(g_aC[0] - g[i]); if(dd < bd) { bd = dd; bi = i; } }
   double sq9 = MathPow(MathSqrt(g_aC[0] / MathMax(g_aPoint, 1e-9)) + 1, 2) * g_aPoint;
   return Obj(Jr("gann_levels", "[" + A_Join(lines) + "]") + "," +
              Jn("nearest_gann", g[bi], g_aDigits) + "," + Jn("nearest_ratio", ratios[bi], 3) + "," +
              Jn("dist_pips", bd / MathMax(g_aPip, 1e-10), 1) + "," +
              Jn("range_high", hi, g_aDigits) + "," + Jn("range_low", lo, g_aDigits) + "," +
              Jn("sq9_next", sq9, g_aDigits) + "," +
              J("gann_bias", g_aC[0] > lo + rng * 0.5 ? "BULL" : "BEAR"));
  }

//--- 35 market_profile -----------------------------------------------
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
      int b = (int)MathFloor(((g_aH[i] + g_aL[i]) / 2.0 - lo) / binSize);
      b = MathMax(0, MathMin(BINS - 1, b));
      vol[b] += (double)g_aV[i];
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
   return Obj(Jn("poc", pocPrice, g_aDigits) + "," + Jn("vah", vah, g_aDigits) + "," + Jn("val", val, g_aDigits) + "," +
              Jn("profile_high", hi, g_aDigits) + "," + Jn("profile_low", lo, g_aDigits) + "," +
              J("price_vs_va", g_aC[0] > vah ? "ABOVE" : g_aC[0] < val ? "BELOW" : "INSIDE") + "," +
              Jn("dist_to_poc_pips", (g_aC[0] - pocPrice) / MathMax(g_aPip, 1e-10), 1) + "," +
              J("shape", (vah - val) > (hi - lo) * 0.7 ? "D_SHAPE" : "P_SHAPE") + "," +
              Jr("bins", "[" + A_Join(bins) + "]"));
  }

//--- 36 macro ----------------------------------------------------------
string A_Macro(string sym, ENUM_TIMEFRAMES tf)
  {
   double d1 = A_SymReturn(sym, PERIOD_D1, 1);
   double w1 = A_SymReturn(sym, PERIOD_W1, 1);
   double dxy = -A_SymReturn("EURUSD", PERIOD_D1, 5);
   double gold = A_SymReturn("XAUUSD", PERIOD_D1, 5);
   double jpy = A_SymReturn("USDJPY", PERIOD_D1, 5);
   bool riskOff = gold > 0.5 && jpy < 0;
   return Obj(Jn("daily_change_pct", d1, 4) + "," + Jn("weekly_change_pct", w1, 4) + "," +
              Jn("dxy_proxy_5d", dxy, 4) + "," + Jn("gold_5d", gold, 4) + "," + Jn("usdjpy_5d", jpy, 4) + "," +
              J("risk_regime", riskOff ? "RISK_OFF" : "RISK_ON") + "," +
              J("usd_bias", dxy > 0 ? "STRONG" : "WEAK") + "," +
              Jb("safe_haven_bid", riskOff));
  }

//--- 37 news -------------------------------------------------------
string A_News(string sym)
  {
   MqlCalendarValue vals[];
   string base = StringSubstr(sym, 0, 3), quote = StringSubstr(sym, 3, 3);
   datetime from = TimeGMT() - 6 * 3600, to = TimeGMT() + 24 * 3600;
   string items[]; int high = 0; long minsToNext = -1;
   if(CalendarValueHistory(vals, from, to, NULL, NULL))
     {
      for(int i = 0; i < ArraySize(vals) && ArraySize(items) < 15; i++)
        {
         MqlCalendarEvent ev;
         if(!CalendarEventById(vals[i].event_id, ev)) continue;
         MqlCalendarCountry co;
         if(!CalendarCountryById(ev.country_id, co)) continue;
         if(co.currency != base && co.currency != quote) continue;
         if(ev.importance == CALENDAR_IMPORTANCE_HIGH) high++;
         long mins = (long)((vals[i].time - TimeGMT()) / 60);
         if(mins > 0 && (minsToNext < 0 || mins < minsToNext)) minsToNext = mins;
         string name = ev.name; StringReplace(name, "\"", "'");
         A_Push(items, Obj(J("time", A_IsoTime(vals[i].time)) + "," + J("currency", co.currency) + "," +
                         J("event", name) + "," +
                         J("importance", ev.importance == CALENDAR_IMPORTANCE_HIGH ? "HIGH" :
                                         ev.importance == CALENDAR_IMPORTANCE_MODERATE ? "MEDIUM" : "LOW") + "," +
                         Ji("has_actual", vals[i].HasActualValue() ? 1 : 0)));
        }
     }
   return Obj(Jr("events", "[" + A_Join(items) + "]") + "," + Ji("count", ArraySize(items)) + "," +
              Ji("high_impact_count", high) + "," + Ji("minutes_to_next", (int)minsToNext) + "," +
              Jb("news_blackout", minsToNext >= 0 && minsToNext < 30 && high > 0));
  }

//--- 38 sentiment --------------------------------------------------
string A_Sentiment(int confScore, string confDir)
  {
   double rsi = A_RSI(14);
   double m, s, h; A_MACD(m, s, h);
   int bullBars = 0; int n = MathMin(20, g_anb);
   for(int i = 0; i < n; i++) if(g_aC[i] >= g_aO[i]) bullBars++;
   double pctBull = (double)bullBars / n * 100.0;
   double score = (rsi - 50) * 1.2 + (h > 0 ? 15 : -15) + (pctBull - 50) * 0.6;
   score = MathMax(-100, MathMin(100, score));
   return Obj(Jn("score", score, 1) + "," +
              J("label", score > 40 ? "GREED" : score > 10 ? "BULLISH" : score < -40 ? "FEAR" : score < -10 ? "BEARISH" : "NEUTRAL") + "," +
              Jn("bull_bar_pct", pctBull, 1) + "," +
              Jn("rsi", rsi, 2) + "," +
              J("confluence_dir", confDir) + "," + Ji("confluence_score", confScore) + "," +
              Jb("extreme", MathAbs(score) > 70));
  }

//--- 39 regime -----------------------------------------------------
string A_Regime()
  {
   double atr = A_ATR(14), atrLong = A_ATR(MathMin(50, g_anb - 2));
   double ma20 = A_SMA(20), ma50 = A_SMA(50);
   double rng = A_HighestHigh(0, 50) - A_LowestLow(0, 50);
   double net = MathAbs(g_aC[0] - g_aC[MathMin(g_anb - 1, 50)]);
   double efficiency = rng > 0 ? net / rng : 0;
   string regime = efficiency > 0.5 ? "TRENDING" : efficiency < 0.25 ? "RANGING" : "TRANSITIONAL";
   string vol = atr > atrLong * 1.25 ? "HIGH_VOL" : atr < atrLong * 0.75 ? "LOW_VOL" : "NORMAL_VOL";
   return Obj(J("regime", regime) + "," + J("volatility_regime", vol) + "," +
              Jn("efficiency_ratio", efficiency, 3) + "," +
              J("direction", g_aC[0] > ma50 ? "UP" : "DOWN") + "," +
              Jb("trending", regime == "TRENDING") + "," + Jb("ranging", regime == "RANGING") + "," +
              Jn("range_pips", rng / MathMax(g_aPip, 1e-10), 1) + "," + Jn("net_move_pips", net / MathMax(g_aPip, 1e-10), 1) + "," +
              J("suggested_style", regime == "TRENDING" ? "BREAKOUT_TREND_FOLLOW" : "MEAN_REVERSION") + "," +
              Jn("ma_spread_pips", (ma20 - ma50) / MathMax(g_aPip, 1e-10), 1));
  }

//--- 40 backtest ---------------------------------------------------
string A_Backtest()
  {
   int trades = 0, wins = 0; double pnl = 0, best = 0, worst = 0, entry = 0; int dir = 0;
   int n = MathMin(g_anb - 55, 200);
   for(int i = n; i > 0; i--)
     {
      double f = A_SMA(20, i), sl2 = A_SMA(50, i);
      int sig = f > sl2 ? 1 : -1;
      if(dir == 0) { dir = sig; entry = g_aC[i]; }
      else if(sig != dir)
        {
         double r = (g_aC[i] - entry) * dir / MathMax(g_aPip, 1e-10);
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
              J("strategy", "MA20_50_CROSS") + "," + Ji("bars_tested", n) + "," +
              J("edge", wr > 50 && pnl > 0 ? "POSITIVE" : "NEGATIVE"));
  }

//--- 41 swing ------------------------------------------------------
string A_Swing()
  {
   double sh[], sl[]; int shB[], slB[];
   A_CollectSwings(SwingLookback, 6, sh, shB, sl, slB);
   string hs[], ls[];
   for(int i = 0; i < ArraySize(sh); i++)
      A_Push(hs, Obj(Jn("level", sh[i], g_aDigits) + "," + Ji("bar", shB[i]) + "," + J("time", A_IsoTime(g_aT[shB[i]]))));
   for(int i = 0; i < ArraySize(sl); i++)
      A_Push(ls, Obj(Jn("level", sl[i], g_aDigits) + "," + Ji("bar", slB[i]) + "," + J("time", A_IsoTime(g_aT[slB[i]]))));
   double lastHi = ArraySize(sh) > 0 ? sh[0] : g_aH[0];
   double lastLo = ArraySize(sl) > 0 ? sl[0] : g_aL[0];
   return Obj(Jr("highs", "[" + A_Join(hs) + "]") + "," + Jr("lows", "[" + A_Join(ls) + "]") + "," +
              Jn("last_swing_high", lastHi, g_aDigits) + "," + Jn("last_swing_low", lastLo, g_aDigits) + "," +
              Jn("swing_range_pips", (lastHi - lastLo) / MathMax(g_aPip, 1e-10), 1) + "," +
              Ji("high_count", ArraySize(sh)) + "," + Ji("low_count", ArraySize(sl)) + "," +
              J("last_leg", ArraySize(shB) > 0 && ArraySize(slB) > 0 ? (shB[0] < slB[0] ? "UP" : "DOWN") : "UNKNOWN") + "," +
              Ji("lookback", SwingLookback));
  }

//--- 42 order_blocks -----------------------------------------------
string A_OrderBlocks()
  {
   double atr = A_ATR(14);
   string obs[];
   for(int i = 2; i < MathMin(g_anb - 1, 120) && ArraySize(obs) < 8; i++)
     {
      bool bullOB = g_aC[i] < g_aO[i] && g_aC[i - 1] > g_aH[i] && (g_aC[i-1]-g_aO[i-1]) > atr * 0.6;
      bool bearOB = g_aC[i] > g_aO[i] && g_aC[i - 1] < g_aL[i] && (g_aO[i-1]-g_aC[i-1]) > atr * 0.6;
      if(!bullOB && !bearOB) continue;
      bool mitigated = false;
      for(int j = i - 1; j >= 0; j--) if(g_aL[j] <= g_aH[i] && g_aH[j] >= g_aL[i]) { mitigated = true; break; }
      A_Push(obs, Obj(J("type", bullOB ? "BULL" : "BEAR") + "," +
                    Jn("high", g_aH[i], g_aDigits) + "," + Jn("low", g_aL[i], g_aDigits) + "," +
                    Jn("ce", (g_aH[i]+g_aL[i])/2, g_aDigits) + "," + Ji("bar", i) + "," +
                    J("time", A_IsoTime(g_aT[i])) + "," + Jb("mitigated", mitigated) + "," +
                    Jn("dist_pips", (g_aC[0] - (g_aH[i]+g_aL[i])/2) / MathMax(g_aPip, 1e-10), 1) + "," +
                    Jn("size_pips", (g_aH[i]-g_aL[i]) / MathMax(g_aPip, 1e-10), 1)));
     }
   return Obj(Jr("blocks", "[" + A_Join(obs) + "]") + "," + Ji("count", ArraySize(obs)) + "," +
              Jn("atr_ref_pips", atr / MathMax(g_aPip, 1e-10), 1));
  }

//--- 43 inducement -------------------------------------------------
string A_Inducement()
  {
   double sh[], sl[]; int shB[], slB[];
   A_CollectSwings(SwingLookback, 4, sh, shB, sl, slB);
   double idmLow  = ArraySize(sl) > 1 ? sl[1] : A_LowestLow(0, 30);
   double idmHigh = ArraySize(sh) > 1 ? sh[1] : A_HighestHigh(0, 30);
   bool takenLow = false, takenHigh = false;
   for(int i = 0; i < MathMin(g_anb, 20); i++)
     {
      if(g_aL[i] < idmLow)  takenLow = true;
      if(g_aH[i] > idmHigh) takenHigh = true;
     }
   return Obj(Jn("idm_low", idmLow, g_aDigits) + "," + Jn("idm_high", idmHigh, g_aDigits) + "," +
              Jb("idm_low_taken", takenLow) + "," + Jb("idm_high_taken", takenHigh) + "," +
              J("next_target", takenLow ? "BSL" : "SSL") + "," +
              Jn("dist_to_idm_low_pips", (g_aC[0] - idmLow) / MathMax(g_aPip, 1e-10), 1) + "," +
              Jn("dist_to_idm_high_pips", (idmHigh - g_aC[0]) / MathMax(g_aPip, 1e-10), 1) + "," +
              Jb("valid_setup", takenLow != takenHigh));
  }

//--- 44 premium_discount ---------------------------------------------
string A_PremiumDiscount()
  {
   double hi = A_HighestHigh(0, 50), lo = A_LowestLow(0, 50);
   double eq = (hi + lo) / 2.0, rng = hi - lo;
   double pos = rng > 0 ? (g_aC[0] - lo) / rng : 0.5;
   return Obj(Jn("range_high", hi, g_aDigits) + "," + Jn("range_low", lo, g_aDigits) + "," +
              Jn("equilibrium", eq, g_aDigits) + "," + Jn("position", pos, 4) + "," +
              J("zone", pos > 0.7 ? "DEEP_PREMIUM" : pos > 0.5 ? "PREMIUM" : pos > 0.3 ? "DISCOUNT" : "DEEP_DISCOUNT") + "," +
              Jn("premium_start", lo + rng * 0.5, g_aDigits) + "," +
              Jn("discount_end", lo + rng * 0.5, g_aDigits) + "," +
              Jn("ote_high", lo + rng * 0.79, g_aDigits) + "," + Jn("ote_low", lo + rng * 0.62, g_aDigits) + "," +
              Jb("in_ote", pos >= 0.62 && pos <= 0.79) + "," +
              Jn("dist_to_eq_pips", (g_aC[0] - eq) / MathMax(g_aPip, 1e-10), 1) + "," +
              J("bias", pos < 0.5 ? "LOOK_LONG" : "LOOK_SHORT"));
  }

/** 45 "all" -- every one of the 44 real sub-objects above, in one response, for the requested
 * symbol+timeframe. Ported from the reference EA's BuildPayload(), minus the recursive
 * self-reference (no "all" key inside "all"). */
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
   A_Push(d, Jr("ichimoku",         A_Ichimoku()));
   A_Push(d, Jr("fibonacci",        A_Fibonacci(sym)));
   A_Push(d, Jr("candles",          A_Candles()));
   A_Push(d, Jr("patterns",         A_Patterns()));
   A_Push(d, Jr("ict",              A_Ict(sym, tf)));
   A_Push(d, Jr("wyckoff",          A_Wyckoff()));
   A_Push(d, Jr("divergence",       A_Divergence()));
   A_Push(d, Jr("session",          A_Session()));
   A_Push(d, Jr("pivots",           A_Pivots(sym)));
   A_Push(d, Jr("levels",           A_Levels()));
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
   A_Push(d, Jr("backtest",         A_Backtest()));
   A_Push(d, Jr("swing",            A_Swing()));
   A_Push(d, Jr("order_blocks",     A_OrderBlocks()));
   A_Push(d, Jr("inducement",       A_Inducement()));
   A_Push(d, Jr("premium_discount", A_PremiumDiscount()));
   return Obj(A_Join(d));
  }

/** Real dispatch: loads the REQUESTED symbol+timeframe's own real bars, then computes
 * whichever endpoint was asked for. All 46 real DAVEMA endpoints are ported (item 8 audit
 * follow-up) -- 3 originally (trend/momentum/volatility), 43 more ported directly from the
 * user's own real reference DAVEMA_EA_1.mq5, plus "all" (every sub-object in one response) and
 * "ping" (a trivial, no-series-needed health check). An unrecognized endpoint name still gets an
 * honest error result instead of silently returning nothing. */
void RunAnalysis(string commandId, string endpoint, string symbol, string tfStr)
  {
   // "ping" genuinely needs no loaded series at all -- answered immediately, same as the
   // reference EA's real /ping (no auth, just confirms the EA itself is alive and responsive).
   if(endpoint == "ping")
     {
      AppendResultData(commandId, Obj(J("status", "ok") + "," + J("time", A_IsoTime(TimeGMT())) + "," + J("source", "DaveEA")));
      return;
     }
   ENUM_TIMEFRAMES tf = TimeframeFromString(tfStr);
   if(!LoadAnalysisSeries(symbol, tf))
     {
      AppendResult(commandId, false, "not enough real history loaded yet for " + symbol + " " + tfStr, "");
      return;
     }
   string data = "";
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
   else if(endpoint == "candles") data = A_Candles();
   else if(endpoint == "patterns") data = A_Patterns();
   else if(endpoint == "ict") data = A_Ict(symbol, tf);
   else if(endpoint == "wyckoff") data = A_Wyckoff();
   else if(endpoint == "divergence") data = A_Divergence();
   else if(endpoint == "session") data = A_Session();
   else if(endpoint == "pivots") data = A_Pivots(symbol);
   else if(endpoint == "levels") data = A_Levels();
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
   else if(endpoint == "backtest") data = A_Backtest();
   else if(endpoint == "swing") data = A_Swing();
   else if(endpoint == "order_blocks") data = A_OrderBlocks();
   else if(endpoint == "inducement") data = A_Inducement();
   else if(endpoint == "premium_discount") data = A_PremiumDiscount();
   else if(endpoint == "all") data = A_All(symbol, tf);
   else
     {
      AppendResult(commandId, false, "endpoint \"" + endpoint + "\" is not a real DAVEMA endpoint", "");
      return;
     }
   AppendResultData(commandId, data);
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
