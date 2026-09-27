#!/bin/bash
# Container start: a virtual screen for MetaTrader, then the agent (which starts MT5 once Dave
# sends the account). MetaTrader itself was installed into the image at build time.
mkdir -p "$DAVE_STATE_DIR"
Xvfb :99 -screen 0 1024x768x16 >/dev/null 2>&1 &
sleep 2
# The screen, for the app: VNC on localhost only, served to the browser by noVNC on 6080 (reachable
# on Railway's private network only; the bot checks the paired phone before relaying it).
x11vnc -display :99 -rfbport 5900 -localhost -shared -forever -nopw -quiet -noxdamage >/dev/null 2>&1 &
websockify --web=/usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &
exec python3 /opt/dave/agent.py
