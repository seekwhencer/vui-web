# PLAN: MCP-Client-Anbindung für VUI

## Ziel

Anbindung von **beliebig vielen MCP-Servern** (HTTP/SSE-Transport) an den VUI-Server.

- Die MCP-Server werden **über die Settings-UI konfiguriert** (Add / Edit / Delete, Enable/Disable, Status, Tool-Liste).
- Die Tools aller verbundenen MCP-Server werden dem **LLM im Chat als Function-Tools** bereitgestellt.
- Der **Server führt die Tool-Calls aus** (OpenAI-Function-Calling-Loop) und gibt die Ergebnisse an das LLM zurück.
- Konfiguration wird in `config.json` persistiert (Teil der Settings), wie Whisper/LLM/Badwords.

Referenz: `.docs/DOCS_MCP_CLIENT.md` (TypeScript-Tab) + MCP-SDK `@modelcontextprotocol/client` (Streamable HTTP + SSE-Transport).

---

## Ausgangslage

| Aspekt | VUI (aktuell) |
|---|---|
| Server | Node.js 22, Express 5, ES-Modules, `server/src/` |
| Config | `Config.js` — deklarativer Spec (`WHISPER_PARAMS`, `LLM_PARAMS`), env > config.json > Default, `getSettings`/`validateSettings`/`updateSettings`/`persist`, `runtimeKeys`/`restartKeys` |
| LLM | `Llm.js` — liest `config.llm` **zur Aufrufzeit** (Getter), `chat()` + `streamChat()` (SSE/NDJSON), OpenAI-kompatibel + Ollama |
| Chat-Routen | `POST /api/chat` (non-streaming), `POST /api/chat/stream` (SSE: `thinking`/`answer`/`done`/`error`) |
| Settings-API | `GET`/`PUT /api/settings` |
| Settings-UI | `SettingsPage.jsx` — Tabs (SECTIONS/TABS), Draft-State, Save/Reset, Feld-Typen `text`/`number`/`checkbox`/`temperature`/`textarea` |
| i18n | i18next, `locales/{en,de,it}.json` |
| CSS | BEM + CSS-Variablen, `style/components/*.css`, Import in `index.css` |
| Tests | `vitest` in `server/test/` (`config.test.js`, `llm.test.js`, `router-chat.test.js`) |
| MCP-SDK | **nicht installiert** |
| Docker | `node:22-alpine`, `vui-server` läuft mit `npm run dev`, `host.docker.internal` gemappt |

**MCP-SDK (verifiziert):** `@modelcontextprotocol/client` v2.4.0 auf npm (v2 = stabile Release-Linie, ersetzt das v1-Paket `@modelcontextprotocol/sdk`). Exports `.` (`Client`, `StreamableHTTPClientTransport`, `SSEClientTransport`). Zieht `@modelcontextprotocol/core` als Dependency mit (wird automatisch installiert, muss nicht deklariert werden). API gemäß Docs:

> **Nicht benötigt (Server-seitig):** `@modelcontextprotocol/express` und `@modelcontextprotocol/node` sind **Adapter für MCP-Server** (peer-dep `@modelcontextprotocol/server`), um einen MCP-Server auf Express/Node zu hosten. VUI ist ein reiner **MCP-Client** (verbindet sich an externe MCP-Server) → beide Pakete werden **nicht** installiert.

```js
import { Client, StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";

const client = new Client(
  { name: "vui-mcp", version: "1.0.0" },
  { versionNegotiation: { mode: "auto" } },
);
// Modern: Streamable HTTP (POST + SSE-Stream). Legacy: HTTP+SSE.
const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
// Fallback für SSE-only-Server:
// const transport = new SSEClientTransport(new URL(url), { requestInit: { headers } });
await client.connect(transport);
const { tools } = await client.listTools();          // tool: { name, description, inputSchema }
const result = await client.callTool({ name, arguments }); // result: { content: [blocks], isError }
await client.close();
```

---

## Architektur-Entscheidung

1. **MCP-Client läuft serverseitig (Node.js).** MCP-Server sind HTTP-Endpunkte (Streamable HTTP / SSE) — die sprechen das Browser-Frontend nicht direkt an (CORS, Auth, Session-State). Der VUI-Server (Node 22) ist der natürliche Host und Proxy. Das Frontend spricht nur die VUI-HTTP-API.

2. **Ein `McpManager` verwaltet alle Verbindungen.** `Map<id, Connection>` mit `Connection = { client, transport, config, status, tools, error }`. Verbindungen werden lazy/aktiv je nach `enabled`-Flag aufgebaut.

3. **Tool-Namensraum: `${serverId}__${toolName}`.** Bei beliebig vielen Servern können Tool-Namen kollidieren (zwei Server mit `get_weather`). Der dem LLM präsentierte Funktionsname wird mit der Server-ID prefixt. `McpManager` mappt beim Ausführen zurück auf `(serverId, toolName)`. Das ist die einzige saubere Lösung für Mehrfach-Anbindung.

4. **Chat-Integration über OpenAI-Function-Calling.** VUI nutzt OpenAI-kompatible Backends (LocalAI/Ollama). MCP-`inputSchema` (JSON Schema) wird 1:1 auf `function.parameters` gemappt. Tool-Loop: `tools` → LLM antwortet mit `tool_calls` → Server führt aus → `role:'tool'`-Ergebnisse anhängen → LLM erneut → bis keine `tool_calls` mehr oder `MAX_MCP_TOOL_TURNS`.

5. **Config: `mcpServers`-Array in `config.json`.** Einzelquelle der Wahrheit. CRUD über dedizierte `/api/mcp/*`-Endpunkte (sofortige Wirkung: connect bei Add, disconnect bei Delete) — nicht über den globalen Save-Button (der bleibt für skalare Settings).

6. **Dynamisches Config-Reading.** `McpManager` liest `config.mcpServers` zur Aufrufzeit (Getter-Pattern wie `Llm.chatConfig`). `'mcpServers'` in `runtimeKeys` → wirkt ohne Neustart.

7. **Graceful Degradation.** Tool-Calling setzt ein LLM-Backend voraus, das OpenAI-Function-Calling unterstützt. Fehlt das, bleiben die MCP-Tools über die MCP-API erreichbar/listbar, der Chat ruft sie aber nicht automatisch auf (kein Crash, klare Log-Meldung).

### MCP-Server-Config-Format (pro Eintrag)

```json
{
  "id": "weather",
  "name": "Weather",
  "enabled": true,
  "url": "http://localhost:8080/mcp",
  "headers": { "Authorization": "Bearer ..." },
  "transport": "auto"
}
```

- `id` — eindeutiger Slug (aus `name` generiert, Kollisionen → `-2`, `-3`).
- `url` — MCP-Server-Endpunkt (vollständige URL, z. B. `http://host:port/mcp`).
- `headers` — Objekt `KEY → VALUE` (HTTP-Header pro Request, z. B. `Authorization`, optional).
- `transport` — `"auto"` (Default: Streamable HTTP, Fallback SSE) | `"streamable-http"` | `"sse"`.
- `enabled` — `false` → nicht verbunden, aber konfiguriert.

---

## Schritt 1: Server — Dependency

**Datei:** `server/package.json` (bestehend)

```json
"dependencies": {
  "@modelcontextprotocol/client": "^2.4.0",
  "axios": "^1.20.0",
  "express": "^5.3.0",
  "ws": "^8.18.0",
  "yaml": "^2.9.1"
}
```

