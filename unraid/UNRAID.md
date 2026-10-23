# Installing FalconBeat on Unraid

FalconBeat ships as a single all-in-one image (`ghcr.io/graphichealer/falconbeat`).
This folder contains an Unraid Docker template (`my-FalconBeat.xml`) that wires up
its port, media volume, and token.

## Install the template

Unraid loads user templates from the flash drive at:

```
/boot/config/plugins/dockerMan/templates-user/
```

Copy `my-FalconBeat.xml` there. Either:

- **Via the flash share** — copy the file to
  `\\TOWER\flash\config\plugins\dockerMan\templates-user\my-FalconBeat.xml`
  (replace `TOWER` with your server name), or
- **Via SSH** —
  ```bash
  curl -o /boot/config/plugins/dockerMan/templates-user/my-FalconBeat.xml \
    https://raw.githubusercontent.com/GraphicHealer/FalconBeat/main/unraid/my-FalconBeat.xml
  ```

Then: **Docker tab → Add Container → Template: FalconBeat → Apply.**

## Required settings

| Field | What to put |
|---|---|
| FalconBeat Token | A long random string — the **one** shared secret (plugin admin auth, ingest Bearer, `/upload/complete` gate). Paste the same value into the plugin's *Token* field |
| Media Directory | Defaults to `/mnt/user/appdata/falconbeat/media` — fine for most setups |

Generate a token: `openssl rand -hex 32` (or any password manager).

## Ports

There's exactly one: the **WebUI Port** (default `8000` → container `80`).
Point your Cloudflare Tunnel at `http://<unraid-ip>:8000` — and give the FPP
plugin the same address as its FalconBeat URL. It carries everything: the
listener page, `/media` audio, the `/ws` WebSocket, and the token-gated
ingest/upload routes the plugin uses. BeatSync's `:8080` and ingest's
`:8090` stay inside the container.

The container must be on the **same LAN** as your FPP controller — the
plugin reaches it directly, no tunnel.

The show-settings page (name, schedule, links — what visitors see) is at
`http://<unraid-ip>:8000/settings` — LAN addresses only; tunneled visitors
get a 404. It'll ask for the FalconBeat Token once and remember it in the
browser.

## Public ingress

Devices need HTTPS (WebAudio/WSS), so put a Cloudflare Tunnel in front of the
WebUI port — run cloudflared from Community Apps on Unraid, or on any host on the
LAN, with ingress `falconbeat.yourdomain.com → http://<unraid-ip>:8000`.

## Plugin settings (FPP → Content Setup → FalconBeat)

- FalconBeat URL: `http://<unraid-ip>:8000`
- Token: the same value as the template's FalconBeat Token
- Everything else (room, media URLs) is derived automatically — only the
  timing knobs remain optional
