import { useSyncExternalStore } from "react";
import { syncEngine, type EngineState } from "./sync/engine";

function statusLine(s: EngineState): string {
  if (s.phase === "idle") return "";
  if (s.phase === "connecting") return "Connecting…";
  if (s.phase === "reconnecting") return `Reconnecting… (attempt ${s.reconnectAttempt})`;
  if (s.phase === "syncing") return "Syncing clock…";
  if (s.sourcesTotal > 0 && s.sourcesLoaded < s.sourcesTotal)
    return `Loading audio ${s.sourcesLoaded}/${s.sourcesTotal}…`;
  if (s.isPlaying) return "Playing";
  return "Listening — waiting for the show";
}

export default function App() {
  const s = useSyncExternalStore(syncEngine.subscribe, syncEngine.getSnapshot);

  const listening = s.joined;

  return (
    <main className="page">
      <header className="brand">
        <h1>FalconBeat</h1>
        <p className="tagline">Synced audio for the light show</p>
      </header>

      {!listening ? (
        <button className="listen-btn" onClick={() => void syncEngine.join()}>
          Tap to Listen
        </button>
      ) : (
        <section className="panel">
          <div className={`dot ${s.isPlaying ? "live" : ""}`} aria-hidden />
          <p className="status">{statusLine(s)}</p>
          {s.isPlaying && s.trackName && <p className="track">{s.trackName}</p>}
        </section>
      )}

      {listening && (
        <footer className="meta">
          {s.listenerCount > 0 && <span>{s.listenerCount} listening</span>}
          {s.phase === "ready" && (
            <span>
              offset {s.offsetMs.toFixed(0)}ms · rtt {s.rttMs.toFixed(0)}ms
            </span>
          )}
        </footer>
      )}

      <p className="hint">
        {listening
          ? "Keep this page open and your screen on. Audio starts automatically when the show does."
          : "Audio plays through this page, synchronized with the lights."}
      </p>
    </main>
  );
}
