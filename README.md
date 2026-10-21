# FalconBeat

Synced light-show audio for [Falcon Player](https://github.com/FalconChristmas/fpp) (FPP):
visitors open a webpage on their phones and hear the show audio in sync with the lights,
from anywhere on the internet — not just the show Wi-Fi.

The phone side is powered by a self-hosted [BeatSync](https://github.com/freeman-jiang/beatsync)
server (pinned, unmodified submodule) plus a custom listener web app. The FPP side is driven by
the companion plugin: **[fpp-plugin-FalconBeat](https://github.com/GraphicHealer/fpp-plugin-FalconBeat)**.

## Requirements

- A Docker host (Linux box, or FPP's own Docker if your FPP image supports it) on the
  **same LAN as the FPP controller**
- FPP with **[fpp-plugin-FalconBeat](https://github.com/GraphicHealer/fpp-plugin-FalconBeat)**
  installed (FPP → Content Setup → Plugin Manager → paste the repo URL)
- A Cloudflare Tunnel (cloudflared) or equivalent to expose the listener page publicly —
  phones need HTTPS for WebAudio + WebSocket on iOS/Android

## Quick start

```bash
cd deploy
cp .env.example .env          # set CREATOR_SECRET + INGEST_TOKEN (long random strings)
docker compose up -d --build  # builds and runs the all-in-one container
```

One container runs everything: the BeatSync server (Bun), the media ingest service,
and Caddy serving the listener page + audio. Verify it came up:

```bash
curl http://localhost:8000/health    # {"status":"ok",...} through the edge
docker compose logs -f               # interleaved logs from all three processes
```

### Ports

| Port | Exposure | Purpose |
|---|---|---|
| `8000 → 80` | cloudflared target | Public edge: listener page, `/media/*` audio, `/ws` WebSocket proxy |
| `8080` | **LAN only** | BeatSync admin WS + `POST /upload/complete` (unauthenticated — do NOT expose) |
| `8090` | **LAN only** | Ingest: plugin PUTs audio files here (`Bearer` token) |

## Public ingress (cloudflared)

Create a tunnel (Cloudflare Zero Trust → Networks → Tunnels), get the token,
and point an ingress hostname at the edge port:

```yaml
# cloudflared config.yml (see deploy/cloudflared.config.example.yml)
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

Each field maps to a server-side setting:

| Plugin field | Value |
|---|---|
| BeatSync WS URL | `ws://<docker-host>:8080` |
| Room ID | `000000` (default; arbitrary in non-demo mode). The listener page reads the same value from `?room=` — share `https://<host>/?room=<id>` if you change it |
| Creator Secret | `CREATOR_SECRET` from `deploy/.env` |
| Ingest URL | `http://<docker-host>:8090` |
| Ingest Token | `INGEST_TOKEN` from `deploy/.env` |
| Public Media URL | `https://falconbeat.example.com/media` — must end in `/media` |
| Listener Page URL | `https://falconbeat.example.com` (displayed on the plugin status page) |
| Extra Delay (ms) | `0` = auto; manual nudge for light/audio alignment |

When a playlist starts, the plugin pushes the playlist's audio to ingest, registers each
track's public URL with BeatSync, then issues PLAY/PAUSE over the admin socket with the
FPP position offset — phones seek to where the track *will* be when the scheduled action
fires.

## Repo layout

```
beatsync/   upstream BeatSync server, pinned submodule @ 94c38ab (unmodified)
web/        Vite + React listener page (vendored @beatsync/shared)
ingest/     zero-dep file receiver → media/ (runs on Bun in the container)
bridge/     Node CLI admin client — protocol reference + manual test tool
media/      audio store (volume-mounted; copyrighted show audio is git-ignored)
deploy/     Dockerfile, entrypoint.sh, Caddyfile, docker-compose.yml, env examples
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

See `AGENTS.md` for the protocol details, timing math, and operational quirks
(room lifetime, restart re-registration, BackupManager log noise).

## Caveats

- Room→track registrations are in-memory — after a container restart the plugin
  re-pushes/re-registers on its next event; files in `media/` persist.
- `/upload/complete` and ingest are unauthenticated-by-design LAN surfaces;
  keep them off the public ingress (the Caddyfile already doesn't proxy them).
- The BeatSync BackupManager wants S3; without it you'll see harmless
  "backup failed" log lines every 60s.
