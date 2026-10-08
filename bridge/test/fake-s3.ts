/**
 * Minimal fake S3 for local non-demo testing. Serves PUT/GET on
 * /{bucket}/{key}; ListObjectsV2/DELETE return empty-success XML so the
 * server's BackupManager/cleanup calls fail softly instead of crashing tests.
 *
 *   node test/fake-s3.ts   # listens on :9000
 */
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "s3-data");

const EMPTY_LIST = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>false</IsTruncated></ListBucketResult>`;

createServer(async (req, res) => {
  const key = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname).replace(/^\/+/, "");
  const file = join(ROOT, key);

  try {
    if (req.url?.includes("list-type")) {
      res.writeHead(200, { "Content-Type": "application/xml" }).end(EMPTY_LIST);
      return;
    }
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, Buffer.concat(chunks));
      console.log(`PUT ${key} (${chunks.reduce((n, c) => n + c.length, 0)}B)`);
      res.writeHead(200).end();
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": data.length });
      res.end(req.method === "GET" ? data : undefined);
      console.log(`${req.method} ${key} (${data.length}B)`);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/xml" }).end("<ok/>");
  } catch {
    res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
  }
}).listen(9000, () => console.log("fake-s3 on :9000, storing under", ROOT));
