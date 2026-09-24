#!/bin/bash
# Build-time install: Wine prefix, MetaTrader 5 from the official installer, and one first run so
# the terminal unpacks its MQL5 folder (the standard library the EA needs to compile).
set -e
MT5_DIR="$WINEPREFIX/drive_c/Program Files/MetaTrader 5"
Xvfb :99 -screen 0 1024x768x16 >/dev/null 2>&1 &
XVFB=$!
sleep 2
"$WINE_BIN" --version
"$WINE_BIN" wineboot --init
"$WINE_BIN" reg add "HKEY_CURRENT_USER\\Software\\Wine" /v Version /t REG_SZ /d win10 /f
curl -fsSL -o /tmp/mt5setup.exe https://download.mql5.com/cdn/web/metaquotes.software.corp/mt5/mt5setup.exe
"$WINE_BIN" /tmp/mt5setup.exe /auto || true   # exits non-zero on a harmless 32-bit helper; checked below
rm -f /tmp/mt5setup.exe
test -e "$MT5_DIR/terminal64.exe" || { echo "MT5 did not install"; exit 1; }
(cd "$MT5_DIR" && "$WINE_BIN" terminal64.exe /portable) &
for i in $(seq 1 120); do [ -d "$MT5_DIR/MQL5/Include/Trade" ] && break; sleep 2; done
sleep 5
pkill -f terminal64.exe || true
wineserver -w || true
kill $XVFB || true
test -d "$MT5_DIR/MQL5/Include/Trade" || { echo "MT5 did not unpack MQL5"; exit 1; }
# The terminal's bundled examples and sounds are not needed and cost image size.
rm -rf "$MT5_DIR/MQL5/Experts/Examples" "$MT5_DIR/MQL5/Scripts/Examples" "$MT5_DIR/MQL5/Indicators/Examples" "$MT5_DIR/Sounds" "$MT5_DIR/Tester" 2>/dev/null || true
echo "MetaTrader 5 installed"
