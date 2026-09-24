"""
Tests for mt5/agent.py that need no Wine: the file-bridge relay, the generated start-up config and
EA preset, the login reading of the terminal journal, and the control API's guards.

    python3 mt5/test_agent.py

(The Wine side -- install, compile, terminal start, EA attach -- was run for real; see README.)
"""
import http.server
import json
import os
import sys
import tempfile
import threading
import time
import urllib.request

# A stand-in for the broker directory (mt5.mtapi.io's /Search?company=), so tests never go online.
DIRECTORY = [{"companyName": "Jarocel (Pty) Ltd", "results": [
    {"name": "Headway-Demo", "access": ["[2600:3c0c::1]:443", "91.223.236.81:1950", "91.223.236.81:443"]},
    {"name": "Headway-Real", "access": ["185.237.99.146:443"]}]}]
directory_queries = []


class Directory(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        directory_queries.append(self.path)
        body = json.dumps(DIRECTORY if "headway" in self.path.lower() else []).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(body)

    def log_message(self, *a):
        pass


_directory = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Directory)
threading.Thread(target=_directory.serve_forever, daemon=True).start()

tmp = tempfile.mkdtemp()
os.environ.update({
    "MT5_RESOLVER_URL": "http://127.0.0.1:%d" % _directory.server_address[1],
    "MT5_DIR": os.path.join(tmp, "mt5"),
    "DAVE_STATE_DIR": os.path.join(tmp, "state"),
    "MT5_AGENT_SECRET": "s3cret-for-tests",
    "AGENT_PORT": "0",
})
sys.path.insert(0, os.path.dirname(__file__))
import agent  # noqa: E402

failures = []


def check(cond, msg):
    print(("  ok  " if cond else "  FAIL ") + msg)
    if not cond:
        failures.append(msg)


# --- a stand-in bot the relay posts to -------------------------------------------------------------
received = []


class Bot(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["content-length"])).decode()
        received.append((self.path, body))
        code = 200 if "fail" not in self.path else 503
        out = json.dumps({"commands": [{"id": "c1", "action": "analyze"}]}).encode()
        self.send_response(code)
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


bot = http.server.HTTPServer(("127.0.0.1", 0), Bot)
threading.Thread(target=bot.serve_forever, daemon=True).start()
BOT = "http://127.0.0.1:%d" % bot.server_address[1]

print("[1] relay: EA request file -> POST -> response file with the status line")
os.makedirs(agent.BRIDGE_DIR, exist_ok=True)
threading.Thread(target=agent.relay_loop, daemon=True).start()


def ea_request(rid, url, body):
    path = os.path.join(agent.BRIDGE_DIR, "req_%s.json" % rid)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        f.write(url + "\n" + body)
    os.replace(path + ".tmp", path)
    res = os.path.join(agent.BRIDGE_DIR, "res_%s.json" % rid)
    for _ in range(100):
        if os.path.exists(res):
            with open(res, encoding="utf-8") as f:
                return f.read()
        time.sleep(0.05)
    return None


answer = ea_request("1_1", BOT + "/hooks/ea/tok", '{"type":"heartbeat","balance":127.59}')
check(answer is not None and answer.startswith("200\n"), "response file starts with the HTTP status")
check(answer is not None and '"action": "analyze"' in answer, "response body is the bot's reply (commands for the EA)")
check(received and received[-1] == ("/hooks/ea/tok", '{"type":"heartbeat","balance":127.59}'), "bot got the exact path and body")
check(not os.path.exists(os.path.join(agent.BRIDGE_DIR, "req_1_1.json")), "request file consumed")
answer = ea_request("1_2", BOT + "/hooks/ea/fail", "{}")
check(answer is not None and answer.startswith("503\n"), "a bot error reaches the EA as its status, not as success")
answer = ea_request("1_3", "http://127.0.0.1:9/nothing-listens", "{}")
check(answer is not None and answer.startswith("599\n"), "an unreachable bot is reported (599), never hangs the EA")
check(agent.relay_stats["errors"] == 2 and agent.relay_stats["count"] == 3, "relay stats count calls and errors")
ea_request("1_4", BOT + "/hooks/ea/abc", '{"type":"heartbeat","algoTrading":true,"phonePush":true,"positions":[]}')
check(agent.relay_stats.get("phonePush") is True, "the EA's own report of phone push (MetaQuotes ID) is picked up")

