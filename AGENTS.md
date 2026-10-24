# FalconBeat

Synced light-show audio: visitors' devices play show audio in tight sync, triggered by
Falcon Player (FPP). Built on a self-hosted, **unmodified** BeatSync server
(`beatsync/` submodule) + custom Vite listener page (`web/`) + admin control client
(`bridge/` — protocol reference; the real plugin lives at
github.com/GraphicHealer/fpp-plugin-FalconBeat). Plugin settings collapse to a
single FalconBeat URL (the published edge port) + a single token
(→`FALCONBEAT_TOKEN`) + timing knobs; room is hardcoded `000000` and media
URLs are registered relative (`/media/<name>` — the listener resolves them
same-origin, so there's no public-hostname setting).

## Architecture

- `beatsync/` — upstream clone pinned by commit SHA (no tags exist upstream).
  Runs in **normal (non-demo) mode**, no S3 needed: `/upload/complete` only
  stores a URL on the room + broadcasts SET_AUDIO_SOURCES — it never touches
  S3. The presign endpoint is the only S3-coupled part and we don't call it.
  Admin auth: `Authorization: Bearer $CREATOR_SECRET` on the WS upgrade
  (`?creator=$CREATOR_SECRET` on the URL also works — kept for bridge/dev).
  Demo mode (`DEMO=1`, startup-scanned local audio dir) remains a fallback for
  a fully static playlist — it cannot accept runtime uploads.
  Update flow: bump submodule SHA, re-copy `packages/shared` into
  `web/src/vendor/beatsync-shared/`, fix type breaks.
- `ingest/` — zero-dep Node service. `PUT /media/<name>` (Bearer
  $FALCONBEAT_TOKEN) writes to `media/`; `DELETE /media/<name>` (Bearer)
  removes it — the plugin evicts played tracks off disk when it drops them
  from the room. Idempotent (missing file → 200). `PUT
  /config/<show|nowplaying>` (Bearer) writes `<name>.json`; GETs serve
  files (dev convenience). Writes are proxied through the Caddy edge —
  ingest's own Bearer check is the auth, so public exposure is fine.
  Every media PUT also extracts embedded metadata into sidecars next to the
  audio: `<name>.art.jpg|png` (ID3v2 APIC/PIC, FLAC PICTURE) and
  `<name>.tags.json` (`{title?,artist?,album?}` — ID3v2 TIT2/TPE1/TALB, v2.2
  TT2/TP1/TAL, FLAC Vorbis comments). Sidecars are GET-able unauthenticated
  (Caddy serves them like audio), a re-PUT with no embedded data clears
  them, and DELETE removes them with the file. The listener treats
  tags.json as authoritative over the plugin's nowplaying fields.
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
  **Only Caddy's :80 is published** — one port carries everything:
  cloudflared → Caddy → `web/dist` + `GET /media/*` + `/ws`,`/health` →
  beatsync. Plugin traffic comes through the same port: `/upload/complete`
  + `/discover` are Bearer-gated by Caddy (`Authorization: Bearer
  $FALCONBEAT_TOKEN` — the endpoints have no auth of their own), ingest
  writes (`PUT/DELETE /media/*`, `PUT /config/*`, `OPTIONS`) proxy to
  ingest which enforces the Bearer itself.
  `{$BEATSYNC_UPSTREAM}`/`{$INGEST_UPSTREAM}` also work split across
  containers.
  One shared secret: `FALCONBEAT_TOKEN` in .env feeds ingest Bearer,
  BeatSync admin auth (Bearer on the WS upgrade, or `?creator=`), and the
  Caddy admin-route gate. Legacy `INGEST_TOKEN`/`CREATOR_SECRET` still work
  as per-gate overrides.

## Audio push flow (no S3)

1. Plugin `PUT http://falconbeat-host:<edge>/media/song.mp3` (Bearer) →
   file lands in `media/`
2. Plugin `POST http://falconbeat-host:<edge>/upload/complete` (Bearer —
   gated in Caddy since the upstream endpoint is unauthenticated)
   `{roomId, originalName, publicUrl: "/media/song.mp3"}` →
   room gets the source, devices preload it
3. Plugin WS `ws://falconbeat-host:<edge>/ws?roomId&username&clientId` with
   `Authorization: Bearer <token>` on the upgrade:
   `{type:"PLAY", audioSource: publicUrl, trackTimeSeconds: pos}`

Devices fetch `/media/song.mp3` from their own origin — relative URLs mean
the same room registration works for LAN and tunneled listeners alike.
BeatSync only ever stores the URL.

## Show metadata & plugin contract

- `media/show.json` — operator config rendered by the listener page
  (showName/tagline/hostedBy/description/schedule/location/links/publicUrl).
  Pushed by the FPP plugin via `PUT /config/show` — FPP plugin settings are
  the single source of truth (there is no web settings page); the daemon
  re-renders and re-pushes on every settings change, defaulting name/tagline
  to FPP's HostName/HostDescription.
- `media/<file>.art.jpg|png` — cover-art sidecars. Ingest extracts embedded
  art on PUT (ID3v2 APIC/PIC, FLAC PICTURE) and deletes them on DELETE.
  The listener page derives candidates from nowplaying.filename /
  trackUrl — must decodeURIComponent + apply the same sanitize as
  safeName (`[^\w.() \-']` → `_`).
- `media/nowplaying.json` — plugin pushes `PUT /config/nowplaying` per media
  event: `{playing, title, artist, album, filename, updatedAtMs}`, and
  `{playing:false}` on playlist stop. Page polls every ~3s; `updatedAtMs`
  stale >90s = off air. Off air persisting >15s makes the page call
  `syncEngine.leave()` — full WS+playback disconnect, back to the Listen
  button. A missing file (plugin too old to push it) = unknown, never
  auto-disconnects.
- Listener count = non-admin clients in `CLIENT_CHANGE` (plugin's creator
  socket is isAdmin, so it doesn't count).
- Caddy serves `/media/*.json` with `no-cache`; audio keeps `immutable`.

S3 backups are disabled in the image: the Dockerfile seds upstream index.ts's
two `if (!IS_DEMO_MODE)` blocks (startup restore + 60s backup loop + SIGTERM
final backup) to `if (false)` before bundling — no R2 in our deployment, room
state is in-memory anyway. If upstream's index.ts changes shape around those
blocks, re-check the sed still lands (grep `!IS_DEMO_MODE` in index.ts after
a submodule bump). Residual S3 noise: one caught `Room cleanup failed` line
per 60s-idle room deletion — room is still removed from memory regardless.

A second build-time patch in the same stage relaxes `UploadCompleteSchema`'s
`publicUrl` from `z.string().url()` to `z.string()` in
`packages/shared/types/HTTPRequest.ts` — the plugin registers path-only
`/media/<name>` URLs that listeners resolve same-origin, which upstream's
absolute-URL validation would 400. Re-check after submodule bumps (grep
`publicUrl: z.string().url()` in that file — UploadUrlResponseSchema keeps
the strict check, only the request schema is relaxed).

A third patch accepts `Authorization: Bearer` as an alternative to
`?creator=` on the WS upgrade (`apps/server/src/routes/websocket.ts`) —
the plugin sends the header so the token never lands in a proxy access
log; `?creator=` still works (bridge/dev tooling).

A fourth adds optional `executeAtServerTime` to `PlayActionSchema` +
`PauseActionSchema` (`packages/shared/types/WSRequest.ts`) and honors it
over the computed schedule delay in `broadcastPlay`/`handlePause`
(`apps/server/src/managers/RoomManager.ts`,
`apps/server/src/websocket/handlers/pause.ts`) — the plugin pins absolute
start instants so every song gets the same deterministic bias. The
late-joiner `syncClient` path is floored at
`Math.max(playbackState.serverTimeToExecute, getScheduledExecutionTime({+1500ms}))`
so a joiner mid-pending-schedule can't be told to resume at a negative
position. Old images ignore the field silently (zod strips it) — the
plugin detects that via the echo and falls back. Re-check all seds land
after a submodule bump.

Room→source bindings are in-memory only: a server/container restart forgets
registered tracks even though the files persist in media/. The plugin must
re-run push (or at least upload/complete) after any restart — cheap since
the files are already on disk.

/upload/complete + /discover are proxied through Caddy but Bearer-gated
($FALCONBEAT_TOKEN checked in the Caddyfile) — the upstream endpoints have
no auth of their own, so the gate is what keeps the single-port model safe.
The plugin sends `Authorization: Bearer <token>` on both and hits the same
published port for admin WS and HTTP; only browsers + plugin go through
Caddy. BeatSync :8080 and ingest :8090 are never published.

## Hard-won protocol facts (verified against server source @ 94c38ab)

- No HTTP play endpoint — playback control is WS-only. Rooms auto-create on
  first join; presigned-upload requires the room to already exist.
- Non-demo admin: `?creator=` secret (or first-joiner) — our image also
  accepts `Authorization: Bearer` on the upgrade. `?admin=` is demo-only.
- Demo mode scans `DEMO_AUDIO_DIR` **once at startup** — runtime pushes are
  impossible (404 + PLAY rejected). Use normal mode for plugin-driven audio.
- Non-demo PLAY goes through load-coordination (LOAD_AUDIO_SOURCE → client
  ACKs → play when all loaded or 3s timeout). Devices preloaded on
  SET_AUDIO_SOURCES ACK fast. The SCHEDULED_ACTION echo remains the only
  acceptance signal — the plugin's callbacks are fire-and-forget and PLAY
  carries FPP position + expected delay, so a device that joins mid-track
  lands at the right offset instead of holding the show.
- `/discover` only reports rooms with ≥1 connected client that are playing.
- `PLAY`/`PAUSE` broadcast `SCHEDULED_ACTION` with `serverTimeToExecute` =
  `epochNow + max(400ms, 1.5*maxRTT+200, maxCompensation+200)`, capped 3s.
  `epochNow() = performance.timeOrigin + performance.now()` (ms since epoch).
  With the Dockerfile patch a client can pin the instant via
  `executeAtServerTime` on the request — the echo returns the honored stamp,
  which doubles as the capability probe (old builds strip the field and the
  echo shows the server-chosen delay instead).
- `trackTimeSeconds` in PLAY is the **playback offset** — send FPP position +
  expected delay to make devices seek into the track aligned to the sequence clock.
- Late joiners: client sends `SYNC` after its audio-ready gesture → server unicasts
  a scheduled PLAY at the computed resume position (+1.5s extra lead), floored
  at any pending playback state's execute time so a future-dated schedule can't
  produce a negative resume position.
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
