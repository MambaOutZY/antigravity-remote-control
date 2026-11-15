# AGY Remote Control (Self-Hosted Web Console & Context Viewer)

[中文](./README.md) | [English](./README_EN.md)

> A zero-dependency Antigravity private Web Console built with native Node.js >= 20: run it on your home Ubuntu host, reuse 100% of your local `agy` CLI authentication and subscription quota, and remotely control sessions, resume conversations, paste screenshots, and audit context & API-equivalent usage from any browser over HTTPS (port 443).

---

## 1. Key Features

1. **Native-Like Remote Control Experience**
   - Responsive three-column workspace (Dark / Light theme toggle, mobile drawer), zero external CDN dependencies for instant loading in restricted/no-proxy corporate networks.
   - Real-time `POST /api/chat/stream` SSE streaming: collapsible **Thinking** cards, **Tool Calls** status cards, safe Markdown rendering with one-click code copy, and instant Stop/abort support.
   - Switch `--model`, `--effort` (`low / medium / high / xhigh / max`), `--mode` (`auto / accept-edits / plan`), and `--dangerously-skip-permissions`, with live CLI command preview, workspace file browser, and `Git Diff` inspection.

2. **100% Reuse of `agy` Account Quota & Session History**
   - Spawns your host's authenticated `agy` (or `agy-real`) CLI directly, inheriting `~/.gemini/` credentials and subscription quota with no third-party relay.
   - Automatically scans `transcript.jsonl` under `~/.gemini/antigravity` (Desktop) and `~/.gemini/antigravity-cli` (CLI) to list and seamlessly resume any historical session via `--conversation <id>`.
   - Gracefully degrades to a local demo/audit mode when `agy` is not installed (e.g., on Windows dev machines).

3. **Integrated Context Viewer (Dual Top-Bar Pills)**
   - **Pill 1 (Context & Speed)**: SVG progress ring (`Used K / Budget K`), live `TTFT` & `TPS`, 8-category smart error diagnostics, 5-dimension context breakdown, image pixel/tile token audit, and **256K context window gate unlock/restore** (with automatic `.bak` backup).
   - **Pill 2 (Token History & API Bill)**: Filter by `All / CLI / Desktop`, view Today / Month / Year / Total tokens, **52-week calendar heatmap**, 7-day bar chart, per-model median TPS/TTFT comparison, and API-equivalent cost in USD/CNY vs. `$20/mo` Pro subscription.

4. **Paste Screenshots Directly (`Ctrl+V`)**
   - Paste images from clipboard, drag-and-drop, or pick files (PNG / JPEG / GIF / BMP, up to 15 MB).
   - Saves images to `<workspace>/.agy_uploads/`, parses dimensions and tile tokens, and passes `--add-dir` + file path hints so `agy` can inspect them via `read_file`.

5. **Zero External Dependencies & Lightweight Auth**
   - Backend uses only Node.js >= 20 built-in modules (`http`, `fs`, `path`, `os`, `crypto`, `child_process`, `url`) — no `npm install` required.
   - Setting `AGY_AUTH_PASSWORD` enables full-site authentication (`HttpOnly` Cookie + HMAC-SHA256 / `x-agy-token`).

---

## 2. Project Structure

```text
antigravity-remote-control/
├── package.json                  # Zero-dependency metadata & scripts (Node >= 20)
├── server.js                     # HTTP server, static hosting, auth & API/SSE routes
├── lib/
│   ├── meter-engine.js           # CJK/image token estimator, error classifier, heatmap & billing
│   ├── context-unlock-bridge.js  # agy binary 256K gate detection, backup, unlock & restore
│   └── agy-runner.js             # agy CLI detection, stream-json runner, Git workspace check
├── public/                       # Pure static frontend (zero external CDNs)
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── deploy/
│   ├── install-ubuntu.sh         # Ubuntu 20.04/22.04/24.04 one-click setup script
│   └── agy-remote.service        # systemd service template
├── test/
│   └── smoke.test.js             # Built-in node:test smoke tests
├── LICENSE                       # MIT License
├── README.md                     # Chinese documentation
└── README_EN.md                  # English documentation
```

---

## 3. Quick Start & Ubuntu Deployment

### Prerequisites
1. **Node.js >= 20.0.0**
2. **`agy` CLI installed and logged in** under the same Linux user that runs this service (do **not** run as `root` unless `~/.gemini/` belongs to `root`).

### Local Preview (Linux / macOS / Windows)

```bash
# Linux / macOS
PORT=8787 AGY_AUTH_PASSWORD="your-strong-password" node server.js
```

```powershell
# Windows PowerShell
$env:PORT="8787"
$env:AGY_AUTH_PASSWORD="your-strong-password"
node server.js
```

Open `http://127.0.0.1:8787` in your browser.

### One-Click Ubuntu Deployment (`systemd --user`)

```bash
cd /path/to/antigravity-remote-control
chmod +x deploy/install-ubuntu.sh
bash deploy/install-ubuntu.sh
```

Non-interactive mode is also supported:

```bash
HOST=0.0.0.0 \
PORT=8787 \
AGY_AUTH_PASSWORD='your-strong-password' \
DEFAULT_WORKSPACE="$HOME/workspace" \
SERVICE_MODE=user \
bash deploy/install-ubuntu.sh
```

Common service commands:

```bash
systemctl --user status agy-remote.service
journalctl --user -u agy-remote.service -f
systemctl --user restart agy-remote.service
curl -s http://127.0.0.1:8787/api/health
```

---

## 4. Remote Access via Reverse Proxy / Tunnel

- **Option A (Reverse Proxy with Public IP, e.g., Lucky / Nginx)**: Enable HTTPS (TLS), disable response buffering (`proxy_buffering off;`, `X-Accel-Buffering: no`) so SSE streams smoothly without stalling, and enable `AGY_AUTH_PASSWORD`.
- **Option B (No Public IP / Corporate Port 443 Only)**: Use **Cloudflare Tunnel (`cloudflared`)** pointing to `http://127.0.0.1:8787` and protect the hostname with **Cloudflare Zero Trust Access** (One-Time PIN email allowlist).

> **Security Warning**: Never expose port `8787` directly to the public internet over plain HTTP.

---

## 5. Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `HOST` | `0.0.0.0` | HTTP bind address |
| `PORT` | `8787` | HTTP listen port |
| `AGY_AUTH_PASSWORD` | Empty (disabled) | Web login password (enables HMAC-SHA256 Cookie/token auth) |
| `DEFAULT_WORKSPACE` | CWD / Home dir | Default workspace path shown in the UI |
| `AGY_BIN` | Auto-detect | Explicit path to `agy` or `agy-real` executable |
| `AG_DIR` | `~/.gemini/antigravity` | Override Desktop session logs directory |
| `AG_CLI_DIR` | `~/.gemini/antigravity-cli` | Override CLI session logs directory |

---

## 6. Testing & License

Run the built-in smoke tests (zero external dependencies):

```bash
npm test
# or
node --test test/smoke.test.js
```

Licensed under the [MIT License](./LICENSE).