Install: `npm install` in `server/` (bzw. Docker-Build).

> **Nur `@modelcontextprotocol/client`** ist die MCP-Dependency. `@modelcontextprotocol/express` (Express-Server-Adapter) und `@modelcontextprotocol/node` (`NodeStreamableHTTPServerTransport`, Node-Server-Adapter) sind **Server-seitig** und für einen Client **nicht** erforderlich — nicht installieren.

---

## Schritt 2: Server — McpManager

**Datei:** `server/src/McpManager.js` (neu)

Verwaltet alle MCP-Verbindungen + Tool-Registry + Tool-Ausführung.

```js
import { Client, StreamableHTTPClientTransport, SSEClientTransport } from '@modelcontextprotocol/client';

const MAX_MCP_TOOL_TURNS = 10;
const NAME_SEP = '__';

class McpManager {
    /**
     * @param {object} params
     * @param {Config} params.config - Config-Objekt (liest `config.mcpServers`)
     * @param {Logger} params.logger
     */
    constructor({ config, logger } = {}) {
        this.config = config;
        this.label = '[McpManager]';
        this.logger = logger || { log: () => {}, error: () => {} };
        /** @type {Map<string, Connection>} */
        this.connections = new Map();
    }

    /** Liest die Server-Liste zur Aufrufzeit (dynamisch, wie Llm.chatConfig). */
    get servers() {
        return Array.isArray(this.config?.mcpServers) ? this.config.mcpServers : [];
    }

    /**
     * Verbindet alle `enabled`-Server (Start / Reconnect-all).
     * Fehler pro Server werden isoliert (ein kaputter Server bricht die anderen nicht ab).
     */
    async connectAll() {
        const results = [];
        for (const server of this.servers) {
            if (!server.enabled) {
                this.setStatus(server.id, 'disabled');
                continue;
            }
            results.push(await this.connect(server.id));
        }
        return results;
    }

    /**
     * Baut eine einzelne Verbindung auf (oder ersetzt eine bestehende).
     * Transport: Streamable HTTP (modern) mit Fallback auf HTTP+SSE (legacy).
     * @returns {Promise<ConnectionStatus>}
     */
    async connect(id) {
        const server = this.servers.find((s) => s.id === id);
        if (!server) return { id, status: 'error', error: 'Server nicht gefunden' };

        // Bestehende Verbindung sauber schließen (Reconnect).
        await this.disconnect(id).catch(() => {});

        let url;
        try {
            url = new URL(server.url);
        } catch {
            return { id, status: 'error', error: `Ungültige URL: ${server.url}` };
        }

        const options = server.headers && Object.keys(server.headers).length > 0
            ? { requestInit: { headers: server.headers } }
            : {};

        const mode = server.transport || 'auto';
        const attempts = mode === 'sse' ? ['sse'] : ['streamable-http', 'sse'];

        const newClient = () => new Client(
            { name: 'vui-mcp', version: '1.0.0' },
            { versionNegotiation: { mode: 'auto' } },
        );
        const makeTransport = (type) =>
            type === 'sse'
                ? new SSEClientTransport(url, options)
                : new StreamableHTTPClientTransport(url, options);

        let lastErr = null;
        for (const type of attempts) {
            const client = newClient();
            try {
                const transport = makeTransport(type);
                await client.connect(transport);
                const { tools } = await client.listTools();
                this.connections.set(id, {
                    client, transport, server, tools,
                    status: 'connected', error: null, transportType: type,
                });
                this.logger.log(this.label, `Verbunden: ${id} (${tools.length} Tools, ${type})`);
                return { id, status: 'connected', toolCount: tools.length, transport: type };
            } catch (err) {
                lastErr = err;
                await client.close().catch(() => {});
            }
        }

        this.connections.set(id, {
            client: null, transport: null, server, tools: [],
            status: 'error', error: lastErr?.message || 'Verbindung fehlgeschlagen',
        });
        this.logger.error(this.label, `Verbindung fehlgeschlagen: ${id}`, { error: lastErr?.message });
        return { id, status: 'error', error: lastErr?.message };
    }

    /** Schließt eine Verbindung und entfernt sie aus dem Map. */
    async disconnect(id) {
        const conn = this.connections.get(id);
        if (!conn) return;
        await conn.client.close().catch(() => {});
        this.connections.delete(id);
    }

    /** Reconnect = disconnect + connect. */
    async reconnect(id) {
        return this.connect(id);
    }

    /** Setzt nur den Status (z. B. 'disabled') ohne Verbindung. */
    setStatus(id, status) {
        const existing = this.connections.get(id);
        this.connections.set(id, {
            client: null, transport: null,
            server: this.servers.find((s) => s.id === id),
            tools: [], status, error: null,
            ...(existing ? {} : {}),
        });
    }

    /**
     * Status-Übersicht aller konfigurierten Server (für die UI).
     * @returns {Array<object>}
     */
    listServers() {
        return this.servers.map((server) => {
            const conn = this.connections.get(server.id);
            return {
                id: server.id,
                name: server.name,
                enabled: server.enabled,
                url: server.url,
                headers: server.headers || {},
                transport: server.transport || 'auto',
                status: conn?.status || (server.enabled ? 'disconnected' : 'disabled'),
                transportType: conn?.transportType || null,
                toolCount: conn?.tools?.length || 0,
                error: conn?.error || null,
            };
        });
    }

    /**
     * Aggregiert die Tools aller verbundenen Server (namespaced).
     * @returns {Array<{name: string, description: string, inputSchema: object, serverId: string, toolName: string}>}
     */
    listTools() {
        const out = [];
        for (const [id, conn] of this.connections) {
            if (conn.status !== 'connected') continue;
            for (const tool of conn.tools) {
                out.push({
                    name: this.buildToolName(id, tool.name),
                    description: tool.description || '',
                    inputSchema: tool.inputSchema || { type: 'object', properties: {} },
                    serverId: id,
                    toolName: tool.name,
                });
            }
        }
        return out;
    }

    /**
     * Mappt MCP-Tools auf OpenAI-Function-Tools (für den LLM-Request).
     * @returns {Array<object>}
     */
    toOpenAITools() {
        return this.listTools().map((t) => ({
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: t.inputSchema,
            },
        }));
    }

    /**
     * Führt einen Tool-Call aus.
     * @param {string} serverId
     * @param {string} toolName - Original-Tool-Name (ohne Prefix)
     * @param {object} arguments_ - Argumente
     * @returns {Promise<{content: string, isError: boolean}>}
     */
    async callTool(serverId, toolName, arguments_) {
        const conn = this.connections.get(serverId);
        if (!conn || conn.status !== 'connected') {
            return { content: `MCP-Server '${serverId}' ist nicht verbunden.`, isError: true };
        }
        try {
            const result = await conn.client.callTool({ name: toolName, arguments: arguments_ || {} });
            const content = (result.content || [])
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('\n');
            return { content: content || '', isError: result.isError === true };
        } catch (err) {
            this.logger.error(this.label, `Tool-Call fehlgeschlagen: ${serverId}/${toolName}`, { error: err.message });
            return { content: err.message, isError: true };
        }
    }

    /** Baut den namespaced Tool-Namen. */
    buildToolName(serverId, toolName) {
        return `${serverId}${NAME_SEP}${toolName}`;
    }

    /** Zerlegt einen namespaced Tool-Namen in (serverId, toolName). */
    parseToolName(name) {
        const idx = name.indexOf(NAME_SEP);
        if (idx === -1) return null;
        return { serverId: name.slice(0, idx), toolName: name.slice(idx + NAME_SEP.length) };
    }

    /** Schließt alle Verbindungen (Shutdown). */
    async close() {
        await Promise.allSettled(
            [...this.connections.keys()].map((id) => this.disconnect(id))
        );
        this.connections.clear();
    }
}

export { McpManager, MAX_MCP_TOOL_TURNS };
```

