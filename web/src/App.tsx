import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { syncEngine, type EngineState } from "./sync/engine";
import {
  artCandidates,
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
// Leave the session only after off-air persists this long — brief gaps
// between playlist tracks shouldn't kick listeners.
const OFFAIR_LEAVE_MS = 15_000;

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
function trackTitle(np: NowPlaying | null, fallback: string | null): string {
  if (np?.title) return np.title;
  if (fallback) return fallback;
  return "Nothing playing";
}

const fmt = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Album art — tries the ingest-extracted sidecars, falls back to a note glyph. */
function Art({ filename }: { filename: string | null }) {
  const [idx, setIdx] = useState(0);
  const candidates = artCandidates(filename);
  useEffect(() => setIdx(0), [filename]);
  if (!candidates.length || idx >= candidates.length) {
    return <div className="art art-placeholder" aria-hidden>♪</div>;
  }
  return (
    <img
      className="art"
      src={candidates[idx]}
      alt="Album art"
      onError={() => setIdx((i) => i + 1)}
      draggable={false}
    />
  );
}

function Listener() {
  const s = useSyncExternalStore(syncEngine.subscribe, syncEngine.getSnapshot);
  const [show, setShow] = useState<ShowConfig>(DEFAULT_SHOW);
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [progress, setProgress] = useState<{ position: number; duration: number } | null>(null);

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

  // Playback progress bar — ticks while the engine reports playing.
  useEffect(() => {
    if (!s.isPlaying) {
      setProgress(null);
      return;
    }
    const tick = () => setProgress(syncEngine.getTrackPosition());
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [s.isPlaying]);

  // Show ended → drop the listener session entirely (WS + playback).
  // They can tap Listen again when the show comes back.
  // np === null means no nowplaying.json exists — plugin may not push it,
  // so "unknown" never triggers a disconnect.
  const offAirSince = useRef<number | null>(null);
  useEffect(() => {
    if (np === null || isOnAir(np)) {
      offAirSince.current = null;
      return;
    }
    if (offAirSince.current === null) offAirSince.current = Date.now();
    if (s.joined && Date.now() - offAirSince.current > OFFAIR_LEAVE_MS) {
      syncEngine.leave();
    }
  }, [np, s.joined]);

  const listening = s.joined;
  const onAir = isOnAir(np);
  // Current track: plugin metadata, else the engine's filename-derived name.
  const trackFile = np?.filename ?? null;
  const title = trackTitle(np, s.trackName);
  const artist = np?.artist ?? null;
  const album = np?.album ?? null;
  const showInfo = show.description || show.schedule || show.location ||
    show.hostedBy || show.links.length > 0;

  return (
    <main className="page">
      <header className="brand">
        <h1>{show.showName}</h1>
        {show.tagline && <p className="tagline">{show.tagline}</p>}
      </header>

      <section className="player">
        <Art filename={trackFile ?? s.trackUrl} />
        <div className="np">
          <p className="np-title">{title}</p>
          {artist && <p className="np-artist">{artist}</p>}
          {album && <p className="np-album">{album}</p>}
        </div>

        {progress && (
          <div className="progress" role="progressbar"
            aria-valuemin={0} aria-valuemax={Math.round(progress.duration)}
            aria-valuenow={Math.round(progress.position)}>
            <span className="progress-time">{fmt(progress.position)}</span>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{ width: `${Math.min(100, (progress.position / progress.duration) * 100)}%` }}
              />
            </div>
            <span className="progress-time">-{fmt(progress.duration - progress.position)}</span>
          </div>
        )}

        {!onAir && !s.isPlaying ? (
          <p className="offair">The show isn't on the air right now.</p>
        ) : !listening ? (
          <button className="play-btn" onClick={() => void syncEngine.join()} aria-label="Listen">
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden>
              <path d="M8 5.14v13.72c0 .8.87 1.3 1.56.88l11.2-6.86a1.03 1.03 0 0 0 0-1.76L9.56 4.26A1.03 1.03 0 0 0 8 5.14z" fill="currentColor" />
            </svg>
            <span>Listen</span>
          </button>
        ) : (
          <p className="status-row">
            <span className={`dot ${s.isPlaying ? "live" : ""}`} aria-hidden />
            <span className="status">{statusLine(s)}</span>
          </p>
        )}
      </section>

      {showInfo && (
        <section className="card info-card">
          <h2 className="card-h">About the show</h2>
          {show.hostedBy && <p className="info-line"><b>Hosted by</b> {show.hostedBy}</p>}
          {show.schedule && <p className="info-line"><b>Schedule</b> {show.schedule}</p>}
          {show.location && <p className="info-line"><b>Location</b> {show.location}</p>}
          {show.description && <p className="desc">{show.description}</p>}
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
