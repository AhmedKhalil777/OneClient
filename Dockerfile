# oneClient web — the workbench in your browser, served by a plain Node server (no Electron).
#
#   docker build -t oneclient .
#   docker run -p 127.0.0.1:4180:4180 -v oneclient-data:/data oneclient
#   → open the link it prints (http://127.0.0.1:4180/?token=…)
#
# Data (connections, encrypted secrets, the access token) lives in /data — keep it in a volume.

# ---- build: install and build only the web packages (Electron is never downloaded) ----
FROM node:22-bookworm-slim AS build
# node-pty (the terminal) has no Linux prebuild: it compiles during install.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /src
COPY . .
RUN pnpm run web:install --frozen-lockfile && pnpm run web:build

# ---- run ----
FROM node:22-bookworm-slim
# git: Source Control; bash: the terminal; tini: proper signal handling (Ctrl+C / docker stop).
RUN apt-get update && apt-get install -y --no-install-recommends git bash tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src /app
ENV ONECLIENT_HOME=/data NODE_ENV=production
RUN mkdir -p /data /workspace && chown -R node:node /data /workspace
USER node
VOLUME ["/data"]
EXPOSE 4180
# Inside the container the server must listen on all interfaces; publish the port on 127.0.0.1 (see above)
# or behind an HTTPS reverse proxy — the token in the printed link is the only lock.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "packages/server/dist/main.js", "--host", "0.0.0.0", "--port", "4180"]