**Wichtig:**
- `servers`-Getter liest `config.mcpServers` **zur Aufrufzeit** → Settings-Änderungen wirken sofort.
- Fehler pro Server isoliert (`connectAll` bricht nicht ab).
- `callTool` liefert immer `{ content, isError }` (kein Throw) — das LLM kann auf Fehler reagieren.

---

## Schritt 3: Server — Config-Erweiterung

**Datei:** `server/src/Config.js` (bestehend)

### Neue Validierung für MCP-Server

```js
/** Validiert eine MCP-Server-Liste. @returns {string[]} Fehlerliste */
validateMcpServers(list) {
    const errors = [];
    if (!Array.isArray(list)) {
        errors.push('mcpServers muss ein Array sein');
        return errors;
    }
    const seen = new Set();
    for (const [i, s] of list.entries()) {
        const label = `mcpServers[${i}]`;
        if (typeof s !== 'object' || s === null) { errors.push(`${label} muss ein Objekt sein`); continue; }
            if (typeof s.id !== 'string' || s.id.trim() === '') errors.push(`${label}.id muss ein nicht-leerer String sein`);
            if (typeof s.name !== 'string' || s.name.trim() === '') errors.push(`${label}.name muss ein nicht-leerer String sein`);
            if (typeof s.url !== 'string' || s.url.trim() === '') {
                errors.push(`${label}.url muss ein nicht-leerer String sein`);
            } else {
                try { new URL(s.url); } catch { errors.push(`${label}.url muss eine gültige URL sein`); }
            }
            if (s.headers !== undefined && (typeof s.headers !== 'object' || s.headers === null || Array.isArray(s.headers)
                || Object.values(s.headers).some((v) => typeof v !== 'string')))
                errors.push(`${label}.headers muss ein Objekt aus Strings sein`);
            if (s.transport !== undefined && !['auto', 'streamable-http', 'sse'].includes(s.transport))
                errors.push(`${label}.transport muss 'auto', 'streamable-http' oder 'sse' sein`);
            if (s.enabled !== undefined && typeof s.enabled !== 'boolean') errors.push(`${label}.enabled muss ein Boolean sein`);
        if (s.id) {
            if (seen.has(s.id)) errors.push(`${label}.id '${s.id}' ist doppelt`);
            seen.add(s.id);
        }
    }
    return errors;
}
```

### Konstruktor

```js
// MCP-Server (beliebig viele, HTTP/SSE). Default: keine.
this.mcpServers = this.resolveMcpServers(loaded);
```

```js
/** Ermittelt die MCP-Server-Liste: config.json > []. @returns {Array<object>} */
resolveMcpServers(loaded) {
    const fromFile = loaded?.mcpServers;
    if (Array.isArray(fromFile)) return fromFile;
    return [];
}
```

### `getSettings()` → `mcpServers: [...this.mcpServers]` hinzufügen

### `validateSettings()` → `errors.push(...this.validateMcpServers(s.mcpServers || []))`

### `updateSettings()` → `mcpServers` wird über `...patch` ersetzt (Array, kein Deep-Merge)

```js
const next = {
    ...current,
    ...patch,
    whisper: { ...current.whisper, ...(patch.whisper || {}) },
    llm: { ...current.llm, ...(patch.llm || {}) },
    badwords: patch.badwords !== undefined ? patch.badwords : current.badwords,
    mcpServers: patch.mcpServers !== undefined ? patch.mcpServers : current.mcpServers,
};
```

Runtime-State aktualisieren:
```js
this.mcpServers = (next.mcpServers || []).map((s) => ({ ...s }));
```

### `persist()` → `mcpServers: this.mcpServers` in `config.json` schreiben

### `saveDefaults()` → `mcpServers: []`

### `runtimeKeys` → `'mcpServers'` hinzufügen (wirkt ohne Neustart, `McpManager` liest dynamisch)

### `slugify`-Helper (für ID-Generierung, in Config oder McpManager)

```js
/** Erzeugt einen eindeutigen Slug aus einem Namen. */
slugify(name, existing = new Set()) {
    const base = String(name).toLowerCase().trim()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
    let id = base; let n = 2;
    while (existing.has(id)) { id = `${base}-${n}`; n++; }
    return id;
}
```

---

## Schritt 4: Server — Llm-Tool-Support

**Datei:** `server/src/Llm.js` (bestehend)

Die bestehenden `chat()`/`streamChat()` bleiben für den Tool-freien Fall. Neue Methoden für Function-Calling:

### `chatWithTools(messages, tools, options)`

Non-streaming mit Tools. Liefert `{ content, toolCalls, refusal }`.

```js
async chatWithTools(messages, tools, options = {}) {
    const cfg = this.chatConfig;
    const base = this.normalizeUrl(cfg.baseUrl);
    const { signal, ...llmOptions } = options;

    const payload = {
        model: llmOptions.model || cfg.modelName,
        messages,
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...llmOptions,
    };

    try {
        if (cfg.api === 'openai') {
            const res = await axios.post(`${base}/chat/completions`, payload, { signal });
            return this._extractOpenAITurn(res.data);
        }
        // Ollama: Tools werden über `tools` im Payload übergeben (OpenAI-kompatibel).
        const res = await axios.post(`${base}/api/chat`, { ...payload, stream: false }, { signal });
        return this._extractOllamaTurn(res.data);
    } catch (error) {
        this.logger.error(this.label, 'ChatWithTools fehlgeschlagen', { error: error.message });
        throw error;
    }
}

/** Extrahiert einen LLM-Turn (content + tool_calls) aus einer OpenAI-Antwort. */
_extractOpenAITurn(data) {
    const message = data?.choices?.[0]?.message || {};
    return {
        content: typeof message.content === 'string' ? message.content : null,
        toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls : [],
        refusal: typeof message.refusal === 'string' ? message.refusal : null,
    };
}
```

> **Hinweis:** Ollama/LocalAI-Tool-Support ist modellabhängig. `_extractOllamaTurn` liest `message.tool_calls` (Ollama nutzt das OpenAI-Format). Fehlt die Unterstützung, liefert das LLM keine `toolCalls` → der Loop endet sauber (kein Crash).

### `streamChatWithTools(messages, tools, options)`

Streaming mit Tools. Yields `{ phase, token }` **plus** am Ende `{ phase: 'turn', content, toolCalls }`, wenn das LLM Tools anfordert.

```js
async *streamChatWithTools(messages, tools, options = {}) {
    // Wie streamChat(), aber:
    //  - `tools` in den Payload
    //  - am Ende des Streams den finalen Turn (content + tool_calls) extrahieren
    //    und als { phase: 'turn', content, toolCalls } yielden
    //  - dazwischen wie bisher { phase: 'thinking' | 'answer', token }
}
```

> Implementierungsdetail: Beim Streaming sammelt man `delta.tool_calls` (OpenAI liefert Tool-Calls inkrementell). Am Ende wird der vollständige Turn rekonstruiert. Die bestehenden `_readSSE`/`_readNDJSON`-Parser werden wiederverwendet.

