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

input string WebhookURL  = "{{WEBHOOK_URL}}";
input string EaToken     = "{{TOKEN}}"; // embedded in WebhookURL's path -- kept here for logging/diagnostics only
input int    PushSeconds = 5;

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

//+------------------------------------------------------------------+
//| Heartbeat + snapshot push -- full field set implemented Step 11  |
//+------------------------------------------------------------------+
void OnTimer()
  {
   PushSnapshot();
  }

void PushSnapshot()
  {
   string headers = "Content-Type: application/json\r\n";
   string body = "{\"type\":\"heartbeat\",\"account\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) +
                 ",\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + "}";

   char post[];
   int len = StringToCharArray(body, post, 0, StringLen(body));
   // StringToCharArray appends a terminating 0 byte -- WebRequest would
   // send that as a trailing NUL inside the POST body, which some JSON
   // parsers reject. Trim it off; ArraySize == StringLen(body)+1 when it
   // was appended, so only resize if that extra byte is actually there.
   if(ArraySize(post) > 0 && post[ArraySize(post) - 1] == 0)
      ArrayResize(post, ArraySize(post) - 1);

   char result[];
   string resultHeaders;
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
     }
   else if(status != 200)
     {
      Print("Dave EA: webhook responded with HTTP ", status, ": ", CharArrayToString(result));
     }
  }

//+------------------------------------------------------------------+
//| Trade instructions Dave sends back are handled here -- Step 11   |
//+------------------------------------------------------------------+
void OnTick()
  {
  }
//+------------------------------------------------------------------+
