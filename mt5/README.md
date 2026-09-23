# MT5 in Dave's own container (no VPS)

This folder is a second service that runs **MetaTrader 5 under Wine** on Linux, with the Dave EA
already compiled, attached to a chart and logged in to your account. It replaces the Windows VPS.

```
 Telegram / app ──> Dave bot ──(private network)──> MT5 container
                        ^                              │  MetaTrader 5 + Dave EA
                        └──── EA reports (file bridge) ┘
```

## Deploy on Railway (same project as the bot)

1. **New service → GitHub repo → this repo.** In the service's *Variables*:
   | Variable | Value |
   |---|---|
   | `RAILWAY_DOCKERFILE_PATH` | `mt5/Dockerfile` |
   | `MT5_AGENT_SECRET` | a long random string (keep it) |
2. **Add a volume** mounted at `/data` (0.5 GB is plenty -- it only holds your login settings;
   MetaTrader itself is built into the image). Without it, a redeploy means connecting again.
3. **On the bot service**, add:
   | Variable | Value |
   |---|---|
   | `MT5_AGENT_SECRET` | the same secret |

   Name the MT5 service `dave-mt5` and that's all the bot needs -- it finds it at
   `http://dave-mt5.railway.internal:8081`. (A different name: also set `MT5_AGENT_URL`.)
4. Deploy both. The first start of the MT5 service installs MetaTrader (a few minutes).
5. In Telegram send **/mt5 → Connect account** and type three things: account number, password
   (Dave deletes the message right after reading it), and server name exactly as MT5 shows it
   (e.g. `Deriv-Demo`). Or use the app: **Settings → MetaTrader 5**. That's all the trader ever
   enters -- the container's address and secret are server settings, never typed in chat.

Dave compiles the EA, starts MT5 logged in with the EA on a chart, and tells you whether the
broker accepted the login. From then on `/mt5` (or the app) changes the chart symbol, timeframe
and EA report interval, and restarts MT5 if it ever gets stuck.

**Market Watch.** MT5 starts with your active pair group in Market Watch, each pair on its own
chart (MetaTrader's own chart profile "Dave", written by the agent -- nothing to do with the EA's
inputs). `/mt5 → Market Watch pairs` (or the app) replaces the list: type the pairs separated by
commas, or tap *Use my pair group*. Up to 30. The container restarts MT5 by
itself if it exits.

The default build is lean -- no desktop -- so it fits Railway's trial/free limits (1 GB RAM).
**Want to watch MT5 in a browser?** Build `mt5/Dockerfile.desktop` instead (more memory; needs a
`/config` volume and `CUSTOM_USER` / `PASSWORD`), give it a public domain on port 3000, and open it.

## Anywhere else (a PC, a server)

```
docker build -f mt5/Dockerfile -t dave-mt5 .
docker run -d --name dave-mt5 -p 3000:3000 -p 8081:8081 \
  -e MT5_AGENT_SECRET=... -v dave-mt5:/config dave-mt5
```

Then set `MT5_AGENT_URL=http://<that machine>:8081` and the secret on the bot, and
`MT5_EA_BASE_URL` to an address of the bot that the container can reach.

## Why a file bridge

MetaTrader only lets an EA's `WebRequest` reach URLs ticked in *Tools → Options → Expert
Advisors*, and it stores that list encrypted, so no script can preset it. In the container the EA
runs with `UseFileBridge=true`: it writes each report to `MQL5/Files/dave_bridge`, and the agent
(`agent.py`) posts it to the bot and writes the reply back. On a normal install the EA still uses
`WebRequest` as before.

## What was verified, and how

Run for real (MetaTrader 5 build 6182 under Wine on Linux, driven by `agent.py`):
- MT5 installs headless from the official installer.
- MetaEditor compiles `DaveEA.mq5` with 0 errors, 0 warnings.
- MT5 starts from the generated config (`successfully initialized from start config`), reads the
  EA preset (`4 inputs read from expert 'Dave\DaveEA'`), and loads the EA on the chart.
- The EA's reports reach the bot through the file bridge at the configured interval, and changing
  the chart / interval from settings restarts MT5 with the new values.

Not verifiable in the build sandbox: a login to a real broker account (no account available
there). The status reports the terminal's own journal line either way.
