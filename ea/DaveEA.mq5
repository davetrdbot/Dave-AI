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

input string WebhookURL     = "{{WEBHOOK_URL}}";
input string EaToken        = "{{TOKEN}}"; // embedded in WebhookURL's path -- kept here for logging/diagnostics only
input int    PushSeconds    = 6;     // periodic state-push cadence (Part 1 item 10 -- default 6s)
input bool   EnablePush     = true;  // Step 11.2: MT5 push notification on open/close/error
input bool   EnableEmail    = true;  // Step 11.2: email on open/close/error
input int    MagicNumber    = 88001; // ported from the reference DAVE.mq5 -- tags every order this EA places
input int    SlippagePoints = 20;    // ported from the reference DAVE.mq5

CTrade trade;

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

   Print("Dave EA starting. Webhook: ", WebhookURL, ", magic=", MagicNumber);
   EventSetTimer(PushSeconds);
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

void OnTimer()
  {
   PushReportAndExecuteCommands();
  }

void OnTick()
  {
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
                   "\"currentPrice\":" + DoubleToString(curPrice, 5) + "}";
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
void ExecuteCommandsFromResponse(string response)
  {
   int arrStart = StringFind(response, "\"commands\":[");
   if(arrStart < 0) return;
   arrStart += StringLen("\"commands\":[");
   int arrEnd = StringFind(response, "]", arrStart);
   if(arrEnd < 0) return;
   string arrBody = StringSubstr(response, arrStart, arrEnd - arrStart);
   if(StringLen(arrBody) == 0) return; // no commands this cycle

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
      bool ok = false;
      // Real bug fixed here: this used to only ever call trade.Buy/trade.Sell
      // (always market price, ignoring the "price" field entirely), so the 4
      // pending order types this SAME EA reports on in BuildReportJson could
      // never actually be placed via a Dave-issued "open" command -- silently
      // dropped as an unmatched type. All 6 real order types now handled.
      if(type == "buy") ok = trade.Buy(lots, symbol, 0, sl, tp);
      else if(type == "sell") ok = trade.Sell(lots, symbol, 0, sl, tp);
      else if(type == "buy_limit") { price = EnforcePendingPrice(symbol, type, price); ok = trade.BuyLimit(lots, price, symbol, sl, tp); }
      else if(type == "sell_limit") { price = EnforcePendingPrice(symbol, type, price); ok = trade.SellLimit(lots, price, symbol, sl, tp); }
      else if(type == "buy_stop") { price = EnforcePendingPrice(symbol, type, price); ok = trade.BuyStop(lots, price, symbol, sl, tp); }
      else if(type == "sell_stop") { price = EnforcePendingPrice(symbol, type, price); ok = trade.SellStop(lots, price, symbol, sl, tp); }
      ulong ticket = ok ? trade.ResultOrder() : 0;
      AppendResult(id, ok, ok ? "opened" : ("failed: " + trade.ResultRetcodeDescription()), ok ? IntegerToString((int)ticket) : "");
      if(ok) NotifyTradeEvent("Opened " + type + " " + DoubleToString(lots, 2) + " " + symbol);
      else NotifyTradeEvent("FAILED to open " + type + " " + symbol + ": " + trade.ResultRetcodeDescription());
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
#define DAVEEA_BARS 220

ENUM_TIMEFRAMES TimeframeFromString(string tf)
  {
   if(tf == "M1")  return PERIOD_M1;
   if(tf == "M5")  return PERIOD_M5;
   if(tf == "M15") return PERIOD_M15;
   if(tf == "M30") return PERIOD_M30;
   if(tf == "H1")  return PERIOD_H1;
   if(tf == "H4")  return PERIOD_H4;
   if(tf == "D1")  return PERIOD_D1;
   if(tf == "W1")  return PERIOD_W1;
   return PERIOD_M15; // real DAVEMA default, ported verbatim
  }

// Real bars loaded for the REQUESTED symbol+timeframe, index 0 = most recent (series order) --
// same convention the reference DAVEMA EA's O/H/L/C arrays used.
int    g_anb = 0;
double g_aO[], g_aH[], g_aL[], g_aC[];

bool LoadAnalysisSeries(string sym, ENUM_TIMEFRAMES tf)
  {
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int copied = CopyRates(sym, tf, 0, DAVEEA_BARS, rates);
   if(copied <= 20) return false; // not enough real history to compute anything meaningful yet
   g_anb = copied;
   ArrayResize(g_aO, copied); ArrayResize(g_aH, copied); ArrayResize(g_aL, copied); ArrayResize(g_aC, copied);
   for(int i = 0; i < copied; i++)
     {
      g_aO[i] = rates[i].open; g_aH[i] = rates[i].high; g_aL[i] = rates[i].low; g_aC[i] = rates[i].close;
     }
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
   int score = 0;
   if(g_aC[0] > ma20)  score++; else score--;
   if(g_aC[0] > ma50)  score++; else score--;
   if(g_aC[0] > ma200) score++; else score--;
   if(ema9 > ema21) score++; else score--;
   if(ma20 > ma50)  score++; else score--;
   string bias = score >= 4 ? "STRONG_BULL" : score >= 2 ? "BULL" : score <= -4 ? "STRONG_BEAR" : score <= -2 ? "BEAR" : "NEUTRAL";
   bool allBull = g_aC[0] > ma20 && ma20 > ma50 && ma50 > ma200;
   bool allBear = g_aC[0] < ma20 && ma20 < ma50 && ma50 < ma200;
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
          "\"dist_ma50_pips\":" + DoubleToString(A_Pips(sym, g_aC[0] - ma50), 1) + "}";
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

/** Real dispatch: loads the REQUESTED symbol+timeframe's own real bars, then computes
 * whichever endpoint was asked for. Unknown/not-yet-ported endpoints get an honest error
 * result instead of silently returning nothing. */
void RunAnalysis(string commandId, string endpoint, string symbol, string tfStr)
  {
   if(!LoadAnalysisSeries(symbol, TimeframeFromString(tfStr)))
     {
      AppendResult(commandId, false, "not enough real history loaded yet for " + symbol + " " + tfStr, "");
      return;
     }
   string data = "";
   if(endpoint == "trend") data = A_Trend(symbol);
   else if(endpoint == "momentum") data = A_Momentum();
   else if(endpoint == "volatility") data = A_Volatility(symbol);
   else
     {
      AppendResult(commandId, false, "endpoint \"" + endpoint + "\" is not ported yet", "");
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
void NotifyTradeEvent(string message)
  {
   Print("Dave EA: ", message);
   if(EnablePush)
      SendNotification(message);
   if(EnableEmail)
      SendMail("Dave EA trade event", message);
  }
//+------------------------------------------------------------------+
