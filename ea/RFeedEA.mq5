//+------------------------------------------------------------------+
//|                                                     RFeedEA.mq5   |
//|  R_Feed -- the SHARED DEMO/PRACTICE account. Two jobs only:       |
//|  (1) real historical candle download via CopyRates, (2) real      |
//|  paper trades (real fills, real SL/TP, zero real money) on this   |
//|  demo account. This EA runs on a DEMO ACCOUNT ONLY -- attaching   |
//|  it to a live account defeats the entire point of R_Feed and      |
//|  must never be done.                                              |
//|                                                                    |
//|  Same one-directional WebRequest contract as DaveEA.mq5, but a    |
//|  completely separate webhook/token (never the same URL as your    |
//|  real DaveEA) and its own command vocabulary (adds                |
//|  "request_history"). Every reported position/pending order        |
//|  includes a real SYMBOL_CUSTOM flag so Dave-side safety logic can |
//|  refuse to ever place a paper trade on a custom/synthetic symbol. |
//+------------------------------------------------------------------+
#property strict
#include <Trade\Trade.mqh>

input string WebhookURL     = "{{WEBHOOK_URL}}";
input string RFeedToken     = "{{TOKEN}}"; // embedded in WebhookURL's path -- kept here for logging/diagnostics only
input int    PushSeconds    = 5;

CTrade trade;

//+------------------------------------------------------------------+
int OnInit()
  {
   if(StringFind(WebhookURL, "{{") >= 0 || StringLen(RFeedToken) == 0 || StringFind(RFeedToken, "{{") >= 0)
     {
      Print("R_Feed EA: WebhookURL/RFeedToken still contain template placeholders. ",
            "Get a personalized copy from Dave instead of using this file as-is.");
      return(INIT_PARAMETERS_INCORRECT);
     }
   if(!MQLInfoInteger(MQL_TESTER) && !MQLInfoInteger(MQL_DEMO))
     {
      Print("R_Feed EA: this account does not report as a DEMO account. ",
            "R_Feed is demo-only, permanently, no exceptions -- refusing to run.");
      return(INIT_FAILED);
     }

   Print("R_Feed EA starting (demo account). Webhook: ", WebhookURL);
   EventSetTimer(PushSeconds);
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason) { EventKillTimer(); }
void OnTimer() { PushReportAndExecuteCommands(); }
void OnTick() { }

//+------------------------------------------------------------------+
void PushReportAndExecuteCommands()
  {
   string body = BuildReportJson();

   char post[];
   int rawLen = StringToCharArray(body, post, 0, StringLen(body));
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
         Print("R_Feed EA: WebRequest blocked (error 4014). Go to Tools > Options > Expert Advisors ",
               "and add the webhook host to 'Allow WebRequest for listed URL'.");
      else
         Print("R_Feed EA: WebRequest failed, error ", err);
      return;
     }
   if(status != 200)
     {
      Print("R_Feed EA: webhook responded with HTTP ", status, ": ", CharArrayToString(result));
      return;
     }

   ExecuteCommandsFromResponse(CharArrayToString(result));
  }