### `detectToolSupport()` — Capability-Detection

Prüft einmalig, ob das LLM-Backend OpenAI-Function-Calling unterstützt. Ergebnis wird gecacht und bei Modell-/Backend-Wechsel invalidiert.

```js
_toolSupport = null; // null = unbekannt, true/false = erkannt

async detectToolSupport() {
    if (this._toolSupport !== null) return this._toolSupport;
    const probeTools = [{
        type: 'function',
        function: {
            name: 'get_time',
            description: 'Get the current time. You MUST use this tool.',
            parameters: { type: 'object', properties: {} },
        },
    }];
    try {
        const res = await this.chatWithTools(
            [{ role: 'user', content: 'What time is it now? Use the get_time tool.' }],
            probeTools,
            { max_tokens: 30 },
        );
        this._toolSupport = Array.isArray(res.toolCalls) && res.toolCalls.length > 0;
    } catch {
        this._toolSupport = false;
    }
    this.logger.log(this.label, `Tool-Support: ${this._toolSupport ? 'ja' : 'nein'}`);
    return this._toolSupport;
}
```

> **Cache-Invalidierung:** Bei Änderung von `modelName`/`baseUrl`/`api` (in `chatConfig`-Getter oder `updateSettings`) → `this._toolSupport = null`. Sonst bleibt ein veraltetes Ergebnis hängen.

> **Optional — ReAct-Fallback:** Für Tool-unfähige Modelle: statt nativer `tool_calls` per System-Prompt Tool-Calls als Text ausgeben lassen (`TOOL_CALL … TOOL_CALL_END`), serverseitig parsen, ausführen, Ergebnis anhängen. Funktioniert mit jedem LLM, ist aber weniger zuverlässig (Parsing) und token-hungriger. Nur bei Bedarf.

---

## Schritt 5: Server — MCP-API-Routen

**Datei:** `server/src/Router/index.js` (bestehend)

### Instanziierung (Konstruktor)

```js
import { McpManager } from '../McpManager.js';
// ...
this.mcp = new McpManager({ config: this.config, logger: this.logger });
```

### Endpunkte (in `define()`)

```js
// MCP-Server-Liste + Status + Tool-Zahl.
this.router.get('/api/mcp/servers', (req, res) => {
    res.status(200).json({ success: true, data: { servers: this.mcp.listServers() } });
});

// Tool-Support des LLM-Backends (für UI-Hinweis).
this.router.get('/api/mcp/capability', async (req, res, next) => {
    try {
        const toolSupport = await this.llm.detectToolSupport();
        res.status(200).json({ success: true, data: { toolSupport } });
    } catch (err) { next(err); }
});

// MCP-Server anlegen (ID aus Name generiert) + verbinden.
this.router.post('/api/mcp/servers', (req, res, next) => {
    (async () => {
            const { name, url, headers, transport, enabled } = req.body || {};
            const errors = this.validateMcpEntry({ name, url, headers, transport, enabled });
            if (errors.length) { const e = new Error(errors.join('; ')); e.status = 400; e.code = 'invalid_mcp_server'; throw e; }

            const existing = new Set(this.config.mcpServers.map((s) => s.id));
            const id = this.config.slugify(name, existing);
            const entry = { id, name, url, headers: headers || {}, transport: transport || 'auto', enabled: enabled !== false };
        const mcpServers = [...this.config.mcpServers, entry];
        this.config.updateSettings({ mcpServers });

        const result = entry.enabled ? await this.mcp.connect(id) : { id, status: 'disabled' };
        res.status(201).json({ success: true, data: { server: this.mcp.listServers().find((s) => s.id === id), result } });
    })().then(() => {}).catch(next);
});

// MCP-Server aktualisieren (Partial) + bei Verbindungsänderung reconnecten.
this.router.put('/api/mcp/servers/:id', (req, res, next) => {
    (async () => {
        const id = req.params.id;
        const current = this.config.mcpServers.find((s) => s.id === id);
        if (!current) { const e = new Error('MCP-Server nicht gefunden'); e.status = 404; throw e; }

        const patch = req.body || {};
        const updated = { ...current, ...patch, id }; // id ist immutable
        const errors = this.validateMcpEntry(updated);
        if (errors.length) { const e = new Error(errors.join('; ')); e.status = 400; e.code = 'invalid_mcp_server'; throw e; }

        const mcpServers = this.config.mcpServers.map((s) => (s.id === id ? updated : s));
        this.config.updateSettings({ mcpServers });

        // Bei Änderung von url/headers/transport/enabled → (re)connect.
        const connChanged = JSON.stringify({ u: updated.url, h: updated.headers, t: updated.transport, en: updated.enabled })
            !== JSON.stringify({ u: current.url, h: current.headers, t: current.transport, en: current.enabled });
        let result = null;
        if (updated.enabled) {
            result = connChanged ? await this.mcp.reconnect(id) : await this.mcp.connect(id);
        } else {
            await this.mcp.disconnect(id);
            this.mcp.setStatus(id, 'disabled');
        }
        res.status(200).json({ success: true, data: { server: this.mcp.listServers().find((s) => s.id === id), result } });
    })().catch(next);
});

// MCP-Server löschen + disconnecten.
this.router.delete('/api/mcp/servers/:id', async (req, res, next) => {
    try {
        const id = req.params.id;
        await this.mcp.disconnect(id);
        const mcpServers = this.config.mcpServers.filter((s) => s.id !== id);
        this.config.updateSettings({ mcpServers });
        res.status(200).json({ success: true, data: { removed: id } });
    } catch (err) { next(err); }
});

// Reconnect eines Servers.
this.router.post('/api/mcp/servers/:id/reconnect', async (req, res, next) => {
    try {
        const id = req.params.id;
        const result = await this.mcp.reconnect(id);
        res.status(200).json({ success: true, data: { server: this.mcp.listServers().find((s) => s.id === id), result } });
    } catch (err) { next(err); }
});

// Tool-Liste eines Servers.
this.router.get('/api/mcp/servers/:id/tools', (req, res) => {
    const conn = this.mcp.connections.get(req.params.id);
    if (!conn) return res.status(404).json({ success: false, error: 'MCP-Server nicht gefunden' });
    res.status(200).json({ success: true, data: { tools: conn.tools } });
});

// Direkter Tool-Call (für Tests / Debug).
this.router.post('/api/mcp/call', async (req, res, next) => {
    try {
        const { serverId, name, arguments: args } = req.body || {};
        if (!serverId || !name) return res.status(400).json({ success: false, error: 'serverId und name erforderlich' });
        const result = await this.mcp.callTool(serverId, name, args);
        res.status(200).json({ success: true, data: result });
    } catch (err) { next(err); }
});
```

### Helper `validateMcpEntry(entry)` (in Router oder Config)

Validiert einen einzelnen Eintrag (wie `validateMcpServers`, aber für ein Objekt). Wiederverwendung der Config-Logik.

### Start-Verbindungen

In `define()` (nach Router-Setup) oder in `Server.start()`:
```js
await this.mcp.connectAll();
```

> **Ordnung:** `connectAll()` nach `FrontendRouter.init()`, damit der Server erst erreichbar ist, wenn die MCP-Verbindungen aufgebaut sind (oder parallel — `connectAll` ist fault-tolerant).

---

