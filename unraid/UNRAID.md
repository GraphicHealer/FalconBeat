# Installing FalconBeat on Unraid

FalconBeat ships as a single all-in-one image (`ghcr.io/graphichealer/falconbeat`).
This folder contains an Unraid Docker template (`my-FalconBeat.xml`) that wires up
its ports, media volume, and secrets.

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
| Creator Secret | A long random string. Paste the **same value** into the plugin's *Creator Secret* field |
| Ingest Token | A different long random string → plugin's *Ingest Token* field |
| Media Directory | Defaults to `/mnt/user/appdata/falconbeat/media` — fine for most setups |

Generate secrets: `openssl rand -hex 32` (or any password manager).

## Ports

| Template field | Container | Keep it |
|---|---|---|
| WebUI Port | 80 | This is the **public edge** — point your Cloudflare Tunnel at `http://<unraid-ip>:8000` |
| BeatSync Admin/API | 8080 | **LAN only** — needed by the FPP plugin, never expose it |
| Ingest | 8090 | **LAN only** — plugin pushes audio here, never expose it |

The container must be on the **same LAN** as your FPP controller — the plugin
reaches `:8080` and `:8090` directly, no tunnel.

The show-settings page (name, schedule, links — what visitors see) is at
`http://<unraid-ip>:8090/settings`, served by the internal ingest service so it
stays LAN-only. It'll ask for the Ingest Token once and remember it in the
browser.

## Public ingress

Devices need HTTPS (WebAudio/WSS), so put a Cloudflare Tunnel in front of the
WebUI port — run cloudflared from Community Apps on Unraid, or on any host on the
LAN, with ingress `falconbeat.yourdomain.com → http://<unraid-ip>:8000`.

## Plugin settings (FPP → Content Setup → FalconBeat)

- BeatSync WS URL: `ws://<unraid-ip>:8080`
- Ingest URL: `http://<unraid-ip>:8090`
- Creator Secret / Ingest Token: the same values from the template
- Public Media URL: `https://falconbeat.yourdomain.com/media` (must end in `/media`)
- Room ID: `000000`
