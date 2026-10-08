# FalconBeat

Synced light-show audio: visitors' phones play show audio in tight sync, triggered by
Falcon Player (FPP). Built on a self-hosted, **unmodified** BeatSync server
(`beatsync/` submodule) + custom Vite listener page (`web/`) + admin control client
(`bridge/` — protocol reference for the future FPP plugin).

## Architecture

- `beatsync/` — upstream clone pinned by commit SHA (no tags exist upstream).
  Runs in **normal (non-demo) mode** so the FPP plugin can push audio at runtime:
  `POST /upload/get-presigned-url` → PUT to S3 → `POST /upload/complete`
  (adds source to room + broadcasts SET_AUDIO_SOURCES; phones preload).
  S3-compatible store required — Cloudflare R2 recommended (free tier, no
  egress fees). Admin auth: `?creator=$CREATOR_SECRET` on the WS URL.
  Demo mode (`DEMO=1`, local audio dir, no S3) remains a fallback for a fully
  static playlist — it cannot accept runtime uploads (startup-only scan).
  Update flow: bump submodule SHA, re-copy `packages/shared` into
  `web/src/vendor/beatsync-shared/`, fix type breaks.
- `web/` — Vite + React + TS listener SPA. Same-origin deployment: resolves
  `ws(s)://{host}/ws` and source URLs against the page origin (absolute S3
  URLs pass through untouched).
- `bridge/` — Node admin WS client (upload/play/pause/status/watch).
  The FPP plugin replicates this protocol (Python WS+HTTP client) and should
  keep its admin WS connected persistently: a room idle >60s is deleted AND
  its uploaded audio purged from S3.
- `deploy/` — Caddyfile + cloudflared config. Public ingress:
  cloudflared → Caddy (:80) → static `web/dist` + proxy `/ws`, `/audio/*` →
  beatsync:8080. Admin WS stays LAN-only (secret never crosses Cloudflare).

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
DEMO=1 DEMO_AUDIO_DIR=../audio DEMO_ADMIN_SECRET=... bun server

# Bridge (zero-dep, Node ≥22.18 runs .ts directly)
cd bridge && cp .env.example .env   # set ADMIN_SECRET
node --env-file=.env src/cli.ts play "Song.mp3" --pos 0
node --env-file=.env src/cli.ts status|watch|pause
```