print("[2] config: start-up ini + EA preset in MetaTrader's format")
state = {"login": "12345678", "password": "p@ss", "server": "Deriv-Demo", "webhookUrl": BOT + "/hooks/ea/abc", "token": "abc",
         "symbol": "VOL_80", "period": "M5", "marketWatch": ["VOL_80", "BOOM_100", "EURUSD"], "inputs": {"PushSeconds": 7, "EnablePush": False, "UseFileBridge": False, "Evil\nKey": 1}}
agent.write_config(state)
ini = agent.read_text(os.path.join(agent.MT5_DIR, "Config", "dave-startup.ini"))
preset = agent.read_text(os.path.join(agent.MT5_DIR, "MQL5", "Presets", "dave.set"))
with open(os.path.join(agent.MT5_DIR, "Config", "dave-startup.ini"), "rb") as f:
    check(f.read(2) == b"\xff\xfe", "ini is UTF-16LE with a BOM, like MetaTrader's own")
for line in ["Login=12345678", "Server=Deriv-Demo", "AllowLiveTrading=1", "Enabled=1", r"Expert=Dave\DaveEA", "ExpertParameters=dave.set", "Symbol=VOL_80", "Period=M5"]:
    check(line in ini, "ini has " + line)
check("UseFileBridge=true" in preset, "preset forces the file bridge on")
check("WebhookURL=%s/hooks/ea/abc" % BOT in preset and "EaToken=abc" in preset, "preset carries the bot URL and token")
check("PushSeconds=7" in preset and "EnablePush=false" in preset, "preset carries the trader's inputs (bools lowercase)")
check("UseFileBridge=false" not in preset and "Evil" not in preset, "inputs cannot switch the bridge off or inject lines")
check("ProfileLast=Dave" in ini, "MT5 opens its own 'Dave' chart profile")
prof = os.path.join(agent.MT5_DIR, "MQL5", "Profiles", "Charts", "Dave")
charts = sorted(os.listdir(prof))
syms = [agent.read_text(os.path.join(prof, c)).split("symbol=")[1].split()[0] for c in charts]
check(syms == ["BOOM_100", "EURUSD"], "one chart per Market Watch pair (the EA's own chart comes from [StartUp])")
check("period_type=0" in agent.read_text(os.path.join(prof, charts[0])) and "period_size=5" in agent.read_text(os.path.join(prof, charts[0])), "pair charts use the chosen timeframe")
agent.write_config({**state, "marketWatch": ["GBPUSD"]})
check(len(os.listdir(prof)) == 1, "a new list replaces the old charts instead of piling up")
check("MarketWatch" not in preset, "Market Watch is MT5's, not an EA input")

print("[2b] broker server name -> its real address (MT5 alone would fall back to MetaQuotes-Demo)")
access, sugg, err = agent.resolve_server("Headway-Demo")
check(access == ["91.223.236.81:443", "91.223.236.81:1950", "[2600:3c0c::1]:443"], "exact name found; IPv4 :443 first, IPv6 last")
check(any("company=Headway" in q for q in directory_queries), "looked up by the broker part of the name")
access, sugg, err = agent.resolve_server("headway-demoo")
check(access is None and err is None and sugg[:1] == ["Headway-Demo"], "a misspelt name is refused with the closest real names")
check(agent.resolve_server("91.223.236.81:1950")[0] == ["91.223.236.81:1950"], "an address typed as host:port is used as is")
agent.write_config({**state, "server": "Headway-Demo", "serverAccess": ["91.223.236.81:443", "66.1.1.1:443"], "serverAccessIndex": 1})
check("Server=66.1.1.1:443" in agent.read_text(os.path.join(agent.MT5_DIR, "Config", "dave-startup.ini")), "MT5 is given the address (the current one after a rotation), not the bare name")
agent.write_config(state)
check("Server=Deriv-Demo" in agent.read_text(os.path.join(agent.MT5_DIR, "Config", "dave-startup.ini")), "no lookup result -> the name as typed, as before")

print("[3] login state from the terminal journal (lines as MT5 writes them)")
logs = os.path.join(agent.MT5_DIR, "logs")
os.makedirs(logs, exist_ok=True)


