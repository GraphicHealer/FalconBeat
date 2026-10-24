# FalconBeat all-in-one image: BeatSync (Bun) + ingest (Bun) + Caddy.
# Build context is the repo root:  docker build -f deploy/Dockerfile -t falconbeat .
#
# One container, three processes supervised by entrypoint.sh. Inside the box
# everything talks on localhost: Caddy :80 → /ws+API to beatsync :8080,
# /media/* served straight from the /media volume, SPA from /srv/falconbeat.

# ── Stage 1: beatsync server deps (workspace install, server only) ────
FROM oven/bun:1 AS beatsync-deps
WORKDIR /bs
COPY beatsync/package.json beatsync/bun.lock ./
COPY beatsync/apps/server/package.json ./apps/server/package.json
COPY beatsync/packages/shared/package.json ./packages/shared/package.json
# --ignore-scripts: root prepare runs lefthook, absent under --production
RUN bun install --production --ignore-scripts

# ── Stage 2: build beatsync → self-contained dist bundle ─────────────
FROM oven/bun:1 AS beatsync-build
WORKDIR /bs
COPY --from=beatsync-deps /bs /bs
COPY beatsync/apps/server/src ./apps/server/src
COPY beatsync/apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY beatsync/packages/shared ./packages/shared
# FalconBeat: upstream deltas live in deploy/beatsync.patch — applied here,
# kept out of the submodule. It neuters the S3 backup hooks (no R2 in this
# deployment), accepts Authorization: Bearer on the WS upgrade (the plugin's
# token never lands in a proxy log), relaxes upload/complete's publicUrl to
# path-only /media/<name>, and adds executeAtServerTime to PLAY/PAUSE +
# syncClient so the plugin can pin absolute start instants for pre-scheduled
# track transitions. `git apply` fails the build loudly if a submodule bump
# drifts the context — regenerate with `git -C beatsync diff > deploy/beatsync.patch`.
COPY deploy/beatsync.patch /tmp/beatsync.patch
RUN apt-get update && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/* \
 && git apply -v /tmp/beatsync.patch
WORKDIR /bs/apps/server
RUN bun run build

# ── Stage 3: Vite SPA build ──────────────────────────────────────────
FROM node:24-alpine AS web-build
# Release tag baked into the page (shown in the Show Info footer); "dev"
# for local builds where no version is passed.
ARG APP_VERSION=dev
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN VITE_APP_VERSION=$APP_VERSION npm run build

# ── Stage 4: runtime — bun runs beatsync + ingest; caddy is a static binary ──
FROM oven/bun:1-slim
COPY --from=caddy:2-alpine /usr/bin/caddy /usr/bin/caddy

COPY --from=beatsync-build /bs/apps/server/dist /app/beatsync/dist
# Upstream attribution — BeatSync is MIT © freeman-jiang; the license ships
# with the bundled copy.
COPY beatsync/LICENSE /app/beatsync/LICENSE-UPSTREAM
COPY --from=web-build /web/dist /srv/falconbeat
COPY ingest/server.ts /app/ingest/server.ts
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /media

# 80 = public web (cloudflared target); 8080 = LAN admin WS/API; 8090 = LAN ingest
EXPOSE 80 8080 8090
ENV NODE_ENV=production \
    MEDIA_DIR=/media \
    PORT=8090 \
    WEB_DIST=/srv/falconbeat

# Container health = the edge responds (Caddy → beatsync). Bun is the only
# HTTP client guaranteed in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD bun -e 'fetch("http://localhost/health").then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'

ENTRYPOINT ["/entrypoint.sh"]
