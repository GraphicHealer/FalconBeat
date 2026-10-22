/**
 * FalconBeat ingest — LAN-only audio receiver + static media server.
 *
 *   PUT  /media/<filename>    Authorization: Bearer $INGEST_TOKEN → store to MEDIA_DIR
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
import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, normalize, resolve, sep } from "node:path";

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
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

const json = (res: import("node:http").ServerResponse, code: number, body: unknown) =>
  res.writeHead(code, { "Content-Type": "application/json", ...CORS }).end(JSON.stringify(body));

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
      console.log(`PUT /media/${safe} (${bytes.length}B)`);
      return json(res, 200, { stored: safe, bytes: bytes.length });
    }

    if ((req.method === "GET" || req.method === "HEAD") && fileName) {
      const safe = safeName(fileName);
      if (!safe) return json(res, 404, { error: "not found" });
      const file = join(MEDIA_DIR, safe);
      if (req.method === "HEAD") {
        const s = await stat(file);
        return res
          .writeHead(200, {
            "Content-Type": MIME[extname(safe).toLowerCase()],
            "Content-Length": s.size,
            "Cache-Control": "public, max-age=3600, immutable",
          })
          .end();
      }
      const data = await readFile(file);
      res
        .writeHead(200, {
          "Content-Type": MIME[extname(safe).toLowerCase()],
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
