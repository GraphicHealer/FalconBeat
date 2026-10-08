# FalconBeat

Synced light-show audio: visitors' phones play show audio in tight sync, triggered by
Falcon Player (FPP). Built on a self-hosted, **unmodified** BeatSync server
(`beatsync/` submodule) + custom Vite listener page (`web/`) + admin control client
(`bridge/` — protocol reference for the future FPP plugin).

## Architecture

- `beatsync/` — upstream clone pinned by commit SHA (no tags exist upstream).
  Runs in **normal (non-demo) mode**, no S3 needed: `/upload/complete` only
  stores a URL on the room + broadcasts SET_AUDIO_SOURCES — it never touches
  S3. The presign endpoint is the only S3-coupled part and we don't call it.
  Admin auth: `?creator=$CREATOR_SECRET` on the WS URL.
  Demo mode (`DEMO=1`, startup-scanned local audio dir) remains a fallback for
  a fully static playlist — it cannot accept runtime uploads.
  Update flow: bump submodule SHA, re-copy `packages/shared` into
  `web/src/vendor/beatsync-shared/`, fix type breaks.
- `ingest/` — zero-dep Node service, **LAN-only** (never routed through
  cloudflared). `PUT /media/<name>` (Bearer $INGEST_TOKEN) writes to `media/`;
  GETs serve files directly (dev convenience). Filename sanitized to basename
  + safe charset; audio extensions only.
- `media/` — audio store on the host; Caddy serves it publicly at `/media/*`.
- `web/` — Vite + React + TS listener SPA. Same-origin deployment: resolves
  `ws(s)://{host}/ws` and source URLs against the page origin (absolute
  /media/... URLs pass through untouched).
- `bridge/` — Node admin WS client (push/upload/play/pause/status/watch).
  The FPP plugin replicates this protocol (Python WS+HTTP client) and should
  keep its admin WS connected persistently: a room idle >60s is deleted.
- `deploy/` — all-in-one Dockerfile + entrypoint supervisor + Caddyfile +
  compose + cloudflared config. Single container runs three processes:
  beatsync (Bun, :8080), ingest (Bun, :8090), Caddy (:80) — entrypoint.sh
  kills the container if any child dies so the restart policy heals it.
  Public ingress: cloudflared → Caddy → `web/dist` + `/media/*` from
  `media/` + proxy `/ws`,`/health` → beatsync on localhost. Admin WS +
  ingest stay LAN-only (secrets never cross Cloudflare). Caddyfile's
  `{$BEATSYNC_UPSTREAM:localhost:8080}` also works split across containers.
  Alternative shape (if ever needed): three separate services — beatsync
  from `beatsync/Dockerfile`, ingest on node:24-alpine, Caddy with
  `BEATSYNC_UPSTREAM=beatsync:8080`.

## Audio push flow (no S3)

1. Plugin `PUT http://falconbeat-host:8090/media/song.mp3` (Bearer token) →
   file lands in `media/`
2. Plugin `POST http://beatsync:8080/upload/complete`
   `{roomId, originalName, publicUrl: "https://<host>/media/song.mp3"}` →
   room gets the source, phones preload it
3. Plugin WS: `{type:"PLAY", audioSource: publicUrl, trackTimeSeconds: pos}`

Phones fetch `https://<host>/media/song.mp3` straight from Caddy — BeatSync
only ever stores the URL.

Known noise without S3_* configured: BackupManager logs a failed backup every
60s and on SIGTERM (which also makes shutdown fall through to Docker's SIGKILL
timeout). Harmless — room state is in-memory anyway; nothing lives in S3.
A room idle >60s is still deleted from memory (the S3 delete inside cleanup
fails but the room is removed regardless).

Room→source bindings are in-memory only: a server/container restart forgets
registered tracks even though the files persist in media/. The plugin must
re-run push (or at least upload/complete) after any restart — cheap since
the files are already on disk.

/upload/complete is intentionally NOT proxied by Caddy — it's unauthenticated,
so it must stay LAN-only. The plugin talks to beatsync:8080 directly for both
admin WS and HTTP; only browsers go through Caddy (ws://host/ws).

## Hard-won protocol facts (verified against server source @ 94c38ab)

- No HTTP play endpoint — playback control is WS-only. Rooms auto-create on
  first join; presigned-upload requires the room to already exist.
- Non-demo admin: `?creator=` secret (or first-joiner). `?admin=` is demo-only.
- Demo mode scans `DEMO_AUDIO_DIR` **once at startup** — runtime pushes are
  impossible (404 + PLAY rejected). Use normal mode for plugin-driven audio.
- Non-demo PLAY goes through load-coordination (LOAD_AUDIO_SOURCE → client
  ACKs → play when all loaded or 3s timeout). Phones preloaded on
  SET_AUDIO_SOURCES ACK fast; gate FPP start on the SCHEDULED_ACTION echo.
- `/discover` only reports rooms with ≥1 connected client that are playing.
- `PLAY`/`PAUSE` broadcast `SCHEDULED_ACTION` with `serverTimeToExecute` =
  `epochNow + max(400ms, 1.5*maxRTT+200, maxCompensation+200)`, capped 3s.
  `epochNow() = performance.timeOrigin + performance.now()` (ms since epoch).
- `trackTimeSeconds` in PLAY is the **playback offset** — send FPP position +
  expected delay to make phones seek into the track aligned to the sequence clock.
- Late joiners: client sends `SYNC` after its audio-ready gesture → server unicasts
  a scheduled PLAY at the computed resume position (+1.5s extra lead).
- NTP: coded probe **pairs** (25ms apart, groupId shared), every 2.5s steady-state
  (50ms for first 16 measurements). Keep min-RTT measurement's offset.
- Server sends `LIVENESS_PING` after 15s silence → reply `LIVENESS_PONG`.
  Dead at 60s. Any inbound message resets the clock.
- WS connect: `/ws?roomId=000000&username=X&clientId=Y[&admin=SECRET]`.
- Client fetches relative `/audio/...` against the API/page origin — so the web
  server can serve audio straight from disk instead of via Bun.

## Commands

```bash
# Web
cd web && npm install && npm run dev        # dev server (needs VITE_* env for non-same-origin)
npm run build && npm run typecheck

# BeatSync server (needs Bun; deploy runs Docker/oven/bun:1)
cd beatsync && bun install
cd apps/server && CREATOR_SECRET=... bun src/index.ts   # non-demo, no S3 needed

# Ingest (zero-dep Node ≥22.18)
cd ingest && MEDIA_DIR=../media INGEST_TOKEN=... node server.ts   # :8090

# Bridge (zero-dep, Node ≥22.18 runs .ts directly)
cd bridge && cp .env.example .env   # set CREATOR_SECRET + INGEST_TOKEN
node --env-file=.env src/cli.ts push "Song.mp3"          # → ingest + register
node --env-file=.env src/cli.ts play "<publicUrl>" --pos 0
node --env-file=.env src/cli.ts status|watch|pause
```
