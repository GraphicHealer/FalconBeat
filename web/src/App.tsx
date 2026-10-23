import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type PointerEvent } from "react";
import { syncEngine, type EngineState } from "./sync/engine";
import {
  artCandidates,
  DEFAULT_SHOW,
  fetchNowPlaying,
  fetchShow,
  fetchTrackTags,
  isOnAir,
  type NowPlaying,
  type ShowConfig,
  type TrackTags,
} from "./show";
import Settings from "./Settings";

const SHOW_REFRESH_MS = 60_000;
const NOWPLAYING_POLL_MS = 3_000;
// Leave the session only after off-air persists this long — brief gaps
// between playlist tracks shouldn't kick listeners.
const OFFAIR_LEAVE_MS = 15_000;
// How much of the About sheet peeks above the bottom edge when closed.
const SHEET_PEEK_PX = 84;

function statusLine(s: EngineState): string {
  if (s.phase === "idle") return "";
  if (s.phase === "connecting") return "Connecting…";
  if (s.phase === "reconnecting") return `Reconnecting… (attempt ${s.reconnectAttempt})`;
  if (s.phase === "syncing") return "Syncing clock…";
  if (s.sourcesTotal > 0 && s.sourcesLoaded < s.sourcesTotal)
    return `Loading audio ${s.sourcesLoaded}/${s.sourcesTotal}…`;
  if (s.isPlaying) return "Listening";
  return "Connected — waiting for the show";
}

const fmt = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

type Tint = [number, number, number] | null;

/**
 * Album art — tries the ingest-extracted sidecars, falls back to a note
 * glyph. On successful load, samples the image's average colour so the
 * page background can tint to match (Spotify-style).
 */
function Art({ filename, onTint }: { filename: string | null; onTint: (t: Tint) => void }) {
  const [idx, setIdx] = useState(0);
  const candidates = artCandidates(filename);
  const attempts = useRef(0);
  useEffect(() => {
    setIdx(0);
    attempts.current = 0;
    onTint(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filename]);

  // The sidecar is written during upload — it may not exist when the track
  // first appears. If every candidate 404s, re-walk them a few times before
  // settling on the placeholder for good (bounded: ~40s covers slow pushes).
  useEffect(() => {
    if (!candidates.length || idx < candidates.length || attempts.current >= 8) return;
    const retry = setInterval(() => {
      if (++attempts.current >= 8) clearInterval(retry);
      setIdx(0);
    }, 5000);
    return () => clearInterval(retry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx >= candidates.length, filename]);

  const sample = (img: HTMLImageElement) => {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 16;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0, 16, 16);
      const d = ctx.getImageData(0, 0, 16, 16).data;
      let r = 0, g = 0, b = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        r += d[i]; g += d[i + 1]; b += d[i + 2];
      }
      onTint([Math.round(r / n), Math.round(g / n), Math.round(b / n)]);
    } catch {
      onTint(null);
    }
  };

  if (!candidates.length || idx >= candidates.length) {
    return <div className="art art-placeholder" aria-hidden>♪</div>;
  }
  return (
    <img
      className="art"
      src={candidates[idx]}
      alt="Album art"
      onLoad={(e) => sample(e.currentTarget)}
      onError={() => {
        setIdx((i) => i + 1);
        onTint(null);
      }}
      draggable={false}
    />
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden>
      <path d="M8 5.14v13.72c0 .8.87 1.3 1.56.88l11.2-6.86a1.03 1.03 0 0 0 0-1.76L9.56 4.26A1.03 1.03 0 0 0 8 5.14z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden>
      <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" />
      <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 16V4" /><path d="M6 10l6-6 6 6" /><path d="M5 15v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 8v.01" />
    </svg>
  );
}

