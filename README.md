<p align='center'>
  <h1 align='center' style='margin-bottom:0px'>vui-web</h1>
  <p align='center'>faster-whisper Web UI + LLM Chat with MCP use</p>
</p>

<p align="center">
  <img src=".docs/badges/stack.png" alt="stack | node.js 20+" height="20">
  <img src=".docs/badges/ui.png" alt="ui | vite + react 19" height="20">
  <img src=".docs/badges/whisper.png" alt="whisper | faster-whisper" height="20">
  <img src=".docs/badges/model.png" alt="model | large-v3-turbo" height="20">
  <img src=".docs/badges/gpu.png" alt="gpu | nvidia" height="20">
  <img src=".docs/badges/lang.png" alt="lang | deutsch" height="20">
  <img src=".docs/badges/realtime.png" alt="realtime | live" height="20">
  <img src=".docs/badges/docker.png" alt="docker | compose" height="20">
  <img src=".docs/badges/bugs.png" alt="bugs | 0 (probably)" height="20">
  <img src=".docs/badges/tests.png" alt="tests | vibes" height="20">
  <img src=".docs/badges/cloud.png" alt="cloud | nein danke" height="20">
  <img src=".docs/badges/uptime.png" alt="uptime | since last restart" height="20">
  <img src=".docs/badges/coffee.png" alt="coffee | unendlich" height="20">
  <img src=".docs/badges/docs.png" alt="docs | this README" height="20">
  <img src=".docs/badges/typescript.png" alt="typescript | nein danke" height="20">
  <img src=".docs/badges/works.png" alt="works on my machine | yes" height="20">
  <img src=".docs/badges/sync-hope.png" alt="sync | on push, not on hope" height="20">
  <img src=".docs/badges/vectors.png" alt="vectors | 100% local" height="20">
  <img src=".docs/badges/api-keys.png" alt="api keys | 0" height="20">
  <img src=".docs/badges/playwright.png" alt="playwright | coming soon" height="20">
  <img src=".docs/badges/status.png" alt="status | it works™" height="20">
</p>

---

