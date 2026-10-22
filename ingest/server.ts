/**
 * FalconBeat ingest — LAN-only audio receiver + static media server.
 *
 *   PUT  /media/<filename>    Authorization: Bearer $INGEST_TOKEN → store to MEDIA_DIR
 *   DELETE /media/<filename>  Bearer → remove from MEDIA_DIR (plugin evicts
 *                             played tracks so the volume doesn't fill up)
 *   PUT  /config/show         Bearer → write MEDIA_DIR/show.json (operator show config)
 *   PUT  /config/nowplaying   Bearer → write MEDIA_DIR/nowplaying.json (plugin pushes
 *                             per-track metadata; {playing:false} when off air)
 *   GET  /media|/config/<n>   serve file (dev convenience; prod GETs go through Caddy)
 *   GET  /health
 *   GET  /*                   SPA fallback → WEB_DIST (optional; serves the listener
 *                             page + /settings on the LAN port, same-origin PUTs)
 *
 * The plugin then registers the file with BeatSync via POST /upload/complete
 * {roomId, originalName, publicUrl} where publicUrl = MEDIA_PUBLIC_URL/media/<name>.
 * BeatSync stores the URL and broadcasts it — it never touches the bytes.
 *
 * Env: PORT=8090  MEDIA_DIR=./media  INGEST_TOKEN=...  WEB_DIST=/srv/falconbeat (opt)
 * Run: node server.ts   (Node ≥22.18, zero deps; also runs under Bun)
 */
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";

const PORT = Number(process.env.PORT ?? 8090);
const MEDIA_DIR = resolve(process.env.MEDIA_DIR ?? "./media");
const WEB_DIST = process.env.WEB_DIST ? resolve(process.env.WEB_DIST) : null;
const TOKEN = process.env.INGEST_TOKEN ?? "";

const AUDIO_EXT = new Set([".mp3", ".wav", ".flac", ".ogg", ".m4a"]);
const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};
const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
/** JSON docs writable via /config/<name> — show info and plugin-pushed now-playing. */
const CONFIG_NAMES = new Set(["show", "nowplaying"]);

// LAN-only service behind a Bearer token; the /settings page PUTs cross-origin
// from the operator's browser, so permissive CORS is required and acceptable.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

const json = (res: import("node:http").ServerResponse, code: number, body: unknown) =>
  res.writeHead(code, { "Content-Type": "application/json", ...CORS }).end(JSON.stringify(body));

// ── Embedded cover-art extraction ────────────────────────────────────
// On PUT, pull the first picture out of the file and store it as a
// sidecar: <name>.art.jpg|png — the listener page shows it as album art.
// MP3: ID3v2 APIC (v2.3/v2.4) or PIC (v2.2) frame. FLAC: PICTURE block.

const syncsafe = (buf: Buffer, o: number) =>
  ((buf[o] & 0x7f) << 21) | ((buf[o + 1] & 0x7f) << 14) |
  ((buf[o + 2] & 0x7f) << 7) | (buf[o + 3] & 0x7f);

const deunsync = (d: Buffer): Buffer => {
  const out: number[] = [];
  for (let i = 0; i < d.length; i++) {
    out.push(d[i]);
    if (d[i] === 0xff && d[i + 1] === 0x00) i++;
  }
  return Buffer.from(out);
};

/** Skip an encoded description field; returns offset of the image data. */
const skipDesc = (f: Buffer, start: number, enc: number): number => {
  let p = start;
  if (enc === 1 || enc === 2) { // UTF-16: double-null terminated
    while (p + 1 < f.length && !(f[p] === 0 && f[p + 1] === 0)) p += 2;
    return p + 2;
  }
  while (p < f.length && f[p] !== 0) p++;
  return p + 1;
};

const apicData = (f: Buffer, v22: boolean): { ext: string; data: Buffer } | null => {
  const enc = f[0] ?? 0;
  let off: number;
  if (v22) {
    off = skipDesc(f, 5, enc); // enc + fmt(3) + picType
  } else {
    const mimeEnd = f.indexOf(0, 1);
    if (mimeEnd < 0) return null;
    off = skipDesc(f, mimeEnd + 2, enc); // mime + nul + picType
  }
  if (off >= f.length) return null;
  const data = f.subarray(off);
  // Trust the image's magic bytes over the declared mime — taggers
  // routinely label PNG art as image/jpeg (and browsers don't always
  // sniff). If neither magic matches, the payload isn't a usable
  // image (compressed/linked/garbage) → no sidecar at all.
  const ext = sniffImage(data);
  return ext ? { ext, data } : null;
};

