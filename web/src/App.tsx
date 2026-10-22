import { useEffect, useState, useSyncExternalStore } from "react";
import { syncEngine, type EngineState } from "./sync/engine";
import {
  DEFAULT_SHOW,
  fetchNowPlaying,
  fetchShow,
  isOnAir,
  type NowPlaying,
  type ShowConfig,
} from "./show";
import Settings from "./Settings";

const SHOW_REFRESH_MS = 60_000;
const NOWPLAYING_POLL_MS = 3_000;

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

/** Prefer plugin-pushed metadata; fall back to the filename-derived title. */
function nowPlayingLine(np: NowPlaying | null, trackName: string | null): string | null {
  if (np?.title) return np.artist ? `${np.title} — ${np.artist}` : np.title;
  return trackName;
}

function Listener() {
  const s = useSyncExternalStore(syncEngine.subscribe, syncEngine.getSnapshot);
  const [show, setShow] = useState<ShowConfig>(DEFAULT_SHOW);
  const [np, setNp] = useState<NowPlaying | null>(null);

  useEffect(() => {
    let alive = true;
    const refreshShow = () => fetchShow().then((c) => alive && setShow(c));
    const pollNp = () => fetchNowPlaying().then((n) => alive && setNp(n));
    void refreshShow();
    void pollNp();
    const t1 = setInterval(refreshShow, SHOW_REFRESH_MS);
    const t2 = setInterval(pollNp, NOWPLAYING_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t1);
      clearInterval(t2);
    };
  }, []);

  useEffect(() => {
    document.title = show.showName || "FalconBeat";
  }, [show.showName]);

  const listening = s.joined;
  const onAir = isOnAir(np);
  const trackLine = nowPlayingLine(np, s.trackName);

  return (
    <main className="page">
      <header className="brand">
        <h1>{show.showName}</h1>
        {show.tagline && <p className="tagline">{show.tagline}</p>}
      </header>

      {!onAir && !s.isPlaying && (
        <p className="offair">The show isn't on the air right now.</p>
      )}

      {!listening ? (
        <button className="listen-btn" onClick={() => void syncEngine.join()}>
          Tap to Listen
        </button>
      ) : (
        <section className="panel">
          <div className={`dot ${s.isPlaying ? "live" : ""}`} aria-hidden />
          <p className="status">{statusLine(s)}</p>
          {s.isPlaying && trackLine && <p className="track">{trackLine}</p>}
          {s.isPlaying && np?.album && <p className="album">{np.album}</p>}
        </section>
      )}

      {(show.description || show.schedule || show.links.length > 0) && (
        <section className="info">
          {show.description && <p className="desc">{show.description}</p>}
          {show.schedule && <p className="schedule">{show.schedule}</p>}
          {show.links.length > 0 && (
            <p className="links">
              {show.links.map((l, i) => (
                <a key={i} href={l.url} target="_blank" rel="noreferrer">
                  {l.label || l.url}
                </a>
              ))}
            </p>
          )}
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

export default function App() {
  // No router dep — /settings is the operator page, everything else is the listener.
  if (location.pathname === "/settings") return <Settings />;
  return <Listener />;
}