## Schritt 6: Server — Chat-Tool-Loop

**Datei:** `server/src/Router/index.js` (bestehend)

Die bestehenden `POST /api/chat` und `POST /api/chat/stream` werden um den MCP-Tool-Loop erweitert.

### Gemeinsamer Tool-Loop (Non-Streaming)

```js
/**
 * Führt den Chat mit MCP-Tool-Loop aus (Non-Streaming).
 * @returns {Promise<string>} Die finale Antwort
 */
async runChatWithMcpTools(question, history, options = {}) {
    const messages = this.buildChatMessages(question, history);
    const tools = this.mcp.toOpenAITools();
    const maxTurns = MAX_MCP_TOOL_TURNS;

    // Kein Tool-Support im Backend → normaler Chat (Graceful Degradation).
    if (tools.length > 0) {
        const supported = await this.llm.detectToolSupport();
        if (!supported) {
            this.logger.warn(this.label,
                'LLM-Backend unterstützt kein Function-Calling. MCP-Tools werden nicht aufgerufen.');
            return this.llm.chat(messages);
        }
    }

    for (let turn = 0; turn < maxTurns; turn++) {
        const turnResult = await this.llm.chatWithTools(messages, tools, options);

        // Keine Tool-Calls → finale Antwort.
        if (!turnResult.toolCalls || turnResult.toolCalls.length === 0) {
            return turnResult.content || turnResult.refusal || '';
        }

        // Assistant-Turn (mit tool_calls) anhängen.
        messages.push({
            role: 'assistant',
            content: turnResult.content,
            tool_calls: turnResult.toolCalls,
        });

        // Jeden Tool-Call ausführen + Ergebnis anhängen.
        for (const call of turnResult.toolCalls) {
            const parsed = this.mcp.parseToolName(call.function?.name);
            let content = 'Unbekanntes Tool';
            let isError = true;
            if (parsed) {
                let args = {};
                try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = {}; }
                const result = await this.mcp.callTool(parsed.serverId, parsed.toolName, args);
                content = result.content;
                isError = result.isError;
            }
            messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content,
                ...(isError ? {} : {}),
            });
        }
    }

    // Turn-Cap erreicht.
    return `[Gestoppt nach ${maxTurns} MCP-Tool-Runden]`;
}
```

### `POST /api/chat` (Erweiterung)

```js
this.router.post('/api/chat', async (req, res) => {
    const question = req.body?.question;
    if (typeof question !== 'string' || question.trim() === '') {
        return res.status(400).json({ success: false, error: 'Missing "question" in request body' });
    }
    if (!this.config.llm?.host) {
        return res.status(503).json({ success: false, error: 'LLM is not configured. Set LLM_HOST.' });
    }
    try {
        const answer = await this.runChatWithMcpTools(question, req.body?.history);
        res.status(200).json({ success: true, data: { answer } });
    } catch (err) {
        this.logger.error(this.label, 'Chat fehlgeschlagen', { error: err.message });
        res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
    }
});
```

> **Fallback:** Wenn `this.mcp.toOpenAITools()` leer ist (keine verbundenen MCP-Server), verhält sich `runChatWithMcpTools` wie der alte `chat()` (keine Tools im Payload). Bestehendes Verhalten bleibt erhalten.

### `POST /api/chat/stream` (Erweiterung)

SSE-Events um `tool_call` und `tool_result` ergänzen. Der finale Answer-Stream bleibt `answer`.

```js
// Im Stream-Loop:
//  1. streamChatWithTools() iterieren
//  2. { phase: 'thinking' | 'answer' } → wie bisher senden
//  3. { phase: 'turn', toolCalls } → für jeden Call:
//       - send('tool_call', { id, name, arguments })
//       - MCP-Call ausführen
//       - send('tool_result', { id, content, isError })
//       - Messages für nächste Runde aktualisieren
//  4. Wenn toolCalls → nächste LLM-Runde (erneut streamen)
//  5. Wenn keine toolCalls → send('done', stats) + res.end()
```

> **Ereignis-Vertrag (erweitert):** `thinking`, `answer`, `tool_call`, `tool_result`, `done`, `error`.
> Das Frontend (`chatStream`) liest bereits generische `{ event, data }`-Paare → neue Events werden automatisch durchgereicht. `useChatStream` kann `tool_call`/`tool_result` optional anzeigen.

---

## Schritt 7: Server — Shutdown

**Datei:** `server/src/Server.js` (bestehend)

In `shutdown()` (neben `transcribeBridge.close()`, `logsWs.close()`, `tailService.stop()`):

```js
this.router?.mcp?.close(); // HTTP/SSE-Verbindungen + SSE-Streams beenden
```

> **Wichtig:** Streamable-HTTP-Verbindungen halten offene SSE-Streams (GET) und Reconnect-Timer. Ohne explizites `close()` laufen die Streams/Timer weiter und blockieren ggf. den `--watch`-Restart. `McpManager.close()` schließt alle `client.close()` (die Transport + Streams + Timer beenden).

---

## Schritt 8: Frontend — MCP-API-Client

**Datei:** `frontend/src/api/mcp.js` (neu)

```js
/**
 * MCP-API-Client.
 * Endpunkte:
 *   GET    /api/mcp/servers              → { servers: [...] }
 *   GET    /api/mcp/capability           → { toolSupport: boolean }
 *   POST   /api/mcp/servers              → { server, result }
 *   PUT    /api/mcp/servers/:id          → { server, result }
 *   DELETE /api/mcp/servers/:id          → { removed }
 *   POST   /api/mcp/servers/:id/reconnect→ { server, result }
 *   GET    /api/mcp/servers/:id/tools    → { tools: [...] }
 *   POST   /api/mcp/call                 → { content, isError }
 */

async function request(path, options = {}) {
    let res;
    try {
        res = await fetch(path, {
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            ...options,
        });
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
        throw Object.assign(new Error('Connection to server failed.'), { name: 'NetworkError', status: 0 });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.success) {
        throw new Error(body.error || `Request failed with status ${res.status}`);
    }
    return body.data;
}

export const listMcpServers = () => request('/api/mcp/servers').then((d) => d.servers);

export const getMcpCapability = () => request('/api/mcp/capability');

export const addMcpServer = (entry) =>
    request('/api/mcp/servers', { method: 'POST', body: JSON.stringify(entry) });

export const updateMcpServer = (id, patch) =>
    request(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) });

export const removeMcpServer = (id) =>
    request(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const reconnectMcpServer = (id) =>
    request(`/api/mcp/servers/${encodeURIComponent(id)}/reconnect`, { method: 'POST' });

export const listMcpTools = (id) =>
    request(`/api/mcp/servers/${encodeURIComponent(id)}/tools`).then((d) => d.tools);

export const callMcpTool = (serverId, name, arguments_) =>
    request('/api/mcp/call', { method: 'POST', body: JSON.stringify({ serverId, name, arguments: arguments_ }) });
```

---

## Schritt 9: Frontend — MCP-Tab in SettingsPage

**Datei:** `frontend/src/pages/SettingsPage.jsx` (bestehend)

Neuer Tab „MCP“ (in `TABS`), mit eigener CRUD-UI (nicht der globale Draft/Save).

### Tab-Definition

```js
const TABS = [
    ...SECTIONS.map((s) => ({ id: s.id, title: s.title })),
    { id: 'badwords', title: 'settings.sections.badwords' },
    { id: 'mcp', title: 'settings.sections.mcp' },        // ← NEU
    { id: 'ui', title: 'settings.sections.ui' },
];
```

