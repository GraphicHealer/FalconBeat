import { afterEach, describe, expect, it, vi } from "vitest";
import { artCandidates, fetchTrackTags, isOnAir } from "./show";

// The sidecar name derivation must mirror ingest's safeName — a mismatch is
// how the page 404s on files that exist. These cases pin the contract.
describe("artCandidates / sidecar naming", () => {
  it("maps a plain filename to both art sidecars", () => {
    expect(artCandidates("Song.mp3")).toEqual([
      "/media/Song.mp3.art.jpg",
      "/media/Song.mp3.art.png",
    ]);
  });

  it("decodes a percent-encoded room URL", () => {
    expect(artCandidates("/media/Song%20Title.mp3")[0]).toBe(
      "/media/Song%20Title.mp3.art.jpg",
    );
  });

  it("sanitizes characters ingest would reject", () => {
    // & # % are replaced with _ by safeName on both sides
    expect(artCandidates("Rock & Roll #1.mp3")[0]).toBe(
      "/media/Rock%20_%20Roll%20_1.mp3.art.jpg",
    );
  });

  it("reduces directory paths to the basename", () => {
    expect(artCandidates("music/Holly Jolly.mp3")[0]).toBe(
      "/media/Holly%20Jolly.mp3.art.jpg",
    );
    expect(artCandidates("music\\Song.mp3")[0]).toBe("/media/Song.mp3.art.jpg");
  });

  it("returns nothing for a missing filename", () => {
    expect(artCandidates(null)).toEqual([]);
    expect(artCandidates(undefined)).toEqual([]);
    expect(artCandidates("")).toEqual([]);
  });
});

describe("isOnAir", () => {
  const now = 1_000_000_000_000;

  it("is off air without a doc", () => {
    expect(isOnAir(null, now)).toBe(false);
  });

  it("is off air when the doc says not playing", () => {
    expect(isOnAir({ playing: false, updatedAtMs: now }, now)).toBe(false);
  });

  it("is on air while the doc is fresh", () => {
    expect(isOnAir({ playing: true, updatedAtMs: now - 10_000 }, now)).toBe(true);
  });

  it("goes off air once the doc is stale", () => {
    expect(isOnAir({ playing: true, updatedAtMs: now - 91_000 }, now)).toBe(false);
  });

  it("trusts the flag when the plugin sent no timestamp", () => {
    expect(isOnAir({ playing: true }, now)).toBe(true);
  });
});

describe("fetchTrackTags", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns null without a filename (no request made)", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await fetchTrackTags(null)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("fetches the sanitized sidecar URL", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", spy);
    await fetchTrackTags("Song & Dance.mp3");
    expect(spy).toHaveBeenCalledWith("/media/Song%20_%20Dance.mp3.tags.json", { cache: "no-store" });
  });

  it("parses a found sidecar, null on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ title: "T", artist: "A" }),
    }));
    expect(await fetchTrackTags("x.mp3")).toEqual({ title: "T", artist: "A" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchTrackTags("x.mp3")).toBeNull();
  });
});
