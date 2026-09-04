//+------------------------------------------------------------------+
//|                                                      DaveEA.mq5   |
//|  Dave's MT5 bridge -- deliberately "dumb": no analysis happens    |
//|  here. It pushes account/positions/pending-orders/heartbeat to    |
//|  Dave's webhook, and executes the open/modify/close/delete-       |
//|  pending instructions that come back in that SAME HTTP response   |
//|  (WebRequest is one-directional -- there is no other way for      |
//|  Dave to reach this EA). All thinking happens inside Dave itself, |
//|  using DAVEMA for market data.                                    |
//+------------------------------------------------------------------+
#property strict
#include <Trade\Trade.mqh>

input string WebhookURL     = "{{WEBHOOK_URL}}";
input string EaToken        = "{{TOKEN}}"; // embedded in WebhookURL's path -- kept here for logging/diagnostics only
input int    PushSeconds    = 5;
input bool   EnablePush     = true;  // Step 11.2: MT5 push notification on open/close/error
input bool   EnableEmail    = true;  // Step 11.2: email on open/close/error

CTrade trade;

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

   Print("Dave EA starting. Webhook: ", WebhookURL);
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
      string dir = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? "buy" : "sell";
      positions += "{\"ticket\":\"" + IntegerToString((int)ticket) + "\"," +
                   "\"symbol\":\"" + PositionGetString(POSITION_SYMBOL) + "\"," +
                   "\"type\":\"" + dir + "\"," +
                   "\"lots\":" + DoubleToString(PositionGetDouble(POSITION_VOLUME), 2) + "," +
                   "\"openPrice\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), 5) + "," +
                   "\"sl\":" + DoubleToString(PositionGetDouble(POSITION_SL), 5) + "," +
                   "\"tp\":" + DoubleToString(PositionGetDouble(POSITION_TP), 5) + "}";
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
          "\"results\":[" + results + "]}";
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

void ExecuteOneCommand(string obj)
  {
   string id = JsonGetString(obj, "id");
   string action = JsonGetString(obj, "action");

   if(action == "open")
     {
      string symbol = JsonGetString(obj, "symbol");
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
      else if(type == "buy_limit") ok = trade.BuyLimit(lots, price, symbol, sl, tp);
      else if(type == "sell_limit") ok = trade.SellLimit(lots, price, symbol, sl, tp);
      else if(type == "buy_stop") ok = trade.BuyStop(lots, price, symbol, sl, tp);
      else if(type == "sell_stop") ok = trade.SellStop(lots, price, symbol, sl, tp);
      ulong ticket = ok ? trade.ResultOrder() : 0;
      AppendResult(id, ok, ok ? "opened" : ("failed: " + trade.ResultRetcodeDescription()), ok ? IntegerToString((int)ticket) : "");
      if(ok) NotifyTradeEvent("Opened " + type + " " + DoubleToString(lots, 2) + " " + symbol);
      else NotifyTradeEvent("FAILED to open " + type + " " + symbol + ": " + trade.ResultRetcodeDescription());
     }
   else if(action == "modify")
     {
      string ticketStr = JsonGetString(obj, "ticket");
      ulong ticket = (ulong)StringToInteger(ticketStr);
      double sl = JsonGetNumber(obj, "sl", 0);
      double tp = JsonGetNumber(obj, "tp", 0);
      bool ok = trade.PositionModify(ticket, sl, tp);
      AppendResult(id, ok, ok ? "modified" : ("failed: " + trade.ResultRetcodeDescription()), "");
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