**vui-web** is a self-hosted, real-time speech-to-text web app with an integrated
LLM chat. It captures your microphone in the browser, streams raw audio to a local
Node.js server, and transcribes it with [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
running on your own GPU. A built-in chat page talks to any Ollama or
OpenAI-compatible LLM backend (llama.cpp, LM Studio, …) and can call external
[MCP](#mcp-servers) tools. A **zero-trust security layer** classifies every tool
call, requires human approval for write/execute actions, and enforces SSRF
protection. No cloud, no API keys, no data leaves your machine.

> AI used locally:
> - Engine: **llama.cpp**
> - Model: **Qwen3.8-27B**
> - Additional Draft Model: **Qwen3.8-27B-DFlash2 (incoai)**
> - Projection Layer (Vision)
> - VS Code
> - Kilo Code Extension (opencode)

## Features

- **Live transcription** — speak, watch the text appear in near real-time.
- **LLM chat** — conversation-based chat with SSE streaming, Markdown rendering,
  reasoning-effort selector, thinking/reasoning blocks, and token/model stats.
- **Conversation history** — multiple conversations stored in `localStorage`,
  browsable via a sidebar, with new/delete support.
- **MCP tool calling** — connect external MCP servers; the LLM calls their tools
  automatically (graceful degradation when the backend lacks function-calling).
- **Zero-trust security** — tool policy engine (read/write/execute/deny),
  human approval flow for write/execute tools, SSRF network guard, untrusted-data
  wrapping, audit log, replay protection, and per-tool call caps.
- **Virtual tools** — built-in server-side tools (`get_config`, `get_mcp`,
  `get_policies`, `get_stats`) that the LLM can call without any MCP server.
- **LLM vision** — optional image understanding: the LLM can request to see
  tool-returned images (`include_image`), gated by model capability detection.
- **Image lightbox** — MCP tool images are persisted to disk and rendered in the
  chat with a full-screen lightbox viewer.
- **100% local** — audio, inference, and chat stay on your hardware.
- **GPU accelerated** — runs `faster-whisper` via the `linuxserver/faster-whisper` image.
- **Tunable model** — swap in any faster-whisper model (default: `large-v3-turbo`, German-tuned).
- **Full Whisper control** — temperature, beam size, VAD, hotwords, thresholds, and more, editable live from the UI.
- **Badword filtering** — strip unwanted words from the transcript server-side.
- **i18n** — English, German, Italian.
- **Dark / light theme** — toggle in the top bar.
- **About page** — personal portfolio page at `/about`.
- **Docker Compose** — one command to bring up the whole stack.

## Screenshots

<p align="center">
  <img src=".docs/screenshots/chat-dark.png" alt="vui-web — Chat (dark theme)" width="900">
</p>


## Tech stack

| Layer     | Tech |
|-----------|------|
| Frontend  | React 19, Vite 8, JavaScript (no TypeScript), `react-router-dom`, `i18next`, `lucide-react`, `react-markdown`, `remark-gfm`, `@tanstack/react-query`, `@lucide/lab` |
| Server    | Node.js 20+, Express 5, `ws` (WebSocket), Wyoming client (raw TCP), `@modelcontextprotocol/client`, `axios`, `yaml` |
| ASR       | `linuxserver/faster-whisper` (GPU), faster-whisper / large-v3-turbo |
| LLM       | Ollama or any OpenAI-compatible API (llama.cpp, LM Studio, …) |
| Runtime   | Docker + Docker Compose, NVIDIA runtime |

## Quick start

### Prerequisites

- Docker + Docker Compose
- An NVIDIA GPU with the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) installed
- *(optional)* An LLM backend (Ollama, llama.cpp, LM Studio, …) for the chat page

### Run

```bash
# 1. Configure
cp ".env default" .env      # then edit .env (model, language, ports, LLM)

# 2. Start the stack
docker compose up -d --build

# 3. Open the UI
#    http://localhost:3000
```

The stack starts two services:

| Service       | What it does |
|---------------|--------------|
| `vui-service` | `faster-whisper` ASR engine (GPU) |
| `vui-server`  | Node.js API + WebSocket bridge + LLM proxy + serves the React app |

> An optional TTS service (`vui-tts`, LocalAI) is commented out in `compose.yml`.

## Configuration

All runtime configuration lives in `.env` (see `.env default` for the full list).

| Variable | Default | Description |
|----------|---------|-------------|
| `SERVER_PORT` | `3000` | Port for the web UI / API |
| `WHISPER_HOST` | `vui-service` | Host of the faster-whisper service |
| `WHISPER_PORT` | `10300` | Wyoming port of the faster-whisper service |
| `WHISPER_LANG` | `de` | Default transcription language |
| `WHISPER_MODEL` | `jimmymeister/whisper-large-v3-turbo-german-ct2` | faster-whisper model to load |
| `LLM_API` | `openai` | LLM backend type: `openai` (OpenAI-compatible) or `ollama` |
| `LLM_HOST` | *(empty)* | Host of the LLM backend |
| `LLM_PORT` | `8080` | Port of the LLM backend |
| `LLM_MODEL` | *(empty)* | Model name / path to use |
| `LLM_SYSTEM_PROMPT` | `You are a helpful assistant…` | System prompt for the chat |
| `LLM_VISION` | `auto` | LLM vision: `auto` (detect), `true` (force on), `false` (force off) |
| `TTS_HOST` | `vui-tts` | Host of the optional TTS service |
| `TTS_PORT` | `8080` | Port of the optional TTS service |
| `VITE_WS_HOST` | `localhost` | Host the browser uses for the WebSocket connection |
| `SECURITY_MAX_TOOL_TURNS` | `10` | Max LLM tool-loop turns per request |
| `SECURITY_MAX_TOOL_CALLS_PER_TOOL` | `2` | Max calls per tool name per request (loop guard) |
| `SECURITY_MAX_TOOL_RESULT_BYTES` | `65536` | Max tool result text size (bytes) |
| `SECURITY_MAX_TOOL_IMAGE_BYTES` | `2097152` | Max tool image size (bytes) |
| `SECURITY_TOOL_TIMEOUT_MS` | `30000` | Tool execution timeout (ms) |
| `SECURITY_MAX_PENDING_ACTIONS` | `20` | Max pending approval actions |
| `SECURITY_APPROVAL_TTL_MS` | `600000` | Approval expiry (ms, default 10 min) |
| `SECURITY_ALLOWED_HOSTS` | `[]` | SSRF host allowlist (JSON array) |

> **Note:** Whisper transcription parameters (temperature, beam size, VAD, hotwords,
> badwords, …), LLM settings, and security parameters are **not** set via `.env` in
> normal use — they are managed at runtime through the in-app **Settings** panel and
> persisted to `server/config.json`. The `WHISPER_*` / `LLM_*` / `SECURITY_*` env
> vars act as initial defaults only.
> Media (image persistence) variables work the same way — see [Media](#media).

### Settings panel

Open the gear icon in the top bar to tune the model live. Changes apply immediately
(no restart) for most parameters. Categories with sub-views:

- **App** — media path, image TTL, storage caps, cleanup interval (see [Media](#media))
- **ASR**
  - **Basic** — language, temperature, prompt, translate-to-English, Whisper host/port
  - **Decoding** — beam size, best-of, patience, length/repetition penalties
  - **Thresholds** — compression-ratio / log-prob / no-speech thresholds
  - **Context** — initial prompt, hotwords
  - **VAD** — voice-activity-detection filter + parameters
  - **Badwords** — words to strip from the transcript
- **LLM**
  - **Connection** — host, port, model, vision (`auto`/`true`/`false`)
  - **Prompt** — system prompt
- **Security**
  - **Tool Policies** — per-tool classification: `read` / `write` / `execute` / `deny` (deny-by-default)
  - **SSRF** — allowed hosts for outbound requests (bypasses private-IP blocking)
  - **Built-in Tools** — toggle virtual tools (`get_config`, `get_mcp`, `get_policies`, `get_stats`)
  - **Limits** — max tool turns, per-tool call cap, result/image size limits, timeout, pending action cap, approval TTL
- **MCP**
  - **Servers** — external MCP servers (see [MCP servers](#mcp-servers))
- **UI** — roundness + primary color (frontend-only, saved locally in the browser)

## Zero-Trust Security

The security layer (`server/src/Security/`) enforces a deny-by-default policy on
every MCP tool call. The LLM can only *propose* tool calls — it cannot execute
them directly. The policy engine is the sole authorization authority.

### Tool classification

Every MCP tool is classified into one of four classes (keyed by
`serverId__toolName`):

| Class | Behavior | Risk |
|-------|----------|------|
| `read` | Executed directly via the Execution Gateway (timeout + size limits) | Low |
| `write` | Requires human approval before execution | Medium |
| `execute` | Requires human approval before execution | High |
| `deny` | Blocked outright (default for unclassified tools) | Blocked |

Policies are configured per-tool in **Settings → Security → Tool Policies** and
persisted to `server/config.json`. Unclassified tools are **denied by default**.

### Approval flow

Write/execute tools follow a state machine:

```
PENDING_APPROVAL ──► APPROVED ──► EXECUTING ──► COMPLETED
       │                │
       ├──► REJECTED    │
       ├──► CANCELLED   │
       └──► EXPIRED     └──► FAILED
```

- **Propose:** the LLM requests a write/execute tool → an action record is created
  with a SHA-256 payload hash, a TTL (default 10 min), and a unique ID.
- **Approve:** the human confirms in the **Approval Dialog** (frontend). The server
  verifies the hash integrity (timing-safe comparison) before transitioning to
  `APPROVED`.
- **Execute:** the Execution Gateway atomically transitions `APPROVED → EXECUTING`
  (replay protection — a second call finds the wrong status and fails), re-checks
  SSRF on any URL arguments, then calls the MCP tool with a timeout.
- **Audit:** every state transition is appended to an append-only JSONL audit log
  (`server/data/audit.jsonl`).

### SSRF Network Guard

Outbound URLs are validated before any MCP tool call:

- Only `http`/`https` protocols (blocks `file:`, `ftp:`, …)
- Blocks loopback, private, link-local (incl. cloud metadata `169.254.169.254`),
  unique-local, and unspecified IP ranges (IPv4 + IPv6)
- Domain names are DNS-resolved and **every** resolved IP is checked
  (DNS-rebinding protection)
- Optional host allowlist (`security.allowedHosts`) for local MCP servers in the LAN
- Fail-closed: invalid IPs, DNS failures, and unknown protocols are blocked

### Untrusted data wrapping

Tool results are wrapped in an `[UNTRUSTED_EXTERNAL_DATA]` marker before entering
the LLM context. This signals to the model that the content is data, not
instructions. The real security boundary is the policy engine + approval flow —
the wrapping is a defense-in-depth heuristic.

### Security system prompt

A security prompt is injected as part of the system message (merged with the user's
system prompt to satisfy backends that require a single system message at position 0).
It instructs the LLM to treat external content as untrusted, never self-approve
actions, and never bypass policy enforcement. This is **not** a security boundary —
it reduces the probability of prompt-injection success.

### Execution Gateway

The only component that can execute MCP tools:

- **Read tools:** direct execution with timeout (default 30 s), text size limit
  (default 64 KB, truncated with notice), and image size limit (default 2 MB,
  oversized images dropped with notice).
- **Approved tools:** atomic `APPROVED → EXECUTING` transition (replay protection),
  SSRF re-check on URL arguments, timeout, image size limit.
- **Per-tool call cap:** each tool name can be called at most N times per request
  (default 2) — prevents infinite tool loops (e.g. `take_screenshot` without vision).

### Audit log

Append-only JSONL at `server/data/audit.jsonl`. Each line:
`{ ts, actionId, event, metadata }`. Events include `ACTION_PROPOSED`,
`ACTION_APPROVED`, `ACTION_REJECTED`, `ACTION_CANCELLED`, `ACTION_EXPIRED`,
`EXECUTION_COMPLETED`, `EXECUTION_FAILED`, `POLICY_DENIED`, `INTEGRITY_FAILURE`.
Readable via `GET /api/audit?limit=N`.

### Security headers

Set on every HTTP response:

| Header | Value |
|--------|-------|
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Security-Policy` | `default-src 'self'` (production only) |

## Virtual Tools

Four built-in tools are resolved server-side (no MCP server, no network, no
policy check). They are injected into the LLM tool list and can be toggled
individually in **Settings → Security → Built-in Tools**:

| Tool | Description |
|------|-------------|
| `get_config` | Returns the current server configuration as structured Markdown (sections: `llm`, `whisper`, `security`, `mcp`, `badwords`, `server`). Sensitive fields (system prompt, MCP headers) are omitted. |
| `get_mcp` | Returns configured MCP servers with settings, connection status, and tool lists. |
| `get_policies` | Returns tool policies (read/write/execute/deny) and the SSRF allowlist. |
| `get_stats` | Returns runtime statistics: uptime, LLM token usage, MCP connections, transcription count. |

## Stats

In-memory collector (resets on server restart, no persistence overhead):

- **LLM:** request count, prompt tokens, completion tokens, total tokens
- **MCP:** configured / connected server count, total tool count
- **Transcriptions:** successful transcription count
- **Server:** start time, uptime

Exposed via the `get_stats` virtual tool and the `done` SSE event (per-turn token
usage).

## MCP servers

The server can connect to external MCP servers (transports: `auto`, `streamable-http`,
`sse`) and expose their tools to the LLM. Servers are configured at runtime in the
**Settings** panel (MCP tab) and persisted to `server/config.json` under `mcpServers`
— **no compose change is required**.

<p align="center">
  <img src=".docs/screenshots/settings-mcp-servers-dark.png" alt="vui-web — Settings - MCP Servers (dark theme)" width="900">
</p>

### Docker networking

The `url` of each MCP server must be reachable **from the `vui-server` container**:

| MCP server location | URL to use |
|---------------------|------------|
| Same Docker network (`vui`) | container name as host, e.g. `http://weather-mcp:8080/mcp` |
| On the Docker host | `http://host.docker.internal:8080/mcp` (already mapped) |
| External / cloud | public URL |

- **Optional:** each MCP server can run as its own Docker service (e.g. `weather-mcp`)
  on the `vui` network, with `depends_on` for start order. Not required — any
  reachable HTTP endpoint works.
- **Auth:** set per-server `headers` (forwarded on every request, e.g.
  `Authorization: Bearer …`), or pass global env vars to `vui-server` and use
  placeholders.
- **No subprocess management** (unlike stdio MCP servers) — `vui-server` only holds
  outbound HTTP/SSE connections.
- **Security:** `headers` may contain secrets. Never hardcode them in `compose.yml`
  or `config.json` — use env vars / placeholders.

### LLM vision support

Each MCP tool schema is augmented with an optional `include_image` boolean argument
that the LLM sees. The LLM decides per call whether it needs to *see* the returned
image. The server strips `include_image` before forwarding to the MCP tool (the tool
never sees it). The image is always shown to the user in the chat regardless.

The image is fed into the LLM context only if:
1. The LLM set `include_image: true`, **and**
2. The model supports vision (detected via Ollama `/api/show` capabilities, or
   forced by `llm.vision` = `true`/`false`).

## Media

MCP tools can return images (e.g. screenshots). The server persists those image
bytes to disk and sends the client a stable URL (`/api/media/:id`) instead of
inline Base64 — so images stay visible after a page reload.

- **Storage:** `server/data/media/images/` by default (override with `MEDIA_DIR`,
  requires a restart). Files are named by UUID, immutable, served with
  `Cache-Control: public, max-age=31536000, immutable`.
- **Config:** env vars (`MEDIA_DIR`, `MEDIA_IMAGE_TTL_DAYS`, `MEDIA_MAX_IMAGES`,
  `MEDIA_MAX_BYTES`, `MEDIA_CLEANUP_INTERVAL_MS`) or the in-app **Settings → App**
  panel (persisted to `server/config.json`). Defaults: TTL 30 days, 500 images,
  500 MB, cleanup every hour. `0` disables a limit.
- **Cleanup:** a background interval deletes oldest-first when the TTL or caps
  are exceeded.
- **Fallback:** if persisting fails (e.g. disk full), the image is sent as inline
  Base64 (legacy format) — the chat still renders it, but it won't survive a reload.
- **Lightbox:** images in the chat are clickable and open in a full-screen
  lightbox viewer.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/health` | Health check → `{ status: 'ok' }` |
| `GET`  | `/api/media/:id` | Fetch a persisted MCP tool image (UUID, immutable) |
| `GET`  | `/api/settings` | Read current Whisper + LLM + Security settings + badwords |
| `PUT`  | `/api/settings` | Update settings (validated, persisted to `config.json`) |
| `POST` | `/api/chat` | Non-streaming LLM chat (JSON in/out) |
| `POST` | `/api/chat/stream` | Streaming LLM chat (SSE out; events: `thinking`, `answer`, `tool_call`, `tool_result`, `approval_required`, `approval_resolved`, `done`, `error`) |
| `WS`   | `/transcribe` | Live transcription stream (binary PCM in, JSON text out) |
| `GET`  | `/api/mcp/servers` | List MCP servers + connection status |
| `POST` | `/api/mcp/servers` | Add an MCP server (ID generated from name) |
| `PUT`  | `/api/mcp/servers/:id` | Update an MCP server (partial) |
| `DELETE` | `/api/mcp/servers/:id` | Remove an MCP server |
| `POST` | `/api/mcp/servers/:id/reconnect` | Reconnect an MCP server |
| `GET`  | `/api/mcp/servers/:id/tools` | List tools exposed by a server |
| `GET`  | `/api/mcp/capability` | Check if the LLM backend supports function-calling |
| `POST` | `/api/mcp/call` | Direct tool call (debug) |
| `GET`  | `/api/actions/pending` | List pending approval actions |
| `GET`  | `/api/actions/:id` | Get a single action (canonical server-side parameters) |
| `POST` | `/api/actions/:id/approve` | Approve + execute an action (hash-verified, replay-protected) |
| `POST` | `/api/actions/:id/reject` | Reject a pending action |
| `POST` | `/api/actions/:id/cancel` | Cancel a pending action |
| `GET`  | `/api/audit` | Read the audit log (`?limit=N`, default 50, max 500) |

## Development

Run the server and frontend locally (outside Docker):

```bash
# Server (Node 20+)
cd server
npm install
npm run dev          # node --watch

# Frontend (Vite)
cd frontend
npm install
npm run dev
```

> In Docker, the server runs the frontend in Vite `middlewareMode` and serves it
> itself — you only ever talk to one port (`SERVER_PORT`).

## How it works

### Transcription

```
Browser (React 19)
  │  getUserMedia → AudioWorklet → 16 kHz mono PCM
  │  WebSocket  ────────────────────────────────►  Node.js server (Express 5)
  │                                                 │
  │  /transcribe  (WS, raw PCM)                     ├─► TranscribeBridge
  │  /api/settings  (GET/PUT)                       │      │  Wyoming protocol (TCP)
  │  /health      (GET)                             │      ▼
  │  /*           (SPA)                             │   faster-whisper (GPU)
  └─────────────────────────────────────────────────┘      │
         ▲                                                  │
         └──────────── JSON { text, isFinal } ◄─────────────┘
```

1. The browser captures microphone audio and resamples it to **16 kHz mono 16-bit PCM**
   using an `AudioWorklet`.
2. PCM chunks are sent over a **WebSocket** (`/transcribe`) to the Node.js server.
3. The server buffers ~2 s of audio and forwards it to the `faster-whisper` service
   using the **Wyoming protocol** (TCP, not HTTP).
4. The transcribed text is streamed back as JSON and rendered live.

### Chat

```
Browser (React 19)
  │  POST /api/chat/stream  (JSON: question, history, reasoning_effort)
  │  SSE  ◄────────────────────────────────────────►  Node.js server (Express 5)
  │                                                 │
  │                                                 ├─► Llm (axios)
  │                                                 │      │  OpenAI-compatible / Ollama API
  │                                                 │      ▼
  │                                                 │   LLM backend (local GPU)
  │                                                 │
  │                                                 ├─► PolicyEngine (classify)
  │                                                 │      │  read / write / execute / deny
  │                                                 │      ▼
  │                                                 ├─► ApprovalService (write/execute)
  │                                                 │      │  PENDING → APPROVED → EXECUTING
  │                                                 │      ▼
  │                                                 ├─► ExecutionGateway (read + approved)
  │                                                 │      │  timeout + size limits
  │                                                 │      ▼
  │                                                 ├─► McpManager
  │                                                 │      │  Streamable HTTP / SSE
  │                                                 │      ▼
  │                                                 │   MCP servers (tools)
  │                                                 │
  │                                                 ├─► VirtualTools (local, no MCP)
  │                                                 │      get_config / get_mcp /
  │                                                 │      get_policies / get_stats
  │                                                 │
  │                                                 └─► Audit (JSONL append-only)
  └─────────────────────────────────────────────────┘
```

1. The user types a question in the chat page.
2. The server builds the message list (security prompt + system prompt → history →
   question) and calls the LLM backend via its OpenAI-compatible or Ollama API.
3. If MCP tools are connected and the backend supports function-calling, the server
   runs a **tool loop** (up to `maxToolTurns`, default 10):
   - The LLM requests tool calls.
   - **Virtual tools** (`get_config`, `get_mcp`, `get_policies`, `get_stats`) are
     resolved locally — no MCP, no policy check.
   - **MCP tools** go through the **Policy Engine**:
     - `deny` → blocked, LLM receives a denial message.
     - `read` → executed via the **Execution Gateway** (timeout + size limits),
       result wrapped as untrusted data.
     - `write` / `execute` → an **approval action** is proposed. The LLM loop
       **stops** and the stream ends. The human approves or rejects in the
       **Approval Dialog**. On approval, the Execution Gateway executes the tool
       (replay-protected, SSRF re-checked).
   - Tool results are appended to the message list; the LLM continues.
   - Per-tool call cap (default 2) prevents infinite loops.
4. Tokens are streamed back as **SSE events** (`thinking`, `answer`, `tool_call`,
   `tool_result`, `approval_required`, `done`) and rendered live with Markdown.
   Thinking/reasoning blocks are collapsible. Images from tool results are
   persisted and rendered with a lightbox.

### Tests

```bash
cd server && npm test          # vitest (config, LLM, MCP, router, security, virtual-tools, media)
cd frontend && npm test        # vitest (hooks, components)
```

## All Screenshots

| Screen | Dark | Light |
|--------|------|-------|
| Transcription | <img src=".docs/screenshots/transcription-dark.png" alt="Transcription (dark)" width="360"> | <img src=".docs/screenshots/transcription-light.png" alt="Transcription (light)" width="360"> |
| Chat | <img src=".docs/screenshots/chat-dark.png" alt="Chat (dark)" width="360"> | <img src=".docs/screenshots/chat-light.png" alt="Chat (light)" width="360"> |
| Chat (2nd round) | <img src=".docs/screenshots/chat2-dark.png" alt="Chat 2nd round (dark)" width="360"> | <img src=".docs/screenshots/chat2-light.png" alt="Chat 2nd round (light)" width="360"> |
| Settings — App | <img src=".docs/screenshots/settings-app-dark.png" alt="Settings App (dark)" width="360"> | <img src=".docs/screenshots/settings-app-light.png" alt="Settings App (light)" width="360"> |
| Settings — ASR Basic | <img src=".docs/screenshots/settings-asr-basic-dark.png" alt="Settings ASR Basic (dark)" width="360"> | <img src=".docs/screenshots/settings-asr-basic-light.png" alt="Settings ASR Basic (light)" width="360"> |
| Settings — ASR Decoding | <img src=".docs/screenshots/settings-asr-decoding-dark.png" alt="Settings ASR Decoding (dark)" width="360"> | <img src=".docs/screenshots/settings-asr-decoding-light.png" alt="Settings ASR Decoding (light)" width="360"> |
| Settings — ASR Thresholds | <img src=".docs/screenshots/settings-asr-thresholds-dark.png" alt="Settings ASR Thresholds (dark)" width="360"> | <img src=".docs/screenshots/settings-asr-thresholds-light.png" alt="Settings ASR Thresholds (light)" width="360"> |
| Settings — ASR Context | <img src=".docs/screenshots/settings-asr-context-dark.png" alt="Settings ASR Context (dark)" width="360"> | <img src=".docs/screenshots/settings-asr-context-light.png" alt="Settings ASR Context (light)" width="360"> |
| Settings — ASR VAD | <img src=".docs/screenshots/settings-asr-vad-dark.png" alt="Settings ASR VAD (dark)" width="360"> | <img src=".docs/screenshots/settings-asr-vad-light.png" alt="Settings ASR VAD (light)" width="360"> |
| Settings — ASR Badwords | <img src=".docs/screenshots/settings-asr-badwords-dark.png" alt="Settings ASR Badwords (dark)" width="360"> | <img src=".docs/screenshots/settings-asr-badwords-light.png" alt="Settings ASR Badwords (light)" width="360"> |
| Settings — LLM Connection | <img src=".docs/screenshots/settings-llm-connection-dark.png" alt="Settings LLM Connection (dark)" width="360"> | <img src=".docs/screenshots/settings-llm-connection-light.png" alt="Settings LLM Connection (light)" width="360"> |
| Settings — LLM Prompt | <img src=".docs/screenshots/settings-llm-prompt-dark.png" alt="Settings LLM Prompt (dark)" width="360"> | <img src=".docs/screenshots/settings-llm-prompt-light.png" alt="Settings LLM Prompt (light)" width="360"> |
| Settings — LLM Security | <img src=".docs/screenshots/settings-llm-security-dark.png" alt="Settings LLM Security (dark)" width="360"> | <img src=".docs/screenshots/settings-llm-security-light.png" alt="Settings LLM Security (light)" width="360"> |
| Settings — MCP Servers | <img src=".docs/screenshots/settings-mcp-servers-dark.png" alt="Settings MCP Servers (dark)" width="360"> | <img src=".docs/screenshots/settings-mcp-servers-light.png" alt="Settings MCP Servers (light)" width="360"> |
| Settings — MCP Tools | <img src=".docs/screenshots/settings-mcp-tools-dark.png" alt="Settings MCP Tools (dark)" width="360"> | <img src=".docs/screenshots/settings-mcp-tools-light.png" alt="Settings MCP Tools (light)" width="360"> |
| Settings — MCP Tools (Deny) | <img src=".docs/screenshots/settings-mcp-tools-deny-dark.png" alt="Settings MCP Tools Deny (dark)" width="360"> | <img src=".docs/screenshots/settings-mcp-tools-deny-light.png" alt="Settings MCP Tools Deny (light)" width="360"> |
| Settings — MCP Built-in Tools | <img src=".docs/screenshots/settings-mcp-builtin-dark.png" alt="Settings MCP Built-in Tools (dark)" width="360"> | <img src=".docs/screenshots/settings-mcp-builtin-light.png" alt="Settings MCP Built-in Tools (light)" width="360"> |
| Settings — MCP SSRF | <img src=".docs/screenshots/settings-mcp-ssrf-dark.png" alt="Settings MCP SSRF (dark)" width="360"> | <img src=".docs/screenshots/settings-mcp-ssrf-light.png" alt="Settings MCP SSRF (light)" width="360"> |
| Settings — UI | <img src=".docs/screenshots/settings-ui-dark.png" alt="Settings UI (dark)" width="360"> | <img src=".docs/screenshots/settings-ui-light.png" alt="Settings UI (light)" width="360"> |

## License

MIT