### MCP-Tab-Komponente (neu, eigene Datei)

**Datei:** `frontend/src/components/McpSettings.jsx` (neu)

Verantwortlich für die MCP-Liste + Add/Edit-Form. Props: keine (nutzt `api/mcp.js` direkt).

```jsx
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2, RefreshCw, Power } from 'lucide-react';
import {
    listMcpServers, addMcpServer, updateMcpServer,
    removeMcpServer, reconnectMcpServer, listMcpTools, getMcpCapability,
} from '../api/mcp.js';

const EMPTY_FORM = { name: '', url: '', headers: '', enabled: true };

export default function McpSettings() {
    const { t } = useTranslation();
    const [servers, setServers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [form, setForm] = useState(null);          // null = geschlossen, sonst { id?, ...EMPTY_FORM }
    const [expandedTools, setExpandedTools] = useState({}); // id → tools[]
    const [toolSupport, setToolSupport] = useState(null);   // null = unbekannt, true/false = erkannt

    const load = useCallback(async () => {
        setLoading(true); setError(null);
        try { setServers(await listMcpServers()); }
        catch (err) { setError(err.message); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { load(); }, [load]);

    // Tool-Support des LLM-Backends (für Hinweis).
    useEffect(() => {
        getMcpCapability()
            .then((cap) => setToolSupport(cap.toolSupport))
            .catch(() => setToolSupport(null));
    }, []);

    const openAdd = () => setForm({ ...EMPTY_FORM });
    const openEdit = (s) => setForm({
        id: s.id, name: s.name, url: s.url,
        headers: headersToLines(s.headers), enabled: s.enabled,
    });
    const closeForm = () => setForm(null);

    const handleSubmit = async (e) => {
        e.preventDefault();
        const entry = {
            name: form.name.trim(),
            url: form.url.trim(),
            headers: linesToHeaders(form.headers),
            enabled: form.enabled,
        };
        setError(null);
        try {
            if (form.id) await updateMcpServer(form.id, entry);
            else await addMcpServer(entry);
            closeForm();
            await load();
        } catch (err) { setError(err.message); }
    };

    const handleDelete = async (id) => {
        if (!confirm(t('mcp.confirmDelete'))) return;
        try { await removeMcpServer(id); await load(); }
        catch (err) { setError(err.message); }
    };

    const handleToggle = async (s) => {
        try { await updateMcpServer(s.id, { enabled: !s.enabled }); await load(); }
        catch (err) { setError(err.message); }
    };

    const handleReconnect = async (id) => {
        try { await reconnectMcpServer(id); await load(); }
        catch (err) { setError(err.message); }
    };

    const toggleTools = async (id) => {
        if (expandedTools[id]) { setExpandedTools((m) => ({ ...m, [id]: null })); return; }
        try {
            const tools = await listMcpTools(id);
            setExpandedTools((m) => ({ ...m, [id]: tools }));
        } catch { /* Server nicht verbunden */ }
    };

    const statusClass = (status) =>
        status === 'connected' ? 'mcp__status--ok'
        : status === 'error' ? 'mcp__status--error'
        : status === 'disabled' ? 'mcp__status--disabled'
        : 'mcp__status--off';

    return (
        <div className="mcp">
            <div className="mcp__header">
                <h3>{t('mcp.title')}</h3>
                <button type="button" className="btn btn--primary" onClick={openAdd}>
                    <Plus size={16} /><span>{t('mcp.add')}</span>
                </button>
            </div>

            {error && <p className="mcp__error">{error}</p>}
            {loading && <p className="mcp__loading">{t('mcp.loading')}</p>}

            {!loading && servers.length === 0 && (
                <p className="mcp__empty">{t('mcp.empty')}</p>
            )}

            {!loading && servers.length > 0 && toolSupport === false && (
                <p className="mcp__warning">{t('mcp.noToolSupport')}</p>
            )}

            <ul className="mcp__list">
                {servers.map((s) => (
                    <li key={s.id} className="mcp__item">
                        <div className="mcp__item-head">
                            <span className={`mcp__status ${statusClass(s.status)}`}>
                                {t(`mcp.status.${s.status}`)}
                            </span>
                            <strong>{s.name}</strong>
                            <code className="mcp__cmd">{s.url}</code>
                            <span className="mcp__tools-count">{s.toolCount} {t('mcp.tools')}</span>
                        </div>
                        {s.error && <p className="mcp__item-error">{s.error}</p>}

                        {expandedTools[s.id] && (
                            <ul className="mcp__tools">
                                {expandedTools[s.id].map((tool) => (
                                    <li key={tool.name}>
                                        <code>{tool.name}</code>
                                        {tool.description && <span> — {tool.description}</span>}
                                    </li>
                                ))}
                            </ul>
                        )}

                        <div className="mcp__item-actions">
                            <button type="button" className="btn btn--secondary" onClick={() => toggleTools(s.id)}>
                                <span>{t('mcp.showTools')}</span>
                            </button>
                            <button type="button" className="btn btn--secondary" onClick={() => handleToggle(s)}>
                                <Power size={16} /><span>{s.enabled ? t('mcp.disable') : t('mcp.enable')}</span>
                            </button>
                            <button type="button" className="btn btn--secondary" onClick={() => handleReconnect(s.id)}>
                                <RefreshCw size={16} /><span>{t('mcp.reconnect')}</span>
                            </button>
                            <button type="button" className="btn btn--secondary" onClick={() => openEdit(s)}>
                                <Pencil size={16} /><span>{t('mcp.edit')}</span>
                            </button>
                            <button type="button" className="btn btn--danger" onClick={() => handleDelete(s.id)}>
                                <Trash2 size={16} /><span>{t('mcp.delete')}</span>
                            </button>
                        </div>
                    </li>
                ))}
            </ul>

            {form && (
                <form className="mcp__form" onSubmit={handleSubmit}>
                    <h4>{form.id ? t('mcp.editTitle') : t('mcp.addTitle')}</h4>
                    <label className="settings__field">
                        <span>{t('mcp.fields.name')}</span>
                        <input type="text" value={form.name} required
                            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                    </label>
                    <label className="settings__field">
                        <span>{t('mcp.fields.url')}</span>
                        <input type="url" value={form.url} required placeholder="http://localhost:8080/mcp"
                            onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} />
                    </label>
                    <label className="settings__field settings__field--full">
                        <span>{t('mcp.fields.headers')}</span>
                        <textarea className="settings__textarea" rows={3} value={form.headers}
                            placeholder={'Authorization=Bearer ...\nX-Custom=value'}
                            onChange={(e) => setForm((f) => ({ ...f, headers: e.target.value }))} />
                    </label>
                    <label className="settings__field settings__field--check">
                        <input type="checkbox" checked={form.enabled}
                            onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
                        <span>{t('mcp.fields.enabled')}</span>
                    </label>
                    <div className="mcp__form-actions">
                        <button type="button" className="btn btn--secondary" onClick={closeForm}>
                            <span>{t('settings.reset')}</span>
                        </button>
                        <button type="submit" className="btn btn--primary">
                            <span>{form.id ? t('mcp.save') : t('mcp.add')}</span>
                        </button>
                    </div>
                </form>
            )}
        </div>
    );
}

/** headers-Objekt → Zeilen (KEY=VALUE). */
function headersToLines(headers) {
    if (!headers || typeof headers !== 'object') return '';
    return Object.entries(headers).map(([k, v]) => `${k}=${v}`).join('\n');
}
/** Zeilen (KEY=VALUE) → headers-Objekt. */
function linesToHeaders(lines) {
    const out = {};
    for (const line of String(lines).split('\n')) {
        const idx = line.indexOf('=');
        if (idx === -1) continue;
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k) out[k] = v;
    }
    return out;
}
```

