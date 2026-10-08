#!/usr/bin/env bash
# FalconBeat all-in-one supervisor. Three processes, one container:
#   beatsync  (Bun)  — WS/API on :8080
#   ingest    (Bun)  — LAN file push + media GETs on :8090
#   caddy            — public edge on :80
# First child to exit brings the container down so the restart policy
# resurrects the whole unit rather than leaving a half-dead box.
set -u

cd /app/beatsync && bun dist/index.js &
bun /app/ingest/server.ts &
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &

shutdown() { kill -TERM $(jobs -p) 2>/dev/null; }
trap shutdown TERM INT

wait -n
echo "a supervised process exited — stopping container" >&2
shutdown
exit 1
