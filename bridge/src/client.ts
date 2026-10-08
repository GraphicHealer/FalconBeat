/**
 * FalconBeat admin client — speaks the BeatSync WebSocket protocol.
 *
 * Server-verified facts (beatsync @ 94c38ab):
 * - WS: {ws|wss}://host/ws?roomId=000000&username=X&clientId=Y&admin=SECRET
 * - Demo mode: admin comes only from the ?admin= secret; PLAY/PAUSE need admin
 *   because the room's playbackControlsPermissions defaults to ADMIN_ONLY.
 * - PLAY is broadcast verbatim as SCHEDULED_ACTION with serverTimeToExecute =
 *   now + max(400ms, 1.5*maxClientRTT+200, maxClientCompensation+200), cap 3s.
 * - trackTimeSeconds is the playback OFFSET — send FPP position + expected
 *   delay to make phones seek into the track, not restart it.
 * - Server sends LIVENESS_PING after 15s of silence; reply LIVENESS_PONG or
 *   the connection is reaped at 60s.
 * - GET /discover → active (playing) rooms incl. playbackState
 *   { audioSource, trackPositionSeconds, serverTimeToExecute }.
 */

export interface BridgeConfig {
  /** e.g. "localhost:8080" or "falconbeat.local:8080" — no scheme */
  host: string;
  /** ws | wss */
  secure: boolean;
  roomId: string;
  /** Demo mode: ?admin= secret */
  adminSecret: string;
  /** Non-demo mode: ?creator= secret → guaranteed admin regardless of join order */
  creatorSecret: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const raw = env.BEATSYNC_URL ?? "ws://localhost:8080";
  const url = new URL(raw.replace(/^ws/, "http")); // ws(s):// → http(s):// for parsing
  return {
    host: url.host,
    secure: url.protocol === "https:",
    roomId: env.ROOM_ID ?? "000000",
    adminSecret: env.ADMIN_SECRET ?? "",
    creatorSecret: env.CREATOR_SECRET ?? "",
  };
}

export function httpBase(cfg: BridgeConfig): string {
  return `${cfg.secure ? "https" : "http"}://${cfg.host}`;
}

export function wsUrl(cfg: BridgeConfig, clientId: string): string {
  const params = new URLSearchParams({
    roomId: cfg.roomId,
    username: "falconbeat-bridge",
    clientId,
  });
  if (cfg.adminSecret) params.set("admin", cfg.adminSecret);
  if (cfg.creatorSecret) params.set("creator", cfg.creatorSecret);
  return `${cfg.secure ? "wss" : "ws"}://${cfg.host}/ws?${params}`;
}

/** Demo mode audio source URL: /audio/{encodeURIComponent(name)} */
export function audioSourceUrl(filename: string): string {
  return `/audio/${encodeURIComponent(filename)}`;
}

/** Accept either a demo-mode filename or a full source URL (non-demo upload) */
export function resolveSource(fileOrUrl: string): string {
  return fileOrUrl.startsWith("http") ? fileOrUrl : audioSourceUrl(fileOrUrl);
}

/**
 * Non-demo upload flow — pushes an audio file into the room:
 *   POST /upload/get-presigned-url → PUT bytes to S3 → POST /upload/complete
 * The room must exist (>=1 connected client), so we hold a WS open for the
 * duration. Returns the public URL to pass to PLAY.
 */
export async function uploadAudio(cfg: BridgeConfig, filePath: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { basename } = await import("node:path");

  const fileName = basename(filePath);
  const bytes = await readFile(filePath);
  const contentType = fileName.toLowerCase().endsWith(".wav") ? "audio/wav" : "audio/mpeg";

  // Hold the room open during the upload (room must exist for presign)
  const ws = await connect(cfg);
  try {
    const presignRes = await fetch(`${httpBase(cfg)}/upload/get-presigned-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: cfg.roomId, fileName, contentType }),
    });
    if (!presignRes.ok) {
      throw new Error(`get-presigned-url → HTTP ${presignRes.status}: ${await presignRes.text()}`);
    }
    const { uploadUrl, publicUrl } = (await presignRes.json()) as {
      uploadUrl: string;
      publicUrl: string;
    };

    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: bytes,
    });
    if (!putRes.ok) throw new Error(`S3 PUT → HTTP ${putRes.status}: ${await putRes.text()}`);

    const completeRes = await fetch(`${httpBase(cfg)}/upload/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: cfg.roomId, originalName: fileName, publicUrl }),
    });
    if (!completeRes.ok) {
      throw new Error(`upload/complete → HTTP ${completeRes.status}: ${await completeRes.text()}`);
    }
    return publicUrl;
  } finally {
    ws.close();
  }
}