def journal(*lines):
    with open(os.path.join(logs, "20260923.log"), "wb") as f:
        f.write(b"\xff\xfe" + "\r\n".join(lines).encode("utf-16-le"))
    with open(os.path.join(logs, "metaeditor.log"), "w") as f:
        f.write("compile noise, must be ignored")


journal("EO\t1\t20:57:11.607\tNetwork\t'12345678': connection to Deriv-Demo lost")
check(agent.login_state() == ("connecting", "'12345678': connection to Deriv-Demo lost"), "connection lost -> connecting, with the reason")
journal("x", "QQ\t0\t20:58:00.000\tNetwork\t'12345678': authorized on Deriv-Demo through Access Point EU 1")
check(agent.login_state()[0] == "logged-in", "authorized on -> logged-in")
journal("x", "QQ\t0\t21:37:22.000\tNetwork\t'5161314': authorized on 91.223.236.81:443 through Access Server #2 (ping: 40.1 ms)",
        "QR\t0\t21:37:23.000\tNetwork\t'5161314': previous successful authorization performed from 152.55.184.20 on 2026.09.24 21:37:23")
check(agent.login_state()[0] == "logged-in", "'previous successful authorization' (printed right after a real login, seen live) -> logged-in, not connecting")
journal("QQ\t0\t20:58:00.000\tNetwork\t'12345678': authorized on Deriv-Demo", "RR\t2\t20:59:00.000\tNetwork\t'12345678': authorization on Deriv-Demo failed (Invalid account)")
state_, detail = agent.login_state()
check(state_ == "failed" and "Invalid account" in detail, "newest line wins: a later failed login is reported with its reason")

print("[4] control API guards")
server = agent.ThreadingHTTPServer(("127.0.0.1", 0), agent.Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
API = "http://127.0.0.1:%d" % server.server_address[1]


def call(method, path, body=None, secret="s3cret-for-tests"):
    req = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                 headers={"x-dave-agent-secret": secret, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


check(call("GET", "/health", secret="")[0] == 200, "health needs no secret")
check(call("GET", "/status", secret="wrong")[0] == 401, "wrong secret refused")
check(call("POST", "/stop", {}, secret="")[0] == 401, "no secret refused")
code, body = call("POST", "/configure", {"login": "abc", "password": "x", "server": "S", "webhookUrl": BOT})
check(code == 400 and "account number" in body["error"], "non-numeric login refused")
code, body = call("POST", "/configure", {"login": "123", "password": "x", "server": "S", "webhookUrl": "file:///etc/passwd"})
check(code == 400 and "http" in body["error"], "non-http webhook refused")
code, body = call("POST", "/settings", {"period": "M7"})
check(code in (400, 409), "bad period refused")
code, body = call("POST", "/settings", {"marketWatch": ["EURUSD", "bad pair!"]})
check(code == 400 and "marketWatch" in body["error"], "a bad Market Watch pair is refused")
code, body = call("POST", "/settings", {"metaquotesIds": ["12AB34CD", "not-an-id!"]})
check(code == 400 and "MetaQuotes" in body["error"], "a malformed MetaQuotes ID is refused")
code, body = call("POST", "/settings", {"metaquotesIds": ["AAAAAAAA", "BBBBBBBB", "CCCCCCCC", "DDDDDDDD", "EEEEEEEE"]})
check(code == 400, "more than 4 MetaQuotes IDs refused (MT5's own limit)")
code, body = call("POST", "/settings", {"marketWatch": ["P%d" % i for i in range(31)]})
check(code == 400, "more than 30 Market Watch pairs refused")
code, body = call("POST", "/configure", {"login": "123", "password": "x", "server": "Headway-Demoo", "webhookUrl": BOT + "/hooks/ea/t"})
check(code == 400 and "Headway-Demo" in body["error"] and body["suggestions"][0] == "Headway-Demo", "configure with a wrong server name says so, with suggestions, and starts nothing")
code, body = call("POST", "/configure", {"login": "123", "password": "x", "server": "S", "webhookUrl": BOT + "/hooks/ea/t"})
check(code == 409 and "installing" in body["error"], "before MT5 is installed, configure says so instead of failing oddly")
code, body = call("GET", "/status")
check(code == 200 and body["installed"] is False and body["account"]["login"] == "123" and "password" not in json.dumps(body), "status never includes the password")

print()
if failures:
    print("%d FAILED" % len(failures))
    sys.exit(1)
print("ALL PASSED")
