/**
 * Show metadata — two JSON docs that live in the media dir alongside audio.
 *
 *   /media/show.json        operator-authored via /settings (or the plugin)
 *   /media/nowplaying.json  pushed by the FPP plugin on every media/stop event
 *
 * Both are publicly readable — they only contain info the page displays anyway.
 * 404s are normal before first configuration / before the first track.
 */

export interface ShowLink {
  label: string;
  url: string;
}

export interface ShowConfig {
  showName: string;
  tagline?: string;
  description?: string;
  schedule?: string;
  location?: string;
  links: ShowLink[];
}

export interface NowPlaying {
  playing: boolean;
  title?: string;
  artist?: string;
  album?: string;
  filename?: string;
  /** ms epoch when the plugin wrote this; staleness → treat as off air */
  updatedAtMs?: number;
}

export const DEFAULT_SHOW: ShowConfig = {
  showName: "FalconBeat",
  tagline: "Synced audio for the light show",
  links: [],
};

/** If the plugin hasn't written in this long, the show is presumed off air. */
export const NOWPLAYING_STALE_MS = 90_000;

export async function fetchShow(): Promise<ShowConfig> {
  try {
    const res = await fetch("/media/show.json", { cache: "no-store" });
    if (!res.ok) return DEFAULT_SHOW;
    const doc = (await res.json()) as Partial<ShowConfig>;
    return { ...DEFAULT_SHOW, ...doc, links: Array.isArray(doc.links) ? doc.links : [] };
  } catch {
    return DEFAULT_SHOW;
  }
}

export async function fetchNowPlaying(): Promise<NowPlaying | null> {
  try {
    const res = await fetch("/media/nowplaying.json", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as NowPlaying;
  } catch {
    return null;
  }
}

export function isOnAir(np: NowPlaying | null, now = Date.now()): boolean {
  if (!np?.playing) return false;
  if (!np.updatedAtMs) return true; // plugin didn't send a timestamp — trust the flag
  return now - np.updatedAtMs < NOWPLAYING_STALE_MS;
}
