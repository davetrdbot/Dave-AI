#!/usr/bin/env python3
"""
Dave's MT5 container agent: runs MetaTrader 5 (under Wine) with the Dave EA already on a chart,
logged into the trader's account -- so no Windows VPS is needed.

Three jobs, standard library only:

  1. RELAY. MT5 only lets an EA's WebRequest reach URLs ticked in Tools > Options, and that list
     is stored encrypted (MetaQuotes: it cannot be preset). So in the container the EA runs with
     UseFileBridge=true: each report is a file in MQL5/Files/dave_bridge (line 1 the URL, then the
     JSON body). This relay posts it and writes the reply back (line 1 the HTTP status).

  2. TERMINAL. Writes the start-up config MetaTrader documents for terminal64.exe /config:
     [Common] login, [Experts] allow algo trading, [StartUp] the EA + its preset + symbol/period,
     compiles the EA with MetaEditor, and (re)starts the terminal. /portable keeps every path
     inside the install folder, so nothing depends on a Windows user profile.

  3. CONTROL API for the bot, on AGENT_PORT (private network), guarded by MT5_AGENT_SECRET:
       GET  /health                    no auth -- liveness only
       GET  /status                    installed / compiled / running / logged in / relay stats
       POST /configure  {login, password, server, webhookUrl, symbol?, period?, inputs?}
       POST /settings   {symbol?, period?, inputs?}  -- same login, new chart/EA settings
       POST /restart | /stop
       GET  /logs                      tail of the terminal and EA logs, for diagnosing a login
"""

import glob
import hmac
import json
import os
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WINEPREFIX = os.environ.get("WINEPREFIX", "/config/.wine")
WINE = os.environ.get("WINE_BIN", "wine")
MT5_DIR = os.environ.get("MT5_DIR", os.path.join(WINEPREFIX, "drive_c", "Program Files", "MetaTrader 5"))
STATE_DIR = os.environ.get("DAVE_STATE_DIR", "/config/dave")
EA_SOURCE = os.environ.get("DAVE_EA_SOURCE", "/opt/dave/DaveEA.mq5")
PORT = int(os.environ.get("AGENT_PORT", "8081"))
SECRET = os.environ.get("MT5_AGENT_SECRET", "")
RELAY_TIMEOUT_S = float(os.environ.get("RELAY_TIMEOUT_S", "4.5"))

BRIDGE_DIR = os.path.join(MT5_DIR, "MQL5", "Files", "dave_bridge")
STATE_FILE = os.path.join(STATE_DIR, "state.json")
EA_REL = r"Dave\DaveEA"
PERIODS = {"M1", "M2", "M3", "M4", "M5", "M6", "M10", "M12", "M15", "M20", "M30", "H1", "H2", "H3", "H4", "H6", "H8", "H12", "D1", "W1", "MN1"}

lock = threading.Lock()
relay_stats = {"count": 0, "errors": 0, "lastAt": None, "lastStatus": None, "lastError": None}
terminal_proc = None


def log(*a):
    print("[dave-mt5]", *a, flush=True)


# --- state -----------------------------------------------------------------------------------------

def load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, STATE_FILE)


# --- relay -----------------------------------------------------------------------------------------