function Listener() {
  const s = useSyncExternalStore(syncEngine.subscribe, syncEngine.getSnapshot);
  const [show, setShow] = useState<ShowConfig>(DEFAULT_SHOW);
  const [np, setNp] = useState<NowPlaying | null>(null);
  const [tags, setTags] = useState<TrackTags | null>(null);
  const [progress, setProgress] = useState<{ position: number; duration: number } | null>(null);
  const [tint, setTint] = useState<Tint>(null);
  const [shared, setShared] = useState(false);

  // ── About-the-show bottom sheet (peek → drag/tap to expand) ─────────
  const sheetRef = useRef<HTMLDivElement>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [dragY, setDragY] = useState<number | null>(null);
  const drag = useRef({ y0: 0, open0: false, moved: false });

  const grabStart = (e: PointerEvent<HTMLDivElement>) => {
    const el = sheetRef.current;
    if (!el) return;
    // Capture on the grab element itself — the move/up handlers live here,
    // and pointer events retarget to whichever element holds the capture.
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y0: e.clientY, open0: sheetOpen, moved: false };
    setDragY(sheetOpen ? 0 : el.offsetHeight - SHEET_PEEK_PX);
  };
  const grabMove = (e: PointerEvent<HTMLDivElement>) => {
    const el = sheetRef.current;
    if (dragY === null || !el) return;
    const dy = e.clientY - drag.current.y0;
    if (Math.abs(dy) > 6) drag.current.moved = true;
    const base = drag.current.open0 ? 0 : el.offsetHeight - SHEET_PEEK_PX;
    setDragY(Math.min(el.offsetHeight - SHEET_PEEK_PX, Math.max(0, base + dy)));
  };
  const grabEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (dragY === null) return;
    const dy = e.clientY - drag.current.y0;
    if (!drag.current.moved) setSheetOpen(!drag.current.open0);
    else if (!drag.current.open0 && dy < -40) setSheetOpen(true);
    else if (drag.current.open0 && dy > 40) setSheetOpen(false);
    setDragY(null);
  };

  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSheetOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  // ── data polling ──────────────────────────────────────────────────
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
  const trackFile = np?.filename ?? s.trackUrl;

  // Embedded file tags (server-side sidecar) are authoritative over the
  // fields the plugin forwards from FPP. The plugin pushes nowplaying
  // BEFORE the file finishes uploading, so the sidecar may not exist yet —
  // retry until it lands (or the file proves untagged).
  useEffect(() => {
    if (!trackFile) {
      setTags(null);
      return;
    }
    let alive = true;
    let tries = 0;
    const load = () =>
      void fetchTrackTags(trackFile).then((t) => {
        if (!alive) return;
        setTags(t);
        if (t || ++tries >= 6) clearInterval(retry);
      });
    load();
    const retry = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(retry);
    };
  }, [trackFile]);

  // Last-resort title: the filename stem, so a track shows something even
  // when neither sidecar tags nor plugin metadata exist (e.g. a
  // reconcile-triggered play where the media event carried no tags).
  const fileStem = trackFile
    ? decodeURIComponent(trackFile.split(/[\\/]/).pop()!).replace(/\.[^.]+$/, "")
    : null;
  const title = tags?.title ?? np?.title ?? s.trackName ?? fileStem ?? "Nothing playing";
  const artist = tags?.artist ?? np?.artist ?? null;
  const album = tags?.album ?? np?.album ?? null;
  const showInfo = show.description || show.schedule || show.location ||
    show.hostedBy || show.links.length > 0;

  // Up-next: plugin pushes the next filename; prefer its embedded tags.
  // The lookahead push may still be uploading when np.next first appears,
  // so retry a few times until the sidecar lands (or the file proves
  // untagged — then the filename stays the fallback).
  const [nextTags, setNextTags] = useState<TrackTags | null>(null);
  useEffect(() => {
    if (!np?.next) {
      setNextTags(null);
      return;
    }
    let alive = true;
    let tries = 0;
    const load = () =>
      void fetchTrackTags(np.next).then((t) => {
        if (!alive) return;
        setNextTags(t);
        if (t || ++tries >= 4) clearInterval(retry);
      });
    load();
    const retry = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(retry);
    };
  }, [np?.next]);
  const nextTitle = np?.next
    ? (nextTags?.title ?? np.next.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, ""))
    : null;

  // Media Session — Android shade/lockscreen shows what's playing with
  // artwork; the play/pause hardware buttons map to join/leave.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist: artist ?? "",
        album: album ?? show.showName ?? "",
        artwork: artCandidates(trackFile).map((src) => ({ src })),
      });
      navigator.mediaSession.playbackState = s.isPlaying
        ? "playing"
        : listening
          ? "paused"
          : "none";
    } catch {}
  }, [title, artist, album, show.showName, trackFile, s.isPlaying, listening]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler("play", () => void syncEngine.join());
      navigator.mediaSession.setActionHandler("pause", () => syncEngine.leave());
    } catch {}
  }, []);

  const share = async () => {
    const data = { title: show.showName || "FalconBeat", text: `Listen to ${show.showName} live`, url: location.href };
    try {
      if (navigator.share) await navigator.share(data);
      else {
        await navigator.clipboard.writeText(location.href);
        setShared(true);
        setTimeout(() => setShared(false), 2000);
      }
    } catch {}
  };

  return (
    <main
      className="np-page"
      style={{ "--art-tint": tint ? `rgb(${tint[0]},${tint[1]},${tint[2]})` : undefined } as CSSProperties}
    >
      {/* ── Top bar: show identity + about toggle ── */}
      <header className="np-top">
        <span className="np-top-side np-version">
          {import.meta.env.VITE_APP_VERSION !== "dev" ? import.meta.env.VITE_APP_VERSION : ""}
        </span>
        <div className="np-top-center">
          <h1 className="np-top-name">{show.showName}</h1>
          <span className="np-top-sub">{show.tagline || "Listening live"}</span>
        </div>
        <button className="np-top-btn" onClick={() => setSheetOpen(true)} aria-label="About the show">
          <InfoIcon />
        </button>
      </header>

      {/* ── Album art ── */}
      <section className="np-art">
        <Art filename={trackFile} onTint={setTint} />
      </section>

      {/* ── Track identity ── */}
      <section className="np-meta">
        <div className="np-meta-text">
          <p className="np-title">{title}</p>
          <p className="np-artist">{artist || " "}{album ? `${artist ? " · " : ""}${album}` : ""}</p>
        </div>
        {s.isPlaying && (
          <span className="np-live">
            <span className="dot live" aria-hidden />LIVE
          </span>
        )}
      </section>

      {/* ── Progress ── */}
      <section className="np-progress-wrap">
        <div className="progress-track">
          <div
            className="progress-fill"
            style={{ width: `${progress ? Math.min(100, (progress.position / progress.duration) * 100) : 0}%` }}
          />
        </div>
        <div className="progress-times">
          <span>{progress ? fmt(progress.position) : "--:--"}</span>
          <span>{progress ? `-${fmt(progress.duration - progress.position)}` : "--:--"}</span>
        </div>
      </section>

      {/* ── Controls ── */}
      <section className="np-controls">
        <button className="np-side np-icon" onClick={() => void share()} aria-label="Share this page">
          <ShareIcon />
        </button>
        <button
          className={`np-play${listening ? " playing" : ""}`}
          onClick={() => (listening ? syncEngine.leave() : void syncEngine.join())}
          aria-label={listening ? "Stop listening" : "Listen"}
        >
          {listening ? <PauseIcon /> : <PlayIcon />}
        </button>
        <span className="np-side np-next">
          {nextTitle && (
            <>
              <small>Up next</small>
              <span className="np-next-title">{nextTitle}</span>
              {nextTags?.artist && <span className="np-next-artist">{nextTags.artist}</span>}
            </>
          )}
          {!nextTitle && listening && s.listenerCount > 0 && `${s.listenerCount} listening`}
        </span>
      </section>

      {/* ── Status line ── */}
      <p className="np-status">
        {shared
          ? "Link copied!"
          : !onAir && !s.isPlaying && !listening
            ? "The show isn't on the air right now."
            : listening
              ? `${statusLine(s)} · keep this page open and your screen on`
              : "Tap play to listen in sync with the lights."}
      </p>

      {/* ── About the show — draggable bottom sheet ── */}
      {sheetOpen && <div className="sheet-backdrop" onClick={() => setSheetOpen(false)} />}
      <div
        ref={sheetRef}
        className={`sheet${sheetOpen ? " open" : ""}${dragY !== null ? " dragging" : ""}`}
        style={dragY !== null ? { transform: `translateY(${dragY}px)` } : undefined}
        role="dialog"
        aria-label="About the show"
      >
        <div
          className="sheet-grab"
          onPointerDown={grabStart}
          onPointerMove={grabMove}
          onPointerUp={grabEnd}
          onPointerCancel={grabEnd}
        >
          <div className="grabber" aria-hidden />
          <div className="sheet-peek">
            <span className="sheet-chip">⚡ About the Show</span>
            {show.hostedBy && <span className="sheet-peek-sub">{show.hostedBy}</span>}
          </div>
        </div>
        <div className="sheet-body">
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
          {!showInfo && <p className="info-line">No show details yet — the operator can add them in settings.</p>}
        </div>
      </div>
    </main>
  );
}

export default function App() {
  // No router dep — /settings is the operator page, everything else is the listener.
  if (location.pathname === "/settings") return <Settings />;
  return <Listener />;
}
