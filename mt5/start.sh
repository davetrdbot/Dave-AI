#!/bin/bash
# Container start: a virtual screen for MetaTrader, then the agent (which starts MT5 once Dave
# sends the account). MetaTrader itself was installed into the image at build time.
mkdir -p "$DAVE_STATE_DIR"
Xvfb :99 -screen 0 1024x768x16 >/dev/null 2>&1 &
sleep 2
exec python3 /opt/dave/agent.py
