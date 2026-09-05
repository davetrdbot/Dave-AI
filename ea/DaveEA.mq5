//+------------------------------------------------------------------+
//|                                                      DaveEA.mq5   |
//|  Dave's MT5 bridge -- deliberately "dumb": no analysis happens    |
//|  here. It pushes account/positions/pending-orders/heartbeat to    |
//|  Dave's webhook, and executes the open/modify/close/delete-       |
//|  pending instructions that come back in that SAME HTTP response   |
//|  (WebRequest is one-directional -- there is no other way for      |
//|  Dave to reach this EA). All thinking happens inside Dave itself, |
//|  using DAVEMA for market data.                                    |
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
   else
     {
      AppendResult(id, false, "unknown action \"" + action + "\"", "");
     }
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