//+------------------------------------------------------------------+
//| Every position/pending order carries a REAL SYMBOL_CUSTOM flag   |
//| (confirmed real ENUM_SYMBOL_INFO_INTEGER member) -- this is the  |
//| actual safety data Dave-side custom-symbol refusal is built on.  |
//+------------------------------------------------------------------+
string BuildReportJson()
  {
   string positions = "";
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
     {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;
      string symbol = PositionGetString(POSITION_SYMBOL);
      bool isCustom = (bool)SymbolInfoInteger(symbol, SYMBOL_CUSTOM);
      string dir = (PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY) ? "buy" : "sell";
      if(positions != "") positions += ",";
      positions += "{\"ticket\":\"" + IntegerToString((int)ticket) + "\"," +
                   "\"symbol\":\"" + symbol + "\"," +
                   "\"type\":\"" + dir + "\"," +
                   "\"lots\":" + DoubleToString(PositionGetDouble(POSITION_VOLUME), 2) + "," +
                   "\"openPrice\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), 5) + "," +
                   "\"sl\":" + DoubleToString(PositionGetDouble(POSITION_SL), 5) + "," +
                   "\"tp\":" + DoubleToString(PositionGetDouble(POSITION_TP), 5) + "," +
                   "\"isCustom\":" + (isCustom ? "true" : "false") + "}";
     }

   string pendingOrders = "";
   int totalOrders = OrdersTotal();
   for(int i = 0; i < totalOrders; i++)
     {
      ulong ticket = OrderGetTicket(i);
      if(ticket == 0) continue;
      string symbol = OrderGetString(ORDER_SYMBOL);
      bool isCustom = (bool)SymbolInfoInteger(symbol, SYMBOL_CUSTOM);
      ENUM_ORDER_TYPE ot = (ENUM_ORDER_TYPE)OrderGetInteger(ORDER_TYPE);
      if(pendingOrders != "") pendingOrders += ",";
      pendingOrders += "{\"ticket\":\"" + IntegerToString((int)ticket) + "\"," +
                        "\"symbol\":\"" + symbol + "\"," +
                        "\"type\":\"" + OrderTypeToString(ot) + "\"," +
                        "\"lots\":" + DoubleToString(OrderGetDouble(ORDER_VOLUME_CURRENT), 2) + "," +
                        "\"price\":" + DoubleToString(OrderGetDouble(ORDER_PRICE_OPEN), 5) + "," +
                        "\"isCustom\":" + (isCustom ? "true" : "false") + "}";
     }

   string results = LastResultsJson();
   string historyResults = LastHistoryResultsJson();

   return "{\"type\":\"heartbeat\"," +
          "\"account\":\"" + IntegerToString((int)AccountInfoInteger(ACCOUNT_LOGIN)) + "\"," +
          "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + "," +
          "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + "," +
          "\"positions\":[" + positions + "]," +
          "\"pendingOrders\":[" + pendingOrders + "]," +
          "\"results\":[" + results + "]," +
          "\"historyResults\":[" + historyResults + "]}";
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

string g_pendingResultsJson = "";
string g_pendingHistoryResultsJson = "";

string LastResultsJson() { string r = g_pendingResultsJson; g_pendingResultsJson = ""; return r; }
string LastHistoryResultsJson() { string r = g_pendingHistoryResultsJson; g_pendingHistoryResultsJson = ""; return r; }

void AppendResult(string commandId, bool ok, string message, string ticket)
  {
   if(g_pendingResultsJson != "") g_pendingResultsJson += ",";
   g_pendingResultsJson += "{\"commandId\":\"" + commandId + "\"," +
                           "\"status\":\"" + (ok ? "ok" : "error") + "\"," +
                           "\"message\":\"" + message + "\"" +
                           (ticket != "" ? ",\"ticket\":\"" + ticket + "\"" : "") + "}";
  }

//+------------------------------------------------------------------+
//| Real CopyRates-backed history response. Three real overloads     |
//| exist (position/count, start_time/count, start_time/stop_time --|
//| the date-range one is used here); SERIES_SYNCHRONIZED confirms  |
//| the terminal has genuinely finished downloading this range from |
//| the broker before CopyRates is trusted to have the full result. |
//+------------------------------------------------------------------+
void AppendHistoryResult(string commandId, string symbol, string timeframe, datetime startTime, datetime endTime)
  {
   ENUM_TIMEFRAMES tf = StringToTimeframe(timeframe);

   // Give the terminal a real chance to finish syncing this range from the
   // broker before trusting CopyRates' count -- a real documented gotcha,
   // not a made-up precaution.
   for(int wait = 0; wait < 20; wait++)
     {
      if(SeriesInfoInteger(symbol, tf, SERIES_SYNCHRONIZED)) break;
      Sleep(250);
     }

   MqlRates rates[];
   int copied = CopyRates(symbol, tf, startTime, endTime, rates);

   if(g_pendingHistoryResultsJson != "") g_pendingHistoryResultsJson += ",";
   if(copied <= 0)
     {
      g_pendingHistoryResultsJson += "{\"commandId\":\"" + commandId + "\",\"status\":\"error\"," +
                                      "\"message\":\"CopyRates returned " + IntegerToString(copied) + " bars\"}";
      return;
     }

   string candles = "";
   for(int i = 0; i < copied; i++)
     {
      if(candles != "") candles += ",";
      candles += "{\"time\":" + IntegerToString((int)rates[i].time) + "," +
                 "\"open\":" + DoubleToString(rates[i].open, 5) + "," +
                 "\"high\":" + DoubleToString(rates[i].high, 5) + "," +
                 "\"low\":" + DoubleToString(rates[i].low, 5) + "," +
                 "\"close\":" + DoubleToString(rates[i].close, 5) + "," +
                 "\"tickVolume\":" + IntegerToString((int)rates[i].tick_volume) + "}";
     }
   g_pendingHistoryResultsJson += "{\"commandId\":\"" + commandId + "\",\"status\":\"ok\"," +
                                   "\"symbol\":\"" + symbol + "\",\"candles\":[" + candles + "]}";
  }

ENUM_TIMEFRAMES StringToTimeframe(string tf)
  {
   if(tf == "M1") return PERIOD_M1;
   if(tf == "M5") return PERIOD_M5;
   if(tf == "M15") return PERIOD_M15;
   if(tf == "M30") return PERIOD_M30;
   if(tf == "H1") return PERIOD_H1;
   if(tf == "H4") return PERIOD_H4;
   if(tf == "D1") return PERIOD_D1;
   if(tf == "W1") return PERIOD_W1;
   return PERIOD_H1;
  }

//+------------------------------------------------------------------+
void ExecuteCommandsFromResponse(string response)
  {
   int arrStart = StringFind(response, "\"commands\":[");
   if(arrStart < 0) return;
   arrStart += StringLen("\"commands\":[");
   int arrEnd = StringFind(response, "]", arrStart);
   if(arrEnd < 0) return;
   string arrBody = StringSubstr(response, arrStart, arrEnd - arrStart);
   if(StringLen(arrBody) == 0) return;

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

//+------------------------------------------------------------------+
//| Real safety gate, enforced in the EA itself (not just Dave-side): |
//| a custom/synthetic symbol is refused HERE too, so this is never   |
//| single-point-of-failure safety relying only on the server side.  |
//+------------------------------------------------------------------+
void ExecuteOneCommand(string obj)
  {
   string id = JsonGetString(obj, "id");
   string action = JsonGetString(obj, "action");

   if(action == "request_history")
     {
      string symbol = JsonGetString(obj, "symbol");
      string timeframe = JsonGetString(obj, "timeframe");
      datetime startTime = (datetime)JsonGetNumber(obj, "startTime", 0);
      datetime endTime = (datetime)JsonGetNumber(obj, "endTime", 0);
      AppendHistoryResult(id, symbol, timeframe, startTime, endTime);
      return;
     }

   if(action == "open")
     {
      string symbol = JsonGetString(obj, "symbol");
      if((bool)SymbolInfoInteger(symbol, SYMBOL_CUSTOM))
        {
         AppendResult(id, false, "refused: \\'" + symbol + "\\' is a custom/synthetic symbol -- R_Feed is analysis-only for these", "");
         return;
        }
      string type = JsonGetString(obj, "type");
      double lots = JsonGetNumber(obj, "lots", 0);
      double price = JsonGetNumber(obj, "price", 0);
      double sl = JsonGetNumber(obj, "sl", 0);
      double tp = JsonGetNumber(obj, "tp", 0);
      string comment = JsonGetString(obj, "comment");
      trade.SetExpertMagicNumber(0);
      bool ok = false;
      if(type == "buy") ok = trade.Buy(lots, symbol, 0, sl, tp, comment);
      else if(type == "sell") ok = trade.Sell(lots, symbol, 0, sl, tp, comment);
      else if(type == "buy_limit") ok = trade.BuyLimit(lots, price, symbol, sl, tp, ORDER_TIME_GTC, 0, comment);
      else if(type == "sell_limit") ok = trade.SellLimit(lots, price, symbol, sl, tp, ORDER_TIME_GTC, 0, comment);
      else if(type == "buy_stop") ok = trade.BuyStop(lots, price, symbol, sl, tp, ORDER_TIME_GTC, 0, comment);
      else if(type == "sell_stop") ok = trade.SellStop(lots, price, symbol, sl, tp, ORDER_TIME_GTC, 0, comment);
      ulong ticket = ok ? trade.ResultOrder() : 0;
      AppendResult(id, ok, ok ? "opened" : ("failed: " + trade.ResultRetcodeDescription()), ok ? IntegerToString((int)ticket) : "");
     }
   else if(action == "modify")
     {
      ulong ticket = (ulong)StringToInteger(JsonGetString(obj, "ticket"));
      double sl = JsonGetNumber(obj, "sl", 0);
      double tp = JsonGetNumber(obj, "tp", 0);
      bool ok = trade.PositionModify(ticket, sl, tp);
      AppendResult(id, ok, ok ? "modified" : ("failed: " + trade.ResultRetcodeDescription()), "");
     }
   else if(action == "close")
     {
      string ticketStr = JsonGetString(obj, "ticket");
      ulong ticket = (ulong)StringToInteger(ticketStr);
      double partialLots = JsonGetNumber(obj, "lots", 0);
      bool ok = (partialLots > 0) ? trade.PositionClosePartial(ticket, partialLots) : trade.PositionClose(ticket);
      AppendResult(id, ok, ok ? "closed" : ("failed: " + trade.ResultRetcodeDescription()), "");
     }
   else if(action == "delete_pending")
     {
      ulong ticket = (ulong)StringToInteger(JsonGetString(obj, "ticket"));
      bool ok = trade.OrderDelete(ticket);
      AppendResult(id, ok, ok ? "deleted" : ("failed: " + trade.ResultRetcodeDescription()), "");
     }
   else
     {
      AppendResult(id, false, "unknown action \"" + action + "\"", "");
     }
  }
