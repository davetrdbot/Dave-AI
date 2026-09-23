#!/bin/bash
# Runs in the container's desktop session (so MT5 has a display). Installs MetaTrader 5 on the
# first start -- the install lands on the /config volume, so later starts skip straight to the
# agent -- then hands over to the agent, which logs in and runs the EA once Dave sends the account.
export WINEPREFIX="${WINEPREFIX:-/config/.wine}" WINEDEBUG=-all
MT5_DIR="$WINEPREFIX/drive_c/Program Files/MetaTrader 5"
log() { echo "[dave-mt5] $*"; }

if [ ! -e "$MT5_DIR/terminal64.exe" ]; then
  log "installing MetaTrader 5 (first start only, a few minutes)"
  wine reg add "HKEY_CURRENT_USER\\Software\\Wine" /v Version /t REG_SZ /d win10 /f
  curl -fsSL -o /tmp/mt5setup.exe https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe
  wine /tmp/mt5setup.exe /auto
  rm -f /tmp/mt5setup.exe
fi

# The terminal unpacks its MQL5 folder (including the standard library the EA includes) the first
# time it runs. The EA cannot compile before that.
if [ ! -d "$MT5_DIR/MQL5/Include/Trade" ]; then
  log "first terminal run to unpack MQL5"
  (cd "$MT5_DIR" && wine terminal64.exe /portable) &
  for i in $(seq 1 120); do [ -d "$MT5_DIR/MQL5/Include/Trade" ] && break; sleep 2; done
  sleep 5
  pkill -f terminal64.exe
  sleep 3
fi

log "starting agent"
nohup python3 /opt/dave/agent.py >> /config/dave-agent.log 2>&1 &