### Integration in SettingsPage

In der `settings__body`-Rendering-Logik (neben `ui`/`badwords`):

```jsx
{activeTab === 'mcp' ? (
    <McpSettings />
) : activeTab === 'ui' ? (
    // ...bestehend
) : activeTab === 'badwords' ? (
    // ...bestehend
) : (
    // ...bestehend
)}
```

> **Footer:** Der MCP-Tab nutzt **keinen** globalen Save-Button (CRUD wirkt sofort). Im Footer für `activeTab === 'mcp'` entweder nichts anzeigen oder einen Hinweis (`mcp.hint`). Die bestehenden `error`/`saved`-Anzeigen betreffen nur die skalaren Settings.

---

## Schritt 10: Frontend — i18n

**Dateien:** `frontend/src/locales/{en,de,it}.json` (bestehend)

Neue Sektion `"mcp"` + `settings.sections.mcp`:

```json
{
  "settings": {
    "sections": {
      "mcp": "MCP"
    }
  },
  "mcp": {
    "title": "MCP Servers",
    "add": "Add server",
    "addTitle": "Add MCP server",
    "editTitle": "Edit MCP server",
    "edit": "Edit",
    "delete": "Delete",
    "save": "Save",
    "enable": "Enable",
    "disable": "Disable",
    "reconnect": "Reconnect",
    "showTools": "Tools",
    "tools": "tools",
    "empty": "No MCP servers configured.",
    "loading": "Loading…",
    "confirmDelete": "Delete this MCP server?",
    "hint": "Changes apply immediately.",
    "noToolSupport": "Your LLM backend does not support tool calling. Tools are listed but not invoked in chat.",
    "status": {
      "connected": "Connected",
      "disconnected": "Disconnected",
      "disabled": "Disabled",
      "error": "Error"
    },
    "fields": {
      "name": "Name",
      "url": "URL",
      "headers": "Headers (KEY=VALUE per line)",
      "enabled": "Enabled"
    }
  }
}
```

**Deutsch (`de.json`):**
```json
{
  "settings": { "sections": { "mcp": "MCP" } },
  "mcp": {
    "title": "MCP-Server",
    "add": "Server hinzufügen",
    "addTitle": "MCP-Server hinzufügen",
    "editTitle": "MCP-Server bearbeiten",
    "edit": "Bearbeiten",
    "delete": "Löschen",
    "save": "Speichern",
    "enable": "Aktivieren",
    "disable": "Deaktivieren",
    "reconnect": "Neu verbinden",
    "showTools": "Tools",
    "tools": "Tools",
    "empty": "Keine MCP-Server konfiguriert.",
    "loading": "Lädt…",
    "confirmDelete": "Diesen MCP-Server löschen?",
    "hint": "Änderungen wirken sofort.",
    "noToolSupport": "Dein LLM-Backend unterstützt kein Tool-Calling. Tools sind listbar, aber nicht im Chat aktiv.",
    "status": {
      "connected": "Verbunden",
      "disconnected": "Getrennt",
      "disabled": "Deaktiviert",
      "error": "Fehler"
    },
    "fields": {
      "name": "Name",
      "url": "URL",
      "headers": "Header (KEY=VALUE pro Zeile)",
      "enabled": "Aktiviert"
    }
  }
}
```

**Italienisch (`it.json`):** analog (IT-Übersetzung, inkl. `noToolSupport`).

---

## Schritt 11: Frontend — CSS

**Datei:** `frontend/src/style/components/mcp.css` (neu)

```css
.mcp { display: flex; flex-direction: column; gap: var(--space-4); }
.mcp__header { display: flex; align-items: center; justify-content: space-between; }
.mcp__error { color: var(--color-danger); }
.mcp__warning { color: var(--color-warning, var(--color-text-muted)); background: var(--color-warning-subtle, var(--color-surface-2)); padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); font-size: var(--fs-sm); }
.mcp__loading, .mcp__empty { color: var(--color-text-muted); }

.mcp__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-3); }
.mcp__item { border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-2); }
.mcp__item-head { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.mcp__cmd { font-size: var(--fs-sm); color: var(--color-text-muted); }
.mcp__tools-count { font-size: var(--fs-sm); color: var(--color-text-muted); }
.mcp__item-error { color: var(--color-danger); font-size: var(--fs-sm); margin: 0; }

.mcp__status { padding: 2px 8px; border-radius: var(--radius-full); font-size: var(--fs-xs); font-weight: 600; }
.mcp__status--ok { background: var(--color-success-subtle); color: var(--color-success); }
.mcp__status--error { background: var(--color-danger-subtle); color: var(--color-danger); }
.mcp__status--disabled, .mcp__status--off { background: var(--color-surface-2); color: var(--color-text-muted); }

.mcp__tools { list-style: none; margin: 0; padding: var(--space-2); background: var(--color-surface-2); border-radius: var(--radius-sm); display: flex; flex-direction: column; gap: var(--space-1); font-size: var(--fs-sm); }

.mcp__item-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }

.mcp__form { border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
.mcp__form-actions { display: flex; gap: var(--space-2); justify-content: flex-end; }
```

> Alle Werte aus bestehenden CSS-Variablen (`--space-*`, `--radius-*`, `--fs-*`, `--color-*`). Falls `--color-danger`/`--color-success` nicht existieren, bestehende Farbtokens verwenden (in `variables.css` prüfen).

**Import:** `frontend/src/style/components/index.css` → `@import './mcp.css';`

---

## Schritt 12: Tests

**Datei:** `server/test/mcp.test.js` (neu)

- `McpManager.listServers()` — Status-Übersicht (connected/disabled/error)
- `McpManager.listTools()` — Namespacing (`serverId__toolName`)
- `McpManager.toOpenAITools()` — korrektes OpenAI-Format
- `McpManager.parseToolName()` — Roundtrip mit `buildToolName`
- `McpManager.callTool()` — Mock-Client (content + isError)
- `McpManager.callTool()` — Server nicht verbunden → `isError: true`
- `McpManager.close()` — alle Verbindungen geschlossen
- **Dynamisches Config-Reading:** `config.mcpServers` ändern → `servers`-Getter liefert neue Liste

**Datei:** `server/test/llm-tools.test.js` (neu)

- `Llm.detectToolSupport()` — Probe liefert `toolCalls` → `true`
- `Llm.detectToolSupport()` — Probe ohne `toolCalls` → `false`
- `Llm.detectToolSupport()` — Cache (zweiter Call ohne neuen Request)
- `Llm.detectToolSupport()` — Cache-Invalidierung bei Modell-Wechsel

**Datei:** `server/test/config-mcp.test.js` (neu)

- `validateMcpServers()` — gültige Liste → keine Fehler
- `validateMcpServers()` — ungültig (leerer url, doppelte id, falsche headers) → Fehler
- `updateSettings({ mcpServers })` — Array wird ersetzt (nicht gemergt)
- `updateSettings({ mcpServers })` — persistiert in config.json
- `getSettings()` — enthält `mcpServers`
- `slugify()` — Kollisionen → `-2`, `-3`