export interface PlaybackState {
  type: "playing" | "paused";
  audioSource: string;
  serverTimeToExecute: number;
  trackPositionSeconds: number;
}

export interface DiscoveredRoom {
  roomId: string;
  clients: { clientId: string; username: string }[];
  audioSources: { url: string }[];
  playbackState: PlaybackState;
}

/** Current playback state for our room, or null if nothing is playing. */
export async function fetchPlaybackState(cfg: BridgeConfig): Promise<DiscoveredRoom | null> {
  const res = await fetch(`${httpBase(cfg)}/discover`);
  if (!res.ok) throw new Error(`/discover → HTTP ${res.status}`);
  const rooms = (await res.json()) as DiscoveredRoom[];
  return rooms.find((r) => r.roomId === cfg.roomId) ?? null;
}

export interface ConnectOptions {
  onMessage?: (msg: { type: string } & Record<string, unknown>) => void;
  onOpen?: () => void;
  clientId?: string;
}

/**
 * Open an admin WS connection. Handles LIVENESS_PING → PONG automatically.
 * Returns the socket; caller closes it.
 */
export function connect(cfg: BridgeConfig, opts: ConnectOptions = {}): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl(cfg, opts.clientId ?? `bridge-${process.pid}`));

  return new Promise((resolve, reject) => {
    ws.onopen = () => {
      opts.onOpen?.();
      resolve(ws);
    };
    ws.onerror = (e) => reject(new Error(`WebSocket error: ${(e as ErrorEvent).message ?? "unknown"}`));
    ws.onclose = (e) => reject(new Error(`WebSocket closed (${e.code} ${e.reason || "no reason"})`));
    ws.onmessage = (ev) => {
      let msg: { type: string } & Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === "LIVENESS_PING") {
        ws.send(JSON.stringify({ type: "LIVENESS_PONG" }));
        return;
      }
      opts.onMessage?.(msg);
    };
  });
}

/**
 * Send PLAY/PAUSE and wait for the matching SCHEDULED_ACTION echo that
 * confirms the server accepted it. The join handshake unicasts three
 * SCHEDULED_ACTIONs (volume/metronome/lowpass config) so we must match on
 * action type AND audioSource — and rejections are swallowed server-side
 * (dispatch.ts logs only), so the echo is the only positive signal.
 */
export async function sendCommand(
  cfg: BridgeConfig,
  request: Record<string, unknown>,
  timeoutMs = 8000
): Promise<{ serverTimeToExecute: number; scheduledAction: Record<string, unknown> }> {
  let resolveEcho:
    | ((m: { serverTimeToExecute: number; scheduledAction: Record<string, unknown> }) => void)
    | null = null;
  const confirmed = new Promise<{ serverTimeToExecute: number; scheduledAction: Record<string, unknown> }>(
    (res) => (resolveEcho = res)
  );

  const ws = await connect(cfg, {
    onMessage: (msg) => {
      if (msg.type !== "SCHEDULED_ACTION") return;
      const action = (msg as { scheduledAction?: { type?: string; audioSource?: string } })
        .scheduledAction;
      if (action?.type !== request.type) return;
      if (request.audioSource && action.audioSource !== request.audioSource) return;
      resolveEcho?.(msg as never);
    },
  });

  ws.send(JSON.stringify(request));

  try {
    return await Promise.race([
      confirmed,
      new Promise<never>((_, rej) =>
        setTimeout(
          () =>
            rej(
              new Error(
                "No SCHEDULED_ACTION echo within timeout — " +
                  "server likely rejected it (unknown audio source? not admin?)."
              )
            ),
          timeoutMs
        )
      ),
    ]);
  } finally {
    ws.close();
  }
}
