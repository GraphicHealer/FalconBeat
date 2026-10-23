import { useEffect, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { DEFAULT_SHOW, fetchShow, type ShowConfig, type ShowLink } from "./show";

const LS_INGEST = "falconbeat.ingestUrl";
const LS_TOKEN = "falconbeat.ingestToken";

// /settings is only reachable on the LAN (the edge 404s it for public
// visitors), and the edge proxies /config PUTs to ingest — so same-origin
// is always the right ingest endpoint.
const defaultIngest = () => localStorage.getItem(LS_INGEST) ?? location.origin;

/** QR for signage/handouts — renders the encoded URL to a canvas. */
function QrCode({ text }: { text: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const qr = qrcode(0, "M"); // type-0 = auto-size, M = ~15% error correction
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4; // required quiet zone, in modules
    const scale = 6;
    canvas.width = canvas.height = (n + quiet * 2) * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#000000";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
  }, [text]);
  return <canvas ref={ref} className="qr-canvas" aria-label={`QR code linking to ${text}`} />;
}

/**
 * Operator settings page (/settings). Edits show.json via ingest — open it
 * on the show network at http://falconbeat-host:<port>/settings. The token
 * is stored in this browser's localStorage.
 */
export default function Settings() {
  const [ingestUrl, setIngestUrl] = useState(defaultIngest);
  const [token, setToken] = useState(() => localStorage.getItem(LS_TOKEN) ?? "");
  const [cfg, setCfg] = useState<ShowConfig>(DEFAULT_SHOW);
  const [status, setStatus] = useState<string>("");

  useEffect(() => {
    void fetchShow().then(setCfg);
  }, []);

  const set = (patch: Partial<ShowConfig>) => setCfg((c) => ({ ...c, ...patch }));

  const setLink = (i: number, patch: Partial<ShowLink>) =>
    set({ links: cfg.links.map((l, j) => (j === i ? { ...l, ...patch } : l)) });

  // What the QR encodes — the public URL once configured, else the address
  // the settings page itself was reached on (useful for LAN testing).
  const qrTarget = (cfg.publicUrl ?? "").trim() || location.origin;

  const save = async () => {
    if (!token) {
      setStatus("Enter the token first — it's the FALCONBEAT_TOKEN env on the server.");
      return;
    }
    setStatus("Saving…");
    localStorage.setItem(LS_INGEST, ingestUrl);
    localStorage.setItem(LS_TOKEN, token);
    try {
      const res = await fetch(`${ingestUrl}/config/show`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(cfg),
      });
      setStatus(res.ok ? "Saved — the page will pick it up on next load." : `Failed: HTTP ${res.status}`);
    } catch (e) {
      setStatus(`Failed: ${e instanceof Error ? e.message : String(e)} — check the ingest URL (must be reachable on this LAN)`);
    }
  };

  return (
    <main className="page settings">
      <header className="brand">
        <h1 className="settings-title">Show Settings</h1>
        <p className="tagline">What visitors see on the listener page</p>
      </header>

      <section className="form">
        <h2 className="form-h">Server connection</h2>
        <label>
          Server URL
          <input value={ingestUrl} onChange={(e) => setIngestUrl(e.target.value)} placeholder="http://falconbeat-host:8000" />
        </label>
        <label>
          Token
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
        </label>

        <h2 className="form-h">Show info</h2>
        <label>
          Show name
          <input value={cfg.showName} onChange={(e) => set({ showName: e.target.value })} />
        </label>
        <label>
          Tagline
          <input value={cfg.tagline ?? ""} onChange={(e) => set({ tagline: e.target.value })} />
        </label>
        <label>
          Hosted by (optional)
          <input value={cfg.hostedBy ?? ""} onChange={(e) => set({ hostedBy: e.target.value })} placeholder="The Smith Family" />
        </label>
        <label>
          Description
          <textarea rows={3} value={cfg.description ?? ""} onChange={(e) => set({ description: e.target.value })} />
        </label>
        <label>
          Schedule
          <input value={cfg.schedule ?? ""} onChange={(e) => set({ schedule: e.target.value })} placeholder="Nightly 6–11pm, Nov 28 – Jan 1" />
        </label>
        <label>
          Location (optional)
          <input value={cfg.location ?? ""} onChange={(e) => set({ location: e.target.value })} />
        </label>

        <h2 className="form-h">
          Links{" "}
          <button type="button" className="mini-btn" onClick={() => set({ links: [...cfg.links, { label: "", url: "" }] })}>
            + add
          </button>
        </h2>
        {cfg.links.map((link, i) => (
          <div className="link-row" key={i}>
            <input value={link.label} onChange={(e) => setLink(i, { label: e.target.value })} placeholder="Label" />
            <input value={link.url} onChange={(e) => setLink(i, { url: e.target.value })} placeholder="https://…" />
            <button type="button" className="mini-btn" onClick={() => set({ links: cfg.links.filter((_, j) => j !== i) })}>
              ×
            </button>
          </div>
        ))}

        <h2 className="form-h">Share</h2>
        <label>
          Public listener URL
          <input
            value={cfg.publicUrl ?? ""}
            onChange={(e) => set({ publicUrl: e.target.value })}
            placeholder="https://lights.example.com"
          />
        </label>
        <div className="qr-wrap">
          <QrCode text={qrTarget} />
          <p className="qr-caption">{qrTarget}</p>
          <p className="qr-hint">
            {cfg.publicUrl
              ? "Print or screenshot this for signage — it opens your public listener page."
              : "Showing this server's LAN address — set the public URL above so the QR works from cellular."}
          </p>
        </div>

        <button className="listen-btn save-btn" onClick={() => void save()}>
          Save
        </button>
        {status && <p className="save-status">{status}</p>}
        <p className="hint-inline">
          <a href="/">← back to listener page</a>
        </p>
      </section>
    </main>
  );
}
