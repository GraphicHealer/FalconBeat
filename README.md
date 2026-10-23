# FalconBeat

Self-hosted synchronized audio for [Falcon Player](https://github.com/FalconChristmas/fpp)
(FPP) light shows. Visitors open a webpage on their devices and hear the show
audio in sync with the lights — from anywhere on the internet, not just the
show Wi-Fi.

Everything runs on hardware you own: one Docker container on your LAN serves
the listener page, hosts the audio, and keeps every device's playback locked to
the same clock. The only outside piece is whatever HTTPS ingress you choose
(a Cloudflare Tunnel, a reverse proxy, a VPS — anything).

Device-side sync is powered by [BeatSync](https://github.com/freeman-jiang/beatsync)
(MIT © freeman-jiang), vendored as an unmodified submodule. The FPP side is
driven by the companion plugin
**[fpp-plugin-FalconBeat](https://github.com/GraphicHealer/fpp-plugin-FalconBeat)**.

<p align="center">
  <img src="screenshot.png" alt="FalconBeat listener page — fullscreen now-playing view" width="320" />
</p>

## Requirements

- A Docker host on the **same LAN as the FPP controller** — any Linux box,
  Pi, or NAS (amd64 or arm64)
- FPP with **[fpp-plugin-FalconBeat](https://github.com/GraphicHealer/fpp-plugin-FalconBeat)**
  installed (FPP → Content Setup → Plugin Manager → paste the repo URL)
- Public HTTPS ingress to the container's edge port. A
  [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
  is the easy path — free, no port-forwarding — but anything that gives the
  page a public HTTPS URL works (devices require HTTPS for WebAudio).

## Quick start

```bash
cd deploy
cp .env.example .env          # set CREATOR_SECRET + INGEST_TOKEN
docker compose up -d          # pulls the CI-built image from GHCR
```

Generate two **different** secrets:

```bash
openssl rand -hex 32    # → CREATOR_SECRET  (BeatSync admin WebSocket auth)
openssl rand -hex 32    # → INGEST_TOKEN    (audio push Bearer token)
```

On Windows/PowerShell: `[guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')`.

To build locally instead of pulling: `docker compose up -d --build`.

The published image is `ghcr.io/graphichealer/falconbeat` (amd64 + arm64),
built by `.github/workflows/docker.yml` on every GitHub **release** — tags like
`0.4.4`, `0.4`, `latest`. Verify it's up:

```bash
curl http://localhost:8000/health    # {"status":"ok"} through the edge
docker compose logs -f               # interleaved logs from all three processes
```

One container runs everything: BeatSync (Bun), the ingest service (LAN-only
audio receiver), and Caddy (public edge serving the listener page + audio).

### Ports

| Port | Exposure | Purpose |
|---|---|---|
| `8000 → 80` | public (tunnel target) | Listener page, `/media/*` audio, `/ws` WebSocket proxy |
| `8080` | **LAN only** | BeatSync admin WS + `POST /upload/complete` (unauthenticated — do NOT expose) |
| `8090` | **LAN only** | Ingest PUTs (`Bearer` token), operator `/settings` page |

## Public ingress (cloudflared)

Create a tunnel (Cloudflare Zero Trust → Networks → Tunnels) and point a
hostname at the edge port:

```yaml
# cloudflared config.yml — see deploy/cloudflared.config.example.yml
tunnel: <tunnel-id>
credentials-file: /path/to/credentials.json
ingress:
  - hostname: falconbeat.example.com
    service: http://localhost:8000
  - service: http_status:404
```

Or run cloudflared as a sidecar container — a commented-out service is in
`deploy/docker-compose.yml` (set `CLOUDFLARED_TOKEN` in `.env`).

## Plugin settings (FPP → Content Setup → FalconBeat)

| Plugin field | Value |
|---|---|
| FalconBeat WS URL | `ws://<docker-host>:8080` — LAN address; devices never use this |
| Room ID | `000000` default; arbitrary in non-demo mode. The page reads `?room=<id>` — share `https://<host>/?room=<id>` if you change it |
| Creator Secret | `CREATOR_SECRET` from `deploy/.env` |
| Admin Secret | optional demo-mode secret — usually blank |
| Ingest URL | `http://<docker-host>:8090` |
| Ingest Token | `INGEST_TOKEN` from `deploy/.env` |
| Public Media URL | `https://falconbeat.example.com/media` — **must end in `/media`** |
| Extra Delay (ms) | `0` = auto; manual nudge added to the computed schedule delay |
| Sync Gate (sec) | Hold each track's start until devices confirm loaded — `10` default, `0` = off. This is what makes FPP and the devices start on the same tick |
| FPP Start Lag (ms) | `250` default — how long FPP takes to actually start media after the gate releases; tune by ear |
| Preload Settle (ms) | `2500` default — when a track is pushed at play time, wait this long before PLAY so devices can download over WAN. Counts against the gate; `0` = off |
| Disconnect grace (s) | how long the admin socket is held after playlist stop |

## The listener page

A fullscreen now-playing view: album art (extracted from each audio file's
embedded tags — no external APIs), title/artist/album, live progress, a big
play button, share button, "Up next" label, listener count, and an
About-the-show bottom sheet you fill in from the settings page. The page
publishes Media Session metadata, so Android/iOS show the track in the
notification shade and lockscreen with working pause buttons.

When the show goes off air for ~15s, joined listeners disconnect back to the
play button and can tap in again when the show resumes.

**Operator settings** live on the LAN only: `http://<docker-host>:8090/settings`
— show name, tagline, hosted-by, schedule, location, description, links. Saved
to `media/show.json` (the public edge 404s `/settings` by design).

## Media lifecycle

1. Plugin `PUT`s each track to ingest → file lands in `media/`
2. Ingest extracts embedded metadata into sidecars: `<file>.art.jpg|png`
   (album art) and `<file>.tags.json` (title/artist/album — the page prefers
   these over FPP-reported tags)
3. Plugin registers the public URL with BeatSync (`/upload/complete`) and
   issues gated PLAY/PAUSE over the admin socket — devices preload, the server
   waits for load ACKs, then everything fires on one scheduled timestamp
4. When a track finishes, the plugin evicts it from the room queue and deletes
   it (plus its sidecars) off `media/` — the volume doesn't fill up

`media/nowplaying.json` is pushed per track/stop event
(`{playing, title, artist, album, filename, next, updatedAtMs}`); the page
polls it for track info, up-next, and off-air state (`updatedAtMs` stale
>90s counts as off air).

## Repo layout

```
beatsync/   upstream BeatSync server, pinned submodule @ 94c38ab (unmodified)
web/        Vite + React listener page (vendored @beatsync/shared)
ingest/     zero-dep file receiver → media/ (runs on Bun in the container)
bridge/     Node CLI admin client — protocol reference + manual test tool
media/      audio store (volume-mounted; show audio is git-ignored)
deploy/     Dockerfile, entrypoint.sh, Caddyfile, docker-compose.yml, env examples
unraid/     Unraid CA template + notes
```

## Development

```bash
# listener page
cd web && npm install && npm run dev

# server (non-demo, no S3 needed)
cd beatsync && bun install && cd apps/server && CREATOR_SECRET=... bun src/index.ts

# ingest
cd ingest && MEDIA_DIR=../media INGEST_TOKEN=... node server.ts   # or bun server.ts

# bridge (manual push/play against a running server)
cd bridge && cp .env.example .env
node --env-file=.env src/cli.ts push "Song.mp3" && node src/cli.ts play "<publicUrl>"
```

See `AGENTS.md` for the protocol details, timing math, and operational quirks.

## Caveats

- Room→track registrations are in-memory — after a container restart the
  plugin re-registers on its next media event; files in `media/` persist.
- `/upload/complete` and ingest are unauthenticated-by-design LAN surfaces;
  keep them off the public ingress (the Caddyfile doesn't proxy them).
- BeatSync's S3 backup/restore is disabled in the image (no R2 in this
  deployment); room state is in-memory by design.

## License & attribution

Device-side synchronization uses [BeatSync](https://github.com/freeman-jiang/beatsync)
by freeman-jiang, vendored unmodified under the MIT License — see
`beatsync/LICENSE`.
