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
[MCP](#mcp-servers) tools. No cloud, no API keys, no data leaves your machine.

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
  reasoning-effort selector, and token/model stats.
- **MCP tool calling** — connect external MCP servers; the LLM calls their tools
  automatically (graceful degradation when the backend lacks function-calling).
- **100% local** — audio, inference, and chat stay on your hardware.
- **GPU accelerated** — runs `faster-whisper` via the `linuxserver/faster-whisper` image.
- **Tunable model** — swap in any faster-whisper model (default: `large-v3-turbo`, German-tuned).
- **Full Whisper control** — temperature, beam size, VAD, hotwords, thresholds, and more, editable live from the UI.
- **Badword filtering** — strip unwanted words from the transcript server-side.
- **i18n** — English, German, Italian.
- **Dark / light theme** — toggle in the top bar.
- **Docker Compose** — one command to bring up the whole stack.

## Screenshots

<p align="center">
  <img src=".docs/screenshots/chat-dark.png" alt="vui-web — Chat (dark theme)" width="900">
</p>


## Tech stack

| Layer     | Tech |
|-----------|------|
| Frontend  | React 19, Vite 8, JavaScript (no TypeScript), `react-router-dom`, `i18next`, `lucide-react`, `react-markdown` |
| Server    | Node.js 20+, Express 5, `ws` (WebSocket), Wyoming client (raw TCP), `@modelcontextprotocol/client`, `axios` |
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
| `TTS_HOST` | `vui-tts` | Host of the optional TTS service |
| `TTS_PORT` | `8080` | Port of the optional TTS service |
| `VITE_WS_HOST` | `localhost` | Host the browser uses for the WebSocket connection |

> **Note:** Whisper transcription parameters (temperature, beam size, VAD, hotwords,
> badwords, …) and LLM settings are **not** set via `.env` in normal use — they are
> managed at runtime through the in-app **Settings** panel and persisted to
> `server/config.json`. The `WHISPER_*` / `LLM_*` env vars act as initial defaults only.

### Settings panel

Open the gear icon in the top bar to tune the model live. Changes apply immediately
(no restart) for most parameters. Sections:

- **Basis** — language, temperature, prompt, translate-to-English, Whisper host/port
- **Decoding** — beam size, best-of, patience, length/repetition penalties
- **Schwellwerte** — compression-ratio / log-prob / no-speech thresholds
- **Kontext** — initial prompt, hotwords
- **VAD** — voice-activity-detection filter + parameters
- **LLM** — API type, host, port, model, system prompt
- **Badwords** — words to strip from the transcript
- **MCP** — external MCP servers (see [MCP servers](#mcp-servers))
- **UI** — roundness + primary color (frontend-only, saved locally in the browser)

## MCP servers

The server can connect to external MCP servers (Streamable HTTP / SSE) and expose
their tools to the LLM. Servers are configured at runtime in the **Settings** panel
(MCP tab) and persisted to `server/config.json` under `mcpServers` — **no compose
change is required**.

<p align="center">
  <img src=".docs/screenshots/settings-mcp-dark.png" alt="vui-web — Settings - MCP (dark theme)" width="900">
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

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/health` | Health check → `{ status: 'ok' }` |
| `GET`  | `/api/settings` | Read current Whisper + LLM settings + badwords |
| `PUT`  | `/api/settings` | Update settings (validated, persisted to `config.json`) |
| `POST` | `/api/chat` | Non-streaming LLM chat (JSON in/out) |
| `POST` | `/api/chat/stream` | Streaming LLM chat (SSE out; events: `token`, `tool_call`, `tool_result`, `done`, `error`) |
| `WS`   | `/transcribe` | Live transcription stream (binary PCM in, JSON text out) |
| `GET`  | `/api/mcp/servers` | List MCP servers + connection status |
| `POST` | `/api/mcp/servers` | Add an MCP server (ID generated from name) |
| `PUT`  | `/api/mcp/servers/:id` | Update an MCP server (partial) |
| `DELETE` | `/api/mcp/servers/:id` | Remove an MCP server |
| `POST` | `/api/mcp/servers/:id/reconnect` | Reconnect an MCP server |
| `GET`  | `/api/mcp/servers/:id/tools` | List tools exposed by a server |
| `GET`  | `/api/mcp/capability` | Check if the LLM backend supports function-calling |
| `POST` | `/api/mcp/call` | Direct tool call (debug) |

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
  │  POST /api/chat/stream  (JSON: question, history)
  │  SSE  ◄────────────────────────────────────────►  Node.js server (Express 5)
  │                                                 │
  │                                                 ├─► Llm (axios)
  │                                                 │      │  OpenAI-compatible / Ollama API
  │                                                 │      ▼
  │                                                 │   LLM backend (local GPU)
  │                                                 │
  │                                                 ├─► McpManager
  │                                                 │      │  Streamable HTTP / SSE
  │                                                 │      ▼
  │                                                 │   MCP servers (tools)
  └─────────────────────────────────────────────────┘
```

1. The user types a question in the chat page.
2. The server builds the message list (system prompt → history → question) and calls
   the LLM backend via its OpenAI-compatible or Ollama API.
3. If MCP tools are connected and the backend supports function-calling, the server
   runs a **tool loop**: the LLM requests tool calls → the server executes them via
   the MCP manager → results are appended → the LLM continues, up to 10 turns.
4. Tokens are streamed back as **SSE events** (`token`, `tool_call`, `tool_result`,
   `done`) and rendered live with Markdown.

### Tests

```bash
cd server && npm test          # vitest (config, LLM, MCP, router)
cd frontend && npm test        # vitest (hooks)
```

## All Screenshots

| Screen | Dark | Light |
|--------|------|-------|
| Transcription | <img src=".docs/screenshots/transcription-dark.png" alt="Transcription (dark)" width="360"> | <img src=".docs/screenshots/transcription-light.png" alt="Transcription (light)" width="360"> |
| Chat | <img src=".docs/screenshots/chat-dark.png" alt="Chat (dark)" width="360"> | <img src=".docs/screenshots/chat-light.png" alt="Chat (light)" width="360"> |
| Settings — Basic | <img src=".docs/screenshots/settings-basic-dark.png" alt="Settings Basic (dark)" width="360"> | <img src=".docs/screenshots/settings-basic-light.png" alt="Settings Basic (light)" width="360"> |
| Settings — Decoding | <img src=".docs/screenshots/settings-decoding-dark.png" alt="Settings Decoding (dark)" width="360"> | <img src=".docs/screenshots/settings-decoding-light.png" alt="Settings Decoding (light)" width="360"> |
| Settings — Thresholds | <img src=".docs/screenshots/settings-thresholds-dark.png" alt="Settings Thresholds (dark)" width="360"> | <img src=".docs/screenshots/settings-thresholds-light.png" alt="Settings Thresholds (light)" width="360"> |
| Settings — Context | <img src=".docs/screenshots/settings-context-dark.png" alt="Settings Context (dark)" width="360"> | <img src=".docs/screenshots/settings-context-light.png" alt="Settings Context (light)" width="360"> |
| Settings — VAD | <img src=".docs/screenshots/settings-voice-activity-detection-dark.png" alt="Settings VAD (dark)" width="360"> | <img src=".docs/screenshots/settings-voice-activity-detection-light.png" alt="Settings VAD (light)" width="360"> |
| Settings — LLM | <img src=".docs/screenshots/settings-llm-dark.png" alt="Settings LLM (dark)" width="360"> | <img src=".docs/screenshots/settings-llm-light.png" alt="Settings LLM (light)" width="360"> |
| Settings — Badwords | <img src=".docs/screenshots/settings-badwords-dark.png" alt="Settings Badwords (dark)" width="360"> | <img src=".docs/screenshots/settings-badwords-light.png" alt="Settings Badwords (light)" width="360"> |
| Settings — MCP | <img src=".docs/screenshots/settings-mcp-dark.png" alt="Settings MCP (dark)" width="360"> | <img src=".docs/screenshots/settings-mcp-light.png" alt="Settings MCP (light)" width="360"> |
| Settings — MCP Tools | <img src=".docs/screenshots/settings-mcp-tools-dark.png" alt="Settings MCP Tools (dark)" width="360"> | <img src=".docs/screenshots/settings-mcp-tools-light.png" alt="Settings MCP Tools (light)" width="360"> |
| Settings — MCP Tools (Deny) | <img src=".docs/screenshots/settings-mcp-tools-deny-dark.png" alt="Settings MCP Tools Deny (dark)" width="360"> | <img src=".docs/screenshots/settings-mcp-tools-deny-light.png" alt="Settings MCP Tools Deny (light)" width="360"> |
| Settings — UI | <img src=".docs/screenshots/settings-ui-dark.png" alt="Settings UI (dark)" width="360"> | <img src=".docs/screenshots/settings-ui-light.png" alt="Settings UI (light)" width="360"> |

## License

MIT