**Datei:** `server/test/router-mcp.test.js` (neu)

- `GET /api/mcp/servers` — 200 + Liste
- `POST /api/mcp/servers` — 201 + verbunden (Mock-McpManager)
- `POST /api/mcp/servers` — 400 (ungültiger Eintrag)
- `PUT /api/mcp/servers/:id` — 200 + aktualisiert
- `PUT /api/mcp/servers/:id` — 404 (nicht gefunden)
- `DELETE /api/mcp/servers/:id` — 200 + entfernt
- `POST /api/mcp/servers/:id/reconnect` — 200
- `GET /api/mcp/servers/:id/tools` — 200 + Tools / 404
- `POST /api/mcp/call` — 200 + content / 400 (missing params)
- `GET /api/mcp/capability` — 200 + `toolSupport` (Mock-Llm `detectToolSupport`)
- **Chat-Tool-Loop:** `POST /api/chat` mit Mock-LLM (tool_calls → Ergebnis → finale Antwort)
- **Chat-Tool-Loop (kein Support):** `detectToolSupport() → false` → Fallback auf normalen Chat (keine Tools)

**Test-Setup:** `vitest` in devDependencies. Mocks für `McpManager` (Client) und `Llm` (chatWithTools). Bestehende Test-Dateien bleiben unverändert.

---

## Schritt 13: Docker / compose

**`compose.yml`** — keine zwingende Änderung (MCP-Server sind externe HTTP-Endpunkte, die `vui-server` per URL erreicht).

**Wichtige Hinweise:**

1. **Netzwerk-Erreichbarkeit:** Die `url` muss aus dem `vui-server`-Container erreichbar sein.
   - MCP-Server im selben Docker-Netzwerk → Container-Name als Host (z. B. `http://weather-mcp:8080/mcp`).
   - MCP-Server auf dem Host → `host.docker.internal` (bereits gemappt) oder das Host-Netzwerk.
   - Externe/Cloud-Server → öffentliche URL.

2. **Eigener Docker-Service pro MCP-Server (optional):** Anders als bei stdio kann jeder MCP-Server ein eigener Container sein (z. B. `weather-mcp`). `vui-server` verbindet sich per URL. `depends_on` für Start-Reihenfolge.

3. **Auth-Header:** Über das `headers`-Feld pro Server (wird an jeden Request durchgereicht, z. B. `Authorization`). Alternativ globale Env-Vars in `compose.yml` an `vui-server` + Platzhalter in der URL/Headers.

4. **Kein Subprozess-Management nötig** (im Gegensatz zu stdio). `vui-server` hält nur HTTP/SSE-Verbindungen zu den Servern.

---

## Dateibaum (Ergebnis)

```
server/
  package.json            ← ERWEITERT (@modelcontextprotocol/client)
  src/
    McpManager.js         ← NEU (Verbindungen + Tool-Registry + callTool)
    Config.js             ← ERWEITERT (mcpServers + validateMcpServers + slugify)
    Llm.js                ← ERWEITERT (chatWithTools + streamChatWithTools + detectToolSupport)
    Router/
      index.js            ← ERWEITERT (MCP-API + Chat-Tool-Loop + McpManager-Instanz)
    Server.js             ← ERWEITERT (mcp.close() im Shutdown)
  test/
    mcp.test.js           ← NEU
    config-mcp.test.js    ← NEU
    router-mcp.test.js    ← NEU
    llm-tools.test.js     ← NEU

frontend/
  src/
    api/
      mcp.js              ← NEU (MCP-API-Client)
    components/
      McpSettings.jsx     ← NEU (MCP-Tab: Liste + Add/Edit-Form)
    pages/
      SettingsPage.jsx    ← ERWEITERT (MCP-Tab)
    locales/
      en.json             ← ERWEITERT (mcp + settings.sections.mcp)
      de.json             ← ERWEITERT (mcp + settings.sections.mcp)
      it.json             ← ERWEITERT (mcp + settings.sections.mcp)
    style/
      components/
        mcp.css           ← NEU
        index.css         ← ERWEITERT (Import mcp.css)

config.json               ← ERWEITERT (mcpServers: [])
compose.yml               ← optional (Volume für lokale MCP-Server)
```

---

## Reihenfolge (Umsetzung)

| # | Schritt | Abhängigkeit |
|---|---------|-------------|
| 1 | Dependency `@modelcontextprotocol/client` | — |
| 2 | Config-Erweiterung (`mcpServers` + Validierung + slugify) | — |
| 3 | `McpManager.js` (Verbindungen + Tools + callTool) | 1, 2 |
| 4 | `Llm.js` Tool-Support (`chatWithTools` + `streamChatWithTools`) | 1 |
| 5 | MCP-API-Routen (`/api/mcp/*`) + `connectAll()` | 3 |
| 6 | Chat-Tool-Loop (`/api/chat` + `/api/chat/stream`) | 3, 4, 5 |
| 7 | Shutdown (`mcp.close()`) | 3 |
| 8 | Server-Tests (McpManager + Config + Router + Tool-Loop) | 3, 4, 5, 6 |
| 9 | Frontend MCP-API-Client (`api/mcp.js`) | 5 |
| 10 | Frontend MCP-Tab (`McpSettings.jsx` + SettingsPage) | 9 |
| 11 | i18n (mcp + settings.sections.mcp) | 10 |
| 12 | CSS (`mcp.css` + Import) | 10 |
| 13 | Docker/compose (Hinweise + optionales Volume) | 3 |

---

## Offene Punkte / Risiken

1. **LLM-Tool-Support:** Function-Calling setzt ein Backend voraus, das OpenAI-Tools unterstützt (LocalAI: ja, Ollama: modellabhängig). → **Gelöst:** `Llm.detectToolSupport()` (Capability-Detection, gecacht, bei Modell-Wechsel invalidiert) + Graceful Degradation (Fallback auf normalen Chat) + Log-Warnung + UI-Hinweis (`GET /api/mcp/capability` → `mcp.noToolSupport`). Optional: ReAct-Fallback (Prompt-basiertes Tool-Calling) für Tool-unfähige Modelle.
2. **Streaming + Tool-Loop:** Inkrementelle `tool_calls` im SSE-Stream korrekt rekonstruieren (OpenAI liefert `delta.tool_calls`). → In `streamChatWithTools` sorgfältig implementieren + testen.
3. **Transport-Fallback:** Streamable HTTP vs. legacy SSE — nicht alle Server unterstützen beide. → `transport: 'auto'` (Streamable HTTP zuerst, SSE-Fallback) + `transportType` im Status anzeigen.
4. **Tool-Namensraum:** `${serverId}__${toolName}` ändert den für das LLM sichtbaren Namen. → In Tool-Beschreibungen/Docs klarstellen. Alternative: Originalname + Server-Kontext in der Description.
5. **Netzwerk-Erreichbarkeit:** MCP-Server-URL muss aus dem `vui-server`-Container erreichbar sein (Docker-Netzwerk / `host.docker.internal` / Cloud). → Klare Fehlermeldung bei Connect-Fehlschlag (Timeout/Refused).
6. **Sicherheit:** MCP-Server-`headers` können Secrets enthalten (z. B. `Authorization`). → Nicht in Logs schreiben, nicht im `GET /api/mcp/servers`-Response offenlegen (ggf. maskieren).
