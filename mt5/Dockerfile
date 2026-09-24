# Dave's MT5 container -- the lean build (the default).
#
# MetaTrader 5 under Wine on a virtual screen (Xvfb), with the Dave EA and the agent Dave talks to.
# No desktop: it fits Railway's trial/free limits (1 GB RAM, 0.5 GB volume). MetaTrader is installed
# INTO THE IMAGE at build time, so the volume only has to hold the login settings (a few KB).
# Want to watch MT5 in a browser? Use Dockerfile.desktop instead (needs more memory).
#
# Build context: the repo root. On Railway: RAILWAY_DOCKERFILE_PATH=mt5/Dockerfile.
# The base and Wine are the exact combination MetaTrader was run and verified on: Ubuntu 24.04's own
# 64-bit Wine 9 (installer, EA compile, start-up config, EA loaded). WineHQ's Wine 11 failed to even
# start inside the image build ("could not load kernel32.dll"), so it is not used.
FROM ubuntu:24.04

ENV WINEPREFIX=/opt/wine \
    WINEDEBUG=-all \
    WINEARCH=win64 \
    WINE_BIN=/usr/lib/wine/wine64 \
    DISPLAY=:99 \
    AGENT_PORT=8081 \
    DAVE_STATE_DIR=/data/dave \
    DAVE_EA_SOURCE=/opt/dave/DaveEA.mq5 \
    DEBIAN_FRONTEND=noninteractive

# wine64 plus the libraries it only "recommends" but MetaTrader needs: TLS (gnutls) for the broker
# and the installer's downloads, and the X/GL bits for its window on the virtual screen.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl python3 procps xvfb xauth \
       wine64 libgnutls30t64 libgl1 libgl1-mesa-dri libvulkan1 libdbus-1-3 libcups2t64 libgssapi-krb5-2 libkrb5-3 \
       libxcomposite1 libxcursor1 libxfixes3 libxi6 libxinerama1 libxrandr2 libxrender1 libxxf86vm1 fonts-liberation \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

COPY mt5/agent.py mt5/start.sh mt5/install-mt5.sh /opt/dave/
COPY ea/DaveEA.mq5 /opt/dave/DaveEA.mq5
RUN chmod +x /opt/dave/*.sh && /opt/dave/install-mt5.sh

EXPOSE 8081
CMD ["/opt/dave/start.sh"]
