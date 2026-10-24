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
# FalconBeat: no R2 in our deployment — neuter upstream's S3 backup hooks
# (startup restore + 60s backup loop + SIGTERM final backup), all gated on
# `if (!IS_DEMO_MODE)` in index.ts. Kills the per-minute "State backup
# failed" stack spam and the slow backup-waiting shutdown. Submodule stays
# pristine; the patch exists only in this image build.
RUN sed -i 's/if (!IS_DEMO_MODE) {/if (false) {/' apps/server/src/index.ts
# FalconBeat: accept Authorization: Bearer as an alternative to ?creator=
# on the WS upgrade — a query-string token ends up in every proxy's access
# log. The FPP plugin sends the header; ?creator= stays for bridge/dev use.
RUN sed -i 's|const creatorSecret = url.searchParams.get("creator");|const creatorSecret = url.searchParams.get("creator") \|\| (req.headers.get("authorization") \|\| "").replace(/^Bearer +/i, "");|' apps/server/src/routes/websocket.ts
COPY beatsync/apps/server/tsconfig.json ./apps/server/tsconfig.json
COPY beatsync/packages/shared ./packages/shared
# FalconBeat: the plugin registers path-only publicUrl (/media/<name>) so
# listeners resolve it against whichever origin they arrived on — upstream
# insists on an absolute URL. The route is Bearer-gated at the edge anyway.
RUN sed -i '/UploadCompleteSchema = z.object/,/^});/s/\.url()//' packages/shared/types/HTTPRequest.ts
# FalconBeat: optional executeAtServerTime on PLAY/PAUSE — the plugin
# pre-schedules the next track during the current one so devices start on
# a predicted instant instead of always now+dynamicDelay. The schemas would
# otherwise strip the unknown field; the SCHEDULED_ACTION echo returns the
# honored timestamp so clients can detect support. syncClient's floor keeps
# a late joiner from being scheduled ahead of a future-dated play.
RUN sed -i '/PlayActionSchema = z.object/,/^});/s/trackTimeSeconds: z.number(),/trackTimeSeconds: z.number(),\n  executeAtServerTime: z.number().optional(),/' packages/shared/types/WSRequest.ts \
 && sed -i '/PauseActionSchema = z.object/,/^});/s/trackTimeSeconds: z.number(),/trackTimeSeconds: z.number(),\n  executeAtServerTime: z.number().optional(),/' packages/shared/types/WSRequest.ts \
 && sed -i 's/const serverTimeToExecute = this.getScheduledExecutionTime();/const serverTimeToExecute = playAction.executeAtServerTime ?? this.getScheduledExecutionTime();/' apps/server/src/managers/RoomManager.ts \
 && sed -i '/const serverTimeToExecute = this.getScheduledExecutionTime({/,/^    });/c\    const serverTimeToExecute = Math.max(\n      this.playbackState.serverTimeToExecute,\n      this.getScheduledExecutionTime({\n        extraOffsetMs: 1500, \/\/ Another extra 1.5 seconds to sync\n      })\n    );' apps/server/src/managers/RoomManager.ts \
 && sed -i 's/const serverTimeToExecute = room.getScheduledExecutionTime();/const serverTimeToExecute = message.executeAtServerTime ?? room.getScheduledExecutionTime();/' apps/server/src/websocket/handlers/pause.ts
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
