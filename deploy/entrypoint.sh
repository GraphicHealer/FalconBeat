#!/usr/bin/env bash
# FalconBeat all-in-one supervisor. Three processes, one container:
#   beatsync  (Bun)  — WS/API on :8080 (container-internal)
#   ingest    (Bun)  — file push + config PUTs on :8090 (container-internal)
#   caddy            — the only published port, :80, routes everything:
#                      public /ws + /media GETs, Bearer-gated /upload/complete,
#                      ingest writes, LAN-gated /settings.
# First child to exit brings the container down so the restart policy
# resurrects the whole unit rather than leaving a half-dead box.
set -u

# One shared secret. FALCONBEAT_TOKEN feeds all three gates; the legacy
# split names still work as per-gate overrides for existing .env files
# (the /upload/complete gate falls back to INGEST_TOKEN, then CREATOR_SECRET).
export FALCONBEAT_TOKEN="${FALCONBEAT_TOKEN:-${INGEST_TOKEN:-${CREATOR_SECRET:-}}}"
export INGEST_TOKEN="${INGEST_TOKEN:-$FALCONBEAT_TOKEN}"
export CREATOR_SECRET="${CREATOR_SECRET:-$FALCONBEAT_TOKEN}"

cd /app/beatsync && bun dist/index.js &
bun /app/ingest/server.ts &
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &

shutdown() { kill -TERM $(jobs -p) 2>/dev/null; }
trap shutdown TERM INT

wait -n
echo "a supervised process exited — stopping container" >&2
shutdown
exit 1
