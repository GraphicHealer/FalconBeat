/**
 * FalconBeat bridge CLI — manual control + protocol reference.
 *
 *   node src/cli.ts play "Song.mp3" [--pos 12.5]   # schedule synced play
 *   node src/cli.ts pause [--pos 12.5]             # schedule synced pause
 *   node src/cli.ts status                         # current playback state
 *   node src/cli.ts watch                          # log all room messages
 *
 * Env: BEATSYNC_URL=ws://host:8080  ADMIN_SECRET=...  ROOM_ID=000000
 * (load with: node --env-file=.env src/cli.ts ...)
 */
import {
  configFromEnv,
  connect,
  fetchPlaybackState,
  resolveSource,
  sendCommand,
  uploadAudio,
} from "./client.ts";

const cfg = configFromEnv();
const [cmd, ...args] = process.argv.slice(2);

const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const usage = () => {
  console.log(`Usage: node src/cli.ts <command>

Commands:
  upload <file.mp3>                 Push audio into the room (non-demo mode;
                                    prints the source URL to pass to play)
  play <file.mp3|url> [--pos sec]   Synced play — demo filename or upload URL
  pause [--pos seconds]             Synced pause (defaults to live position)
  status                            Show room playback state via /discover
  watch                             Stay connected, log every server message

Env:  BEATSYNC_URL   (default ws://localhost:8080)
      ADMIN_SECRET   demo mode: ?admin= gate
      CREATOR_SECRET non-demo: ?creator= → guaranteed admin
      ROOM_ID        (default 000000)`);
  process.exit(cmd === "help" || cmd === "--help" ? 0 : 1);
};

if (!cmd) usage();

switch (cmd) {
  case "upload": {
    const file = args[0];
    if (!file) usage();
    console.log(`Uploading ${file} → ${cfg.host} room ${cfg.roomId}`);
    const publicUrl = await uploadAudio(cfg, file);
    console.log(`✓ uploaded; source URL:\n  ${publicUrl}`);
    break;
  }

  case "play": {
    const file = args[0];
    if (!file) usage();
    const pos = Number(flag("pos") ?? 0);
    const audioSource = resolveSource(file);
    console.log(`PLAY ${audioSource} @ ${pos}s → ${cfg.host} room ${cfg.roomId}`);
    const echo = await sendCommand(cfg, { type: "PLAY", audioSource, trackTimeSeconds: pos });
    console.log(`✓ scheduled at server time ${echo.serverTimeToExecute}`);
    break;
  }

  case "pause": {
    // PAUSE needs the currently-playing source; discover it if not provided
    const state = await fetchPlaybackState(cfg);
    const audioSource = flag("source") ?? state?.playbackState.audioSource;
    if (!audioSource) {
      console.error("Nothing playing (and no --source given)");
      process.exit(1);
    }
    const pos =
      flag("pos") !== undefined ? Number(flag("pos")) : (state?.playbackState.trackPositionSeconds ?? 0);
    console.log(`PAUSE ${audioSource} @ ${pos}s`);
    const echo = await sendCommand(cfg, { type: "PAUSE", audioSource, trackTimeSeconds: pos });
    console.log(`✓ scheduled at server time ${echo.serverTimeToExecute}`);
    break;
  }

  case "status": {
    const room = await fetchPlaybackState(cfg);
    if (!room) {
      console.log("Room idle — nothing playing");
      break;
    }
    const ps = room.playbackState;
    console.log(`Room ${room.roomId}: ${room.clients.length} client(s), ${room.audioSources.length} source(s)`);
    console.log(`Playback: ${ps.type} ${ps.audioSource} @ ${ps.trackPositionSeconds.toFixed(2)}s`);
    break;
  }

  case "watch": {
    console.log(`Watching room ${cfg.roomId} on ${cfg.host} (ctrl+C to quit)`);
    await connect(cfg, {
      onMessage: (msg) => console.log(new Date().toISOString(), JSON.stringify(msg)),
      onOpen: () => console.log("connected"),
    });
    // Keep alive forever; LIVENESS_PING handled inside connect()
    await new Promise(() => {});
    break;
  }

  default:
    usage();
}