const sniffImage = (b: Buffer): string | null => {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
  if (b.length > 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ".png";
  return null;
};

interface TagData {
  art?: { ext: string; data: Buffer };
  tags?: { title?: string; artist?: string; album?: string };
}

/** ID3 text frame: [enc][text] → string (enc 0 latin1, 1 utf16+BOM, 2 utf16be, 3 utf8). */
const decodeText = (f: Buffer): string => {
  const enc = f[0];
  const b = f.subarray(1);
  if (enc === 1) {
    const be = b.length >= 2 && b[0] === 0xfe && b[1] === 0xff;
    const body = (be || (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe)) ? b.subarray(2) : b;
    return be ? Buffer.from(body).swap16().toString("utf16le") : body.toString("utf16le");
  }
  if (enc === 2) return Buffer.from(b).swap16().toString("utf16le");
  if (enc === 3) return b.toString("utf8");
  return b.toString("latin1");
};

const TEXT_FRAMES: Record<string, "title" | "artist" | "album"> = {
  TIT2: "title", TPE1: "artist", TALB: "album", // v2.3/v2.4
  TT2: "title", TP1: "artist", TAL: "album",   // v2.2
};

const id3TagData = (buf: Buffer): TagData => {
  const out: TagData = {};
  const major = buf[3];
  const flags = buf[5];
  const tagEnd = Math.min(10 + syncsafe(buf, 6) + (flags & 0x10 ? 10 : 0), buf.length);
  let pos = 10;
  if (flags & 0x40 && pos + 4 <= tagEnd) { // extended header
    pos += major === 4 ? syncsafe(buf, pos) : buf.readUInt32BE(pos) + 4;
  }
  while (pos < tagEnd) {
    if (major === 2) {
      if (pos + 6 > tagEnd) break;
      const id = buf.toString("latin1", pos, pos + 3);
      if (!/^[A-Z0-9]{3}$/.test(id)) break;
      const size = (buf[pos + 3] << 16) | (buf[pos + 4] << 8) | buf[pos + 5];
      let f = buf.subarray(pos + 6, pos + 6 + size);
      if (flags & 0x80) f = deunsync(f);
      if (id === "PIC" && !out.art) out.art = apicData(f, true) ?? undefined;
      const key = TEXT_FRAMES[id];
      if (key && !out.tags?.[key]) {
        const t = decodeText(f).trim();
        if (t) (out.tags ??= {})[key] = t;
      }
      pos += 6 + size;
    } else {
      if (pos + 10 > tagEnd) break;
      const id = buf.toString("latin1", pos, pos + 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const size = major === 4 ? syncsafe(buf, pos + 4) : buf.readUInt32BE(pos + 4);
      const fflags = buf.readUInt16BE(pos + 8);
      let f = buf.subarray(pos + 10, pos + 10 + size);
      if ((major === 3 && (flags & 0x80) !== 0) || (major === 4 && (fflags & 0x0002) !== 0)) {
        f = deunsync(f);
      }
      // v2.3: 0x40 = encrypted, 0x80 = compressed (4B orig-len prefix + zlib).
      // v2.4: 0x04 = encrypted, 0x08 = compressed, 0x01 = data-length-indicator.
      const encrypted = major === 3 ? fflags & 0x0040 : fflags & 0x0004;
      if (encrypted) {
        pos += 10 + size;
        continue; // can't decrypt — skip frame
      }
      const compressed = major === 3 ? fflags & 0x0080 : fflags & 0x0008;
      if (compressed) {
        try {
          f = Buffer.from(inflateSync(f.subarray(4))); // always has a DLI prefix
        } catch {
          pos += 10 + size;
          continue;
        }
      } else if (major === 4 && (fflags & 0x0001)) {
        f = f.subarray(4); // DLI without compression
      }
      if (id === "APIC" && !out.art) out.art = apicData(f, false) ?? undefined;
      const key = TEXT_FRAMES[id];
      if (key && !out.tags?.[key]) {
        const t = decodeText(f).trim();
        if (t) (out.tags ??= {})[key] = t;
      }
      pos += 10 + size;
    }
  }
  return out;
};

const flacTagData = (buf: Buffer): TagData => {
  const out: TagData = {};
  let pos = 4; // past "fLaC"
  while (pos + 4 <= buf.length) {
    const last = (buf[pos] & 0x80) !== 0;
    const type = buf[pos] & 0x7f;
    const len = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    pos += 4;
    if (type === 6 && pos + len <= buf.length) { // PICTURE
      const b = buf.subarray(pos, pos + len);
      const mimeLen = b.readUInt32BE(0);
      const descLen = b.readUInt32BE(4 + mimeLen);
      const off = 4 + mimeLen + 4 + descLen + 20; // +w/h/depth/colors +dataLen
      const dataLen = b.readUInt32BE(off - 4);
      if (off + dataLen <= b.length) {
        const data = b.subarray(off, off + dataLen);
        const ext = sniffImage(data);
        if (ext) out.art = { ext, data };
      }
    }
    if (type === 4 && pos + len <= buf.length) { // VORBIS_COMMENT
      const b = buf.subarray(pos, pos + len);
      let p = 4 + b.readUInt32LE(0); // vendor len + vendor
      const count = b.readUInt32LE(p);
      p += 4;
      for (let i = 0; i < count && p + 4 <= b.length; i++) {
        const l = b.readUInt32LE(p);
        p += 4;
        const entry = b.toString("utf8", p, p + l);
        p += l;
        const eq = entry.indexOf("=");
        const key = entry.slice(0, eq).toUpperCase();
        const val = entry.slice(eq + 1).trim();
        const field = key === "TITLE" ? "title" : key === "ARTIST" ? "artist" : key === "ALBUM" ? "album" : null;
        if (field && val && !out.tags?.[field]) (out.tags ??= {})[field] = val;
      }
    }
    pos += len;
    if (last) break;
  }
  return out;
};

const extractTagData = (buf: Buffer): TagData => {
  if (buf.length > 10 && buf.toString("latin1", 0, 3) === "ID3") return id3TagData(buf);
  if (buf.length > 4 && buf.toString("latin1", 0, 4) === "fLaC") return flacTagData(buf);
  return {};
};

/** Sidecar candidates for an audio file — written on PUT, removed on DELETE. */
const artSidecars = (safe: string) => [`${safe}.art.jpg`, `${safe}.art.png`, `${safe}.tags.json`];

/** Strip to basename + safe charset; reject non-audio extensions. */
const safeName = (raw: string): string | null => {
  const name = basename(decodeURIComponent(raw)).replace(/[^\w.() \-']/g, "_");
  return AUDIO_EXT.has(extname(name).toLowerCase()) ? name : null;
};

const authed = (req: import("node:http").IncomingMessage) =>
  TOKEN.length > 0 && req.headers.authorization === `Bearer ${TOKEN}`;

const readBody = async (req: import("node:http").IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const fileName = url.pathname.startsWith("/media/") ? url.pathname.slice("/media/".length) : null;
  const configName = url.pathname.startsWith("/config/") ? url.pathname.slice("/config/".length) : null;

  try {
    if (req.method === "OPTIONS") {
      return res.writeHead(204, CORS).end();
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { status: "ok" });
    }

    // PUT /config/<show|nowplaying> — JSON doc → MEDIA_DIR/<name>.json.
    // show.json is operator-authored (settings page or FPP plugin);
    // nowplaying.json is pushed by the plugin on every media/stop event.
    if (req.method === "PUT" && configName) {
      if (!authed(req)) return json(res, 401, { error: "unauthorized" });
      const name = basename(configName).replace(/\.json$/, "").toLowerCase();
      if (!CONFIG_NAMES.has(name)) return json(res, 400, { error: "unknown config" });

      const body = await readBody(req);
      let doc: unknown;
      try {
        doc = JSON.parse(body.toString("utf8"));
      } catch {
        return json(res, 400, { error: "invalid JSON" });
      }
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        return json(res, 400, { error: "config must be a JSON object" });
      }
      await mkdir(MEDIA_DIR, { recursive: true });
      await writeFile(join(MEDIA_DIR, `${name}.json`), JSON.stringify(doc));
      console.log(`PUT /config/${name}`);
      return json(res, 200, { stored: `${name}.json` });
    }

    if (req.method === "GET" && configName) {
      const name = basename(configName).replace(/\.json$/, "").toLowerCase();
      if (!CONFIG_NAMES.has(name)) return json(res, 404, { error: "not found" });
      const data = await readFile(join(MEDIA_DIR, `${name}.json`), "utf8");
      return res
        .writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache", ...CORS })
        .end(data);
    }

    if (req.method === "GET" && url.pathname === "/media") {
      const files = (await readdir(MEDIA_DIR)).filter((f) => AUDIO_EXT.has(extname(f).toLowerCase()));
      return json(res, 200, { files });
    }

    if (req.method === "PUT" && fileName) {
      if (!authed(req)) return json(res, 401, { error: "unauthorized" });
      const safe = safeName(fileName);
      if (!safe) return json(res, 400, { error: "unsupported audio filename" });

      const bytes = await readBody(req);
      await mkdir(MEDIA_DIR, { recursive: true });
      await writeFile(join(MEDIA_DIR, safe), bytes);
      // Embedded art + text tags → sidecar files the listener page
      // displays (file metadata is authoritative over plugin-sent fields).
      // Clear stale sidecars first (a re-upload may carry different data).
      const meta = extractTagData(bytes);
      for (const side of artSidecars(safe)) {
        if (meta.art && side === `${safe}.art${meta.art.ext}`) {
          await writeFile(join(MEDIA_DIR, side), meta.art.data);
          console.log(`  art → ${side} (${meta.art.data.length}B)`);
        } else if (meta.tags && side === `${safe}.tags.json`) {
          await writeFile(join(MEDIA_DIR, side), JSON.stringify(meta.tags));
          console.log(`  tags → ${side}`);
        } else {
          await unlink(join(MEDIA_DIR, side)).catch(() => {});
        }
      }
      console.log(`PUT /media/${safe} (${bytes.length}B)`);
      return json(res, 200, { stored: safe, bytes: bytes.length });
    }

    // DELETE /media/<name> — the plugin drops played tracks off disk when it
    // evicts them from the room queue. Idempotent: a missing file is a no-op.
    if (req.method === "DELETE" && fileName) {
      if (!authed(req)) return json(res, 401, { error: "unauthorized" });
      const safe = safeName(fileName);
      if (!safe) return json(res, 400, { error: "unsupported audio filename" });
      try {
        await unlink(join(MEDIA_DIR, safe));
        for (const side of artSidecars(safe)) {
          await unlink(join(MEDIA_DIR, side)).catch(() => {});
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      console.log(`DELETE /media/${safe}`);
      return json(res, 200, { deleted: safe });
    }

    if ((req.method === "GET" || req.method === "HEAD") && fileName) {
      const safe = safeName(fileName);
      // Metadata sidecars aren't audio — match <file>.art.jpg|png|tags.json.
      const artRaw = basename(decodeURIComponent(fileName));
      const artSafe = /\.(art\.(jpe?g|png)|tags\.json)$/i.test(artRaw) && !/[^\w.() \-']/.test(artRaw)
        ? artRaw
        : null;
      if (!safe && !artSafe) return json(res, 404, { error: "not found" });
      const name = safe ?? artSafe!;
      const file = join(MEDIA_DIR, name);
      const mime = (artSafe ? STATIC_MIME : MIME)[extname(name).toLowerCase()] ?? "application/octet-stream";
      if (req.method === "HEAD") {
        const s = await stat(file);
        return res
          .writeHead(200, {
            "Content-Type": mime,
            "Content-Length": s.size,
            "Cache-Control": "public, max-age=3600, immutable",
          })
          .end();
      }
      const data = await readFile(file);
      res
        .writeHead(200, {
          "Content-Type": mime,
          "Content-Length": data.length,
          "Cache-Control": "public, max-age=3600, immutable",
        })
        .end(data);
      return;
    }

    // SPA fallback — serves the listener page + /settings on this LAN port
    // when WEB_DIST points at the Vite build output. Same-origin /config PUTs.
    if (WEB_DIST && (req.method === "GET" || req.method === "HEAD")) {
      const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
      let file = join(WEB_DIST, rel);
      if (!file.startsWith(WEB_DIST + sep) && file !== WEB_DIST) {
        return json(res, 403, { error: "forbidden" });
      }
      const s = await stat(file).catch(() => null);
      if (!s?.isFile()) {
        file = join(WEB_DIST, "index.html"); // client-side routes, e.g. /settings
      }
      const data = await readFile(file);
      return res
        .writeHead(200, {
          "Content-Type": STATIC_MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
          "Content-Length": data.length,
        })
        .end(req.method === "HEAD" ? undefined : data);
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
    json(res, code, { error: String(e) });
  }
}).listen(PORT, () => console.log(`ingest on :${PORT} → ${MEDIA_DIR}`));