def handle_request_file(path):
    name = os.path.basename(path)
    rid = name[len("req_"):-len(".json")]
    try:
        with open(path, "rb") as f:
            raw = f.read()
        os.remove(path)
    except OSError:
        return  # the EA gave up on it and deleted it, or another pass took it
    text = raw.decode("utf-8", "replace")
    url, _, body = text.partition("\n")
    status, answer = 0, ""
    try:
        req = urllib.request.Request(url.strip(), data=body.encode("utf-8"), headers={"content-type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=RELAY_TIMEOUT_S) as res:
            status, answer = res.status, res.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        status, answer = e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # network down, bad URL -- the EA logs the status line
        status, answer = 599, str(e)
    out = os.path.join(BRIDGE_DIR, "res_" + rid + ".json")
    with open(out + ".tmp", "wb") as f:
        f.write(("%d\n%s" % (status, answer)).encode("utf-8"))
    os.replace(out + ".tmp", out)
    with lock:
        relay_stats["count"] += 1
        relay_stats["lastAt"] = time.time()
        relay_stats["lastStatus"] = status
        if status != 200:
            relay_stats["errors"] += 1
            relay_stats["lastError"] = answer[:300]


def relay_loop():
    while True:
        try:
            for path in sorted(glob.glob(os.path.join(BRIDGE_DIR, "req_*.json"))):
                threading.Thread(target=handle_request_file, args=(path,), daemon=True).start()
        except Exception as e:
            log("relay error:", e)
        time.sleep(0.05)


# --- terminal --------------------------------------------------------------------------------------

def installed():
    return os.path.exists(os.path.join(MT5_DIR, "terminal64.exe"))


def ex5_path():
    return os.path.join(MT5_DIR, "MQL5", "Experts", "Dave", "DaveEA.ex5")


def compile_ea():
    """Copies the EA source in and compiles it with MetaEditor. Returns (ok, message)."""
    dst_dir = os.path.join(MT5_DIR, "MQL5", "Experts", "Dave")
    os.makedirs(dst_dir, exist_ok=True)
    shutil.copyfile(EA_SOURCE, os.path.join(dst_dir, "DaveEA.mq5"))
    log_path = os.path.join(dst_dir, "compile.log")
    if os.path.exists(ex5_path()):
        os.remove(ex5_path())
    subprocess.run(
        [WINE, os.path.join(MT5_DIR, "MetaEditor64.exe"), "/portable", r"/compile:MQL5\Experts\Dave\DaveEA.mq5", r"/log:MQL5\Experts\Dave\compile.log"],
        cwd=MT5_DIR, timeout=300, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    summary = read_text(log_path)[-600:]
    return os.path.exists(ex5_path()), summary.strip()


def read_text(path):
    """MetaTrader writes its logs in UTF-16LE; compile logs vary. Read either."""
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return ""
    if data[:2] in (b"\xff\xfe", b"\xfe\xff") or (len(data) > 1 and data[1:2] == b"\x00"):
        return data.decode("utf-16", "replace")
    return data.decode("utf-8", "replace")


def write_utf16(path, text):
    # MetaTrader's own .ini and .set files are UTF-16LE with a BOM; it reads them reliably that way.
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"\xff\xfe" + text.replace("\n", "\r\n").encode("utf-16-le"))


def ea_inputs(state):
    inputs = {"UseFileBridge": "true", "WebhookURL": state["webhookUrl"], "EaToken": state.get("token") or state["webhookUrl"].rstrip("/").split("/")[-1]}
    for k, v in (state.get("inputs") or {}).items():
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(k)) and k not in ("UseFileBridge", "WebhookURL", "EaToken"):
            inputs[k] = str(v).lower() if isinstance(v, bool) else str(v)
    return inputs


PROFILE = "Dave"
# chart .chr files store the timeframe as a unit (0 minutes, 1 hours, 2 days) and a size.
CHR_PERIODS = {"M1": (0, 1), "M5": (0, 5), "M15": (0, 15), "M30": (0, 30), "H1": (1, 1), "H4": (1, 4), "D1": (2, 1)}


def write_profile(state):
    """MetaTrader's own chart profile "Dave": one chart per Market Watch pair. Opening a chart puts
    its pair in Market Watch, so MT5 itself starts with every pair loaded and on screen -- not just
    the EA's chart. The EA's chart comes from [StartUp] on top of these."""
    folder = os.path.join(MT5_DIR, "MQL5", "Profiles", "Charts", PROFILE)
    os.makedirs(folder, exist_ok=True)
    for name in os.listdir(folder):
        if name.lower().endswith(".chr"):
            os.remove(os.path.join(folder, name))
    unit, size = CHR_PERIODS.get(state.get("period", "M1"), (0, 1))
    pairs = [p for p in (state.get("marketWatch") or []) if p != state.get("symbol")]
    for i, sym in enumerate(pairs, 1):
        write_utf16(os.path.join(folder, "chart%02d.chr" % i), "\n".join([
            "<chart>", "id=%d" % (133000000000000000 + i), "symbol=%s" % sym,
            "period_type=%d" % unit, "period_size=%d" % size, "mode=1", "scale=4", "grid=0", "scroll=1", "shift=1",
            "ohlc=1", "bidline=1", "windows_total=1", "", "<window>", "height=100.000000", "objects=0", "",
            "<indicator>", "name=Main", "path=", "apply=1", "show_data=1", "fixed_height=-1", "</indicator>",
            "</window>", "</chart>", "",
        ]))


def write_config(state):
    write_profile(state)
    preset = "\n".join("%s=%s" % kv for kv in ea_inputs(state).items()) + "\n"
    write_utf16(os.path.join(MT5_DIR, "MQL5", "Presets", "dave.set"), preset)
    ini = "\n".join([
        "[Common]",
        "Login=%s" % state["login"],
        "Password=%s" % state["password"],
        "Server=%s" % state["server"],
        "KeepPrivate=1",
        "NewsEnable=0",
        "[Experts]",
        "AllowLiveTrading=1",
        "AllowDllImport=0",
        "Enabled=1",
        "Account=0",
        "Profile=0",
        "[Charts]",
        "ProfileLast=%s" % PROFILE,
        "[StartUp]",
        "Expert=%s" % EA_REL,
        "ExpertParameters=dave.set",
        "Symbol=%s" % state.get("symbol", "EURUSD"),
        "Period=%s" % state.get("period", "M1"),
        "",
    ])
    # MetaTrader's own folder is "Config" -- on Linux "config" would be a different folder.
    write_utf16(os.path.join(MT5_DIR, "Config", "dave-startup.ini"), ini)


def terminal_running():
    try:
        out = subprocess.run(["pgrep", "-f", "terminal64.exe"], capture_output=True, text=True).stdout
        return bool(out.strip())
    except OSError:
        return False


def stop_terminal():
    global terminal_proc
    subprocess.run(["pkill", "-f", "terminal64.exe"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(40):
        if not terminal_running():
            break
        time.sleep(0.25)
    if terminal_running():
        subprocess.run(["pkill", "-9", "-f", "terminal64.exe"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    terminal_proc = None


def start_terminal(state):
    global terminal_proc
    write_config(state)
    os.makedirs(BRIDGE_DIR, exist_ok=True)
    terminal_proc = subprocess.Popen(
        # Relative to the install folder, and free of spaces: under Wine an absolute path through
        # "Program Files" reached the terminal mangled ('cannot load config "...ini""'), found by
        # running it for real.
        [WINE, os.path.join(MT5_DIR, "terminal64.exe"), "/portable", r"/config:Config\dave-startup.ini"],
        cwd=MT5_DIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    log("terminal started for login", state["login"], "on", state["server"])


def latest_log(folder):
    # Only the dated journals (20260923.log). MetaEditor also writes metaeditor.log into the same
    # folder, and a plain name sort puts it last -- the status then read the compiler's log and
    # never saw a login.
    files = sorted(f for f in glob.glob(os.path.join(folder, "*.log")) if re.fullmatch(r"\d{8}\.log", os.path.basename(f)))
    return read_text(files[-1]) if files else ""


def login_state():
    """Reads the terminal's own journal (checked against a real run under Wine). The account's lines
    look like "'12345678': authorized on <server> through ..." on success, "'12345678': authorization
    on <server> failed (Invalid account)" on a bad login, and "'12345678': connection to <server>
    lost" while it can't reach the broker. The newest of those wins."""
    text = latest_log(os.path.join(MT5_DIR, "logs"))
    lines = [l for l in text.splitlines() if re.search(r"authoriz|connection to .* lost|no connection|invalid account", l, re.I)]
    if not lines:
        return "unknown", None
    last = lines[-1]
    detail = re.sub(r"^\S+\s+\d\s+[\d:.]+\s+\S+\s+", "", last).strip()[:200]
    if re.search(r"authorized on|authorization on .* (?:successful|passed)", last, re.I) and not re.search(r"failed", last, re.I):
        return "logged-in", None
    if re.search(r"failed|invalid account", last, re.I):
        return "failed", detail
    return "connecting", detail


def status():
    state = load_state()
    login, login_detail = login_state() if installed() else ("unknown", None)
    with lock:
        relay = dict(relay_stats)
    return {
        "installed": installed(),
        "compiled": os.path.exists(ex5_path()),
        "running": terminal_running(),
        "login": login,
        "loginDetail": login_detail,
        "configured": bool(state.get("login")),
        "account": {k: state.get(k) for k in ("login", "server", "symbol", "period")} if state.get("login") else None,
        "inputs": state.get("inputs") or {},
        "marketWatch": state.get("marketWatch") or [],
        "relay": relay,
    }


# --- API -------------------------------------------------------------------------------------------

def check_payload(body, full):
    if full:
        for k in ("login", "password", "server", "webhookUrl"):
            if not str(body.get(k, "")).strip():
                return "%s is required" % k
        if not str(body["login"]).strip().isdigit():
            return "login must be the account number"
        if not re.match(r"^https?://", str(body["webhookUrl"])):
            return "webhookUrl must be an http(s) URL"
    if "period" in body and str(body["period"]).upper() not in PERIODS:
        return "period must be one of " + ", ".join(sorted(PERIODS))
    if "symbol" in body and not re.fullmatch(r"[A-Za-z0-9_.#+\-]{1,32}", str(body["symbol"])):
        return "symbol looks wrong"
    if "inputs" in body and not isinstance(body["inputs"], dict):
        return "inputs must be an object"
    if "marketWatch" in body:
        mw = body["marketWatch"]
        if not isinstance(mw, list) or len(mw) > 30 or not all(isinstance(x, str) and re.fullmatch(r"[A-Za-z0-9_.#+\-]{1,32}", x) for x in mw):
            return "marketWatch must be a list of symbols (up to 30)"
    return None


def apply_and_restart(state):
    if not installed():
        return {"ok": False, "error": "MetaTrader 5 is still installing -- try again in a few minutes."}
    ok, summary = compile_ea()
    if not ok:
        return {"ok": False, "error": "The EA did not compile.", "compileLog": summary}
    stop_terminal()
    start_terminal(state)
    return {"ok": True}


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self):
        given = self.headers.get("x-dave-agent-secret", "")
        return bool(SECRET) and hmac.compare_digest(given, SECRET)

    def _body(self):
        n = int(self.headers.get("content-length") or 0)
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return None

    def log_message(self, fmt, *args):  # quiet; nothing here should echo request bodies
        pass

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True})
        if not self._authorized():
            return self._json(401, {"error": "unauthorized"})
        if self.path == "/status":
            return self._json(200, status())
        if self.path == "/logs":
            return self._json(200, {
                "terminal": latest_log(os.path.join(MT5_DIR, "logs"))[-4000:],
                "experts": latest_log(os.path.join(MT5_DIR, "MQL5", "Logs"))[-4000:],
            })
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        try:
            self._post()
        except Exception as e:  # never leave the bot with an empty reply
            log("request failed:", repr(e))
            self._json(500, {"ok": False, "error": "The MT5 container hit an error: %s" % e})

    def _post(self):
        if not self._authorized():
            return self._json(401, {"error": "unauthorized"})
        body = self._body()
        if body is None:
            return self._json(400, {"error": "expected JSON"})
        with lock:
            state = load_state()
        if self.path == "/configure":
            err = check_payload(body, True)
            if err:
                return self._json(400, {"error": err})
            state.update({
                "login": str(body["login"]).strip(), "password": str(body["password"]), "server": str(body["server"]).strip(),
                "webhookUrl": str(body["webhookUrl"]).strip(), "token": body.get("token"),
                "symbol": str(body.get("symbol") or state.get("symbol") or "EURUSD"), "period": str(body.get("period") or state.get("period") or "M1").upper(),
                "inputs": body.get("inputs") if isinstance(body.get("inputs"), dict) else state.get("inputs") or {},
                "marketWatch": body.get("marketWatch") if isinstance(body.get("marketWatch"), list) else state.get("marketWatch") or [],
            })
            save_state(state)
            result = apply_and_restart(state)
            return self._json(200 if result["ok"] else 409, result)
        if self.path == "/settings":
            err = check_payload(body, False)
            if err:
                return self._json(400, {"error": err})
            if not state.get("login"):
                return self._json(409, {"error": "not configured yet -- send /configure first"})
            if "symbol" in body:
                state["symbol"] = str(body["symbol"])
            if "period" in body:
                state["period"] = str(body["period"]).upper()
            if "inputs" in body:
                state["inputs"] = {**(state.get("inputs") or {}), **body["inputs"]}
            if "marketWatch" in body:
                state["marketWatch"] = body["marketWatch"]
            save_state(state)
            result = apply_and_restart(state)
            return self._json(200 if result["ok"] else 409, result)
        if self.path == "/restart":
            if not state.get("login"):
                return self._json(409, {"error": "not configured yet"})
            stop_terminal()
            start_terminal(state)
            return self._json(200, {"ok": True})
        if self.path == "/stop":
            stop_terminal()
            return self._json(200, {"ok": True})
        return self._json(404, {"error": "not found"})


def supervise():
    """Keeps a configured terminal running -- MT5 under Wine occasionally exits, and a trader
    without a VPS has nobody to notice."""
    while True:
        time.sleep(30)
        try:
            state = load_state()
            if state.get("login") and installed() and os.path.exists(ex5_path()) and not terminal_running():
                log("terminal not running -- starting it again")
                start_terminal(state)
        except Exception as e:
            log("supervisor error:", e)


def main():
    if not SECRET:
        log("MT5_AGENT_SECRET is not set -- the control API will refuse every request until it is")
    os.makedirs(BRIDGE_DIR, exist_ok=True)
    threading.Thread(target=relay_loop, daemon=True).start()
    state = load_state()
    if state.get("login") and installed():
        if not os.path.exists(ex5_path()):
            compile_ea()
        start_terminal(state)
    threading.Thread(target=supervise, daemon=True).start()
    serve()


class DualStackServer(ThreadingHTTPServer):
    """IPv6 and IPv4 on one socket: Railway's private network (dave-mt5.railway.internal) can be
    IPv6-only, while local runs and health checks use IPv4."""
    address_family = socket.AF_INET6

    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


def serve():
    try:
        server = DualStackServer(("::", PORT), Handler)
    except OSError:  # no IPv6 on this host
        server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log("agent listening on", PORT)
    server.serve_forever()


if __name__ == "__main__":
    main()
