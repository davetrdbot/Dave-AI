//+------------------------------------------------------------------+
//|                                                      DaveEA.mq5   |
//|  Dave's MT5 bridge -- deliberately "dumb": no analysis happens    |
//|  here. It pushes price/account/positions/orders/heartbeat to      |
//|  Dave's webhook, and executes open/modify/close instructions      |
//|  Dave sends back. All thinking happens inside Dave itself, using  |
//|  DAVEMA for market data. Full protocol implementation is Step 11  |
//|  -- this template ships with the two placeholders below wired in  |
//|  by dave-telegram's /ea command so it's ready to compile today.   |
//+------------------------------------------------------------------+
#property strict

input string WebhookURL = "{{WEBHOOK_URL}}";
input string EaToken    = "{{TOKEN}}";
input int    PushSeconds = 5;

//+------------------------------------------------------------------+
int OnInit()
  {
   Print("Dave EA starting. Webhook: ", WebhookURL);
   EventSetTimer(PushSeconds);
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
  }

//+------------------------------------------------------------------+
//| Heartbeat + snapshot push -- full field set implemented Step 11  |
//+------------------------------------------------------------------+
void OnTimer()
  {
   PushSnapshot();
  }

void PushSnapshot()
  {
   string headers = "Content-Type: application/json\r\nX-EA-Token: " + EaToken + "\r\n";
   string body = "{\"type\":\"heartbeat\",\"account\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) +
                 ",\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + "}";
   char post[]; char result[]; string resultHeaders;
   StringToCharArray(body, post, 0, StringLen(body));
   WebRequest("POST", WebhookURL, headers, 5000, post, result, resultHeaders);
  }

//+------------------------------------------------------------------+
//| Trade instructions Dave sends back are handled here -- Step 11   |
//+------------------------------------------------------------------+
void OnTick()
  {
  }
//+------------------------------------------------------------------+
