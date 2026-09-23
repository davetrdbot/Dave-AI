# Dave's MT5 container -- the lean build (the default).
#
# MetaTrader 5 under Wine on a virtual screen (Xvfb), with the Dave EA and the agent Dave talks to.
# No desktop: it fits Railway's trial/free limits (1 GB RAM, 0.5 GB volume). MetaTrader is installed
# INTO THE IMAGE at build time, so the volume only has to hold the login settings (a few KB).
# Want to watch MT5 in a browser? Use Dockerfile.desktop instead (needs more memory).
#
# Build context: the repo root. On Railway: RAILWAY_DOCKERFILE_PATH=mt5/Dockerfile.
FROM debian:bookworm-slim

ENV WINEPREFIX=/opt/wine \
    WINEDEBUG=-all \
    WINEARCH=win64 \
    DISPLAY=:99 \
    AGENT_PORT=8081 \
    DAVE_STATE_DIR=/data/dave \
    DAVE_EA_SOURCE=/opt/dave/DaveEA.mq5

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl wget gnupg2 python3 procps xvfb xauth \
    && mkdir -pm755 /etc/apt/keyrings \
    && wget -qO /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key \
    && wget -qNP /etc/apt/sources.list.d/ https://dl.winehq.org/wine-builds/debian/dists/bookworm/winehq-bookworm.sources \
    && dpkg --add-architecture i386 \
    && apt-get update \
    && apt-get install -y --no-install-recommends winehq-stable \
    && apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

COPY mt5/agent.py mt5/start.sh mt5/install-mt5.sh /opt/dave/
COPY ea/DaveEA.mq5 /opt/dave/DaveEA.mq5
RUN chmod +x /opt/dave/*.sh && /opt/dave/install-mt5.sh

EXPOSE 8081
CMD ["/opt/dave/start.sh"]
