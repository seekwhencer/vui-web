# PLAN: Virtuelle Tools (`get_config`, `get_mcp`, `get_policies`, `get_stats`)

## 1. Ziel & Scope

Das LLM soll Server-Informationen **auf Anfrage** abrufen können — als virtuelle Tools, die der Server in die Tool-Liste injiziert und lokal auflöst (kein Netzwerk, kein MCP).

| Tool | Liefert |
|------|---------|
| `get_config` | Aktuelle Server-Configuration (LLM, Whisper, Security, MCP-Status, Badwords, Server) |
| `get_mcp` | Konfigurierte MCP-Server mit Einstellungen, Verbindungsstatus und Tool-Listen |
| `get_policies` | Tool-Policies (read/write/execute/deny) + SSRF-Allowlist |
| `get_stats` | Laufzeit-Statistiken (Uptime, LLM-Token-Nutzung, MCP-Verbindungen, Transkriptionen) |

| Aspekt | Verhalten |
|--------|-----------|
| Trigger | LLM entscheidet, wann es welches Tool aufruft (z. B. „Welches Modell ist konfiguriert?" → `get_config`, „Welche MCP-Tools gibt es?" → `get_mcp`) |
| Auflösung | Server-seitig, deterministisch, kein LLM-Call für die Antwort |
| Kosten | 1 Tool-Call pro Aufruf (Tokens für Tool-Definition + Response), keine zusätzlichen LLM-Runden |
| Sichtbarkeit | Jedes Tool ist in jedem Turn verfügbar (Teil der Tool-Liste) |
| Deaktivierung | Jedes Tool einzeln per Toggle in Settings > MCP (Sektion „Built-in Tools") |

**Nicht im Scope:**
- Config-Werte ändern (dafür gibt es die Settings-Seite).
- Neue MCP-Server oder Security-Policy-Änderungen.
- Frontend-Autocomplete (nicht nötig — LLM entscheidet).

---

## 2. Konzept

### 2.1 Virtuelle Tools (Definitionen)

Der Server injiziert bei jedem Chat-Request die aktiven virtuellen Tools in die `tools`-Liste, die an das LLM gesendet wird:

**`get_config`**

```json
{
  "type": "function",
  "function": {
    "name": "get_config",
    "description": "Liefert die aktuelle VUI-Server-Configuration als strukturiertes Markdown. Aufrufen, wenn der Nutzer nach Konfiguration, Modell-Einstellungen, Security-Parametern, Whisper-Settings oder MCP-Server-Status fragt.",
    "parameters": {
      "type": "object",
      "properties": {
        "section": {
          "type": "string",
          "enum": ["llm", "whisper", "security", "mcp", "badwords", "server"],
          "description": "Optionale Sektion. Weglassen für die vollständige Config."
        }
      },
      "required": []
    }
  }
}
```

**`get_mcp`**

```json
{
  "type": "function",
  "function": {
    "name": "get_mcp",
    "description": "Liefert die konfigurierten MCP-Server mit Einstellungen, Verbindungsstatus und Tool-Listen. Aufrufen, wenn der Nutzer nach MCP-Servern, deren Konfiguration, Status oder verfügbaren Tools fragt.",
    "parameters": {
      "type": "object",
      "properties": {
        "serverId": {
          "type": "string",
          "description": "Optionale Server-ID. Weglassen für alle Server."
        }
      },
      "required": []
    }
  }
}
```

**`get_policies`**

```json
{
  "type": "function",
  "function": {
    "name": "get_policies",
    "description": "Liefert die Tool-Policies (read/write/execute/deny) und die SSRF-Allowlist. Aufrufen, wenn der Nutzer nach Berechtigungen, Freigaben oder der Security-Policy fragt.",
    "parameters": {
      "type": "object",
      "properties": {
        "serverId": {
          "type": "string",
          "description": "Optionale Server-ID. Weglassen für alle Policies."
        }
      },
      "required": []
    }
  }
}
```

**`get_stats`**

```json
{
  "type": "function",
  "function": {
    "name": "get_stats",
    "description": "Liefert Laufzeit-Statistiken: Uptime, LLM-Token-Nutzung, MCP-Verbindungen, Transkriptionen. Aufrufen, wenn der Nutzer nach Nutzung, Token-Verbrauch oder Systemstatus fragt.",
    "parameters": {
      "type": "object",
      "properties": {
        "section": {
          "type": "string",
          "enum": ["llm", "mcp", "transcriptions"],
          "description": "Optionale Sektion. Weglassen für alle Statistiken."
        }
      },
      "required": []
    }
  }
}
```

### 2.2 Auflösung (Server-seitig)

Im Tool-Call-Loop in `Router/index.js`:

```
LLM antwortet mit tool_call: get_config({ section: "llm" })
  → Router erkennt: Tool-Name ist "get_config" (virtuell, kein MCP)
  → Router ruft resolveVirtualTool("get_config", args, { config, mcp, stats }) auf
  → Ergebnis: Markdown-String
  → Router sendet tool_result an LLM
  → LLM formuliert Antwort basierend auf dem Markdown
```

**Wichtig:**
- Kein Netzwerk-Call, kein MCP-Client.
- Die Auflösung ist synchron und deterministisch.
- Das LLM sieht das Tool wie jedes andere Tool — es weiß nicht, dass es lokal aufgelöst wird.

### 2.3 `get_config` — Markdown-Dokument

`get_config` erzeugt ein strukturiertes Markdown-Dokument aus `config.getSettings()`:

```markdown
# VUI Configuration

## LLM
| Parameter | Wert |
|-----------|------|
| api | openai |
| host | 127.0.0.1 |
| port | 8080 |
| model | qwen3.5:2b |

## Whisper
| Parameter | Wert |
|-----------|------|
| language | de |
| temperature | [0.0] |
| beamSize | 5 |

## Security
| Parameter | Wert |
|-----------|------|
| maxToolTurns | 10 |
| maxToolResultBytes | 65536 |
| toolTimeoutMs | 30000 |

## MCP-Server
| ID | Name | URL | Status |
|----|------|-----|--------|
| … | … | … | … |

## Badwords
- word1
- word2

## Server
| Parameter | Wert |
|-----------|------|
| serverPort | 3000 |
| verbose | false |
```

**Sensibilität:**
- `systemPrompt` wird **nicht** angezeigt (kann Secrets enthalten).
- `headers` von MCP-Servern werden **nicht** angezeigt (können API-Keys enthalten).
- Alle anderen Werte sind lokal und nicht sensibel.

### 2.4 `get_mcp` — Markdown-Dokument

`get_mcp` erzeugt ein Markdown-Dokument aus `mcp.listServers()` + `mcp.connections` (Tool-Listen):

```markdown
# MCP-Server

## my-server
| Parameter | Wert |
|-----------|------|
| name | My Server |
| url | https://mcp.example.com/sse |
| transport | streamable-http |
| enabled | true |
| status | connected |
| toolCount | 3 |

### Tools
| Tool | Beschreibung |
|------|--------------|
| search | Sucht in der Datenbank |
| insert | Fügt einen Eintrag hinzu |
| delete | Löscht einen Eintrag |

## other-server
| Parameter | Wert |
|-----------|------|
| name | Other |
| url | http://192.168.1.50:9000 |
| enabled | true |
| status | error |
| error | Verbindung fehlgeschlagen |
```

**Verhalten:**
- `serverId` gesetzt → nur dieser Server. Unbekannte ID → `isError: true` mit Liste der gültigen IDs.
- `headers` werden **nicht** angezeigt (API-Keys).
- Server ohne Verbindung: `status` + `error` (falls vorhanden), keine Tool-Tabelle.

### 2.5 `get_policies` — Markdown-Dokument

`get_policies` erzeugt ein Markdown-Dokument aus `config.security.toolPolicies` + `config.security.allowedHosts`:

```markdown
# MCP-Policies

Default: **deny** (nicht konfigurierte Tools sind gesperrt)

## my-server
| Tool | Policy |
|------|--------|
| search | read |
| insert | write |
| delete | deny |

## other-server
(keine Policies gesetzt — alle Tools: deny)

## SSRF-Allowlist
- 192.168.1.100
- ollama.local
```

**Verhalten:**
- Policies sind namespaced: `${serverId}__${toolName}` (siehe `PolicyEngine.js`).
- `serverId` gesetzt → nur Policies dieses Servers. Unbekannte ID → `isError: true`.
- `allowedHosts` leer → „(leer — nur localhost/127.0.0.1 erlaubt)".
- Hinweis im Dokument: Virtuelle Tools (`get_config`, `get_mcp`, `get_policies`, `get_stats`) sind **nicht** policy-geschützt — sie werden lokal aufgelöst, bevor der Policy-Check greift.

### 2.6 `get_stats` — Markdown-Dokument

`get_stats` erzeugt ein Markdown-Dokument aus einem neuen `Stats`-Collector (siehe 3.1) + Live-MCP-Daten:

```markdown
# VUI Stats

## Server
| Parameter | Wert |
|-----------|------|
| uptime | 3h 12m |
| startedAt | 2026-11-13T07:24:00Z |

## LLM
| Parameter | Wert |
|-----------|------|
| requests | 42 |
| promptTokens | 12345 |
| completionTokens | 6789 |
| totalTokens | 19134 |

## MCP
| Parameter | Wert |
|-----------|------|
| configured | 2 |
| connected | 1 |
| tools | 5 |

## Transkriptionen
| Parameter | Wert |
|-----------|------|
| count | 128 |
```

**Verhalten:**
- `section` gesetzt → nur diese Sektion. Unbekannter Wert → `isError: true` mit Liste der gültigen Sektionen.
- Alle Werte sind lokal und nicht sensibel (keine Prompts, keine Inhalte).
- Stats sind **in-memory** (Reset bei Server-Neustart) — bewusst, kein Persistenz-Overhead.

### 2.7 Vergleich: Virtuelles Tool vs. Slash-Command

| Kriterium | Virtuelles Tool (gewählt) | Slash-Command (`/config`) |
|-----------|---------------------------|---------------------------|
| Trigger | LLM (kontextuell) | User (explizit) |
| Setup | Tool-Definition + Resolver | Command-Parser + Handler |
| Token-Kosten | Tool-Def (~50 Tokens) + Response | Keine (kein LLM-Call) |
| LLM-Awareness | Immer (Tool in jeder Request) | Nur nach `/config`-Aufruf |
| Extensibilität | Neue Tools trivial hinzufügen | Neue Commands manuell registrieren |
| UX | Natürlich („Zeig mir die Config") | Mechanisch (`/config` tippen) |
| Risiko | LLM ruft Tool unnötig auf | User vergisst Command |

**Entscheidung:** Virtuelles Tool. Natürlichere UX, LLM kann kontextuell entscheiden, und die Architektur ist auf weitere virtuelle Tools erweiterbar. Die ersten vier Tools (`get_config`, `get_mcp`, `get_policies`, `get_stats`) sind in diesem Plan enthalten.

---

## 3. Architektur

### 3.1 Server-seitig

#### Neue Datei: `server/src/VirtualTools.js`

```
server/src/VirtualTools.js
```

Verantwortlichkeiten:
- Tool-Definitionen (JSON-Schema für das LLM) — alle vier Tools.
- Resolver-Registry (Tool-Name → Handler).
- `getVirtualToolDefinitions()` → Array von Tool-Definitionen.
- `resolveVirtualTool(name, args, ctx)` → `{ content, isError }`.
- Markdown-Renderer: `renderConfigMarkdown`, `renderMcpMarkdown`, `renderPoliciesMarkdown`, `renderStatsMarkdown`.

```js
// Pseudocode
const VIRTUAL_TOOLS = {
  get_config: {
    definition: { /* JSON-Schema wie oben */ },
    handler: (args, ctx) => renderConfigMarkdown(ctx.config, ctx.mcp, args.section),
  },
  get_mcp: {
    definition: { /* JSON-Schema wie oben */ },
    handler: (args, ctx) => renderMcpMarkdown(ctx.mcp, args.serverId),
  },
  get_policies: {
    definition: { /* JSON-Schema wie oben */ },
    handler: (args, ctx) => renderPoliciesMarkdown(ctx.config, args.serverId),
  },
  get_stats: {
    definition: { /* JSON-Schema wie oben */ },
    handler: (args, ctx) => renderStatsMarkdown(ctx.stats, ctx.mcp, args.section),
  },
};

export function getVirtualToolDefinitions() {
  return Object.values(VIRTUAL_TOOLS).map(t => t.definition);
}

export function resolveVirtualTool(name, args, ctx) {
  const tool = VIRTUAL_TOOLS[name];
  if (!tool) return { content: `Unbekanntes virtuelles Tool: ${name}`, isError: true };
  try {
    return { content: tool.handler(args, ctx), isError: false };
  } catch (err) {
    return { content: `Fehler: ${err.message}`, isError: true };
  }
}
```

`ctx` = `{ config, mcp, stats }` — wird vom Router gebaut und an alle Handler übergeben.

#### Neue Datei: `server/src/Stats.js`

In-memory-Collector für Laufzeit-Statistiken (Reset bei Neustart, bewusst nicht persistent):

```js
// Pseudocode
export class Stats {
  constructor() {
    this.startedAt = Date.now();
    this.llm = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.transcriptions = { count: 0 };
  }

  recordLlm(usage) {
    // usage: { prompt, completion, total } — aus dem 'stats'-Chunk (Streaming)
    // oder aus der Response (Non-Streaming). Fehlende Werte → 0.
    this.llm.requests += 1;
    this.llm.promptTokens += usage?.prompt ?? 0;
    this.llm.completionTokens += usage?.completion ?? 0;
    this.llm.totalTokens += usage?.total ?? 0;
  }

  recordTranscription() {
    this.transcriptions.count += 1;
  }

  snapshot(mcp) {
    // Merged Live-MCP-Daten (configured/connected/tools) + Uptime.
    return {
      server: { startedAt: this.startedAt, uptimeMs: Date.now() - this.startedAt },
      llm: { ...this.llm },
      mcp: {
        configured: mcp.listServers().length,
        connected: mcp.listServers().filter(s => s.status === 'connected').length,
        tools: mcp.listServers().reduce((n, s) => n + (s.tools?.length ?? 0), 0),
      },
      transcriptions: { ...this.transcriptions },
    };
  }
}
```

Instanziiert in `Server.js` (neben `security`), an `Router` übergeben. `TranscribeBridge` erhält einen optionalen `onTranscription`-Callback (oder die `Stats`-Instanz) und inkrementiert bei jeder erfolgreichen Transkription.

#### Änderung: `server/src/Router/index.js`

**A) Tool-Liste erweitern:**

In `buildChatMessages()` (oder wo auch immer die `tools`-Array für den LLM-Request gebaut wird):

```js
// Bestehende MCP-Tools + virtuelle Tools:
const tools = [
  ...mcpTools,           // bestehende MCP-Tool-Definitionen
  ...getVirtualToolDefinitions(),  // NEU: virtuelle Tools
];
```

**B) Tool-Call-Auflösung erweitern:**

Im Tool-Call-Loop (wo MCP-Tool-Calls aufgelöst werden):

```js
// Vor dem MCP-Call:
if (VIRTUAL_TOOL_NAMES.has(toolName)) {
  const ctx = { config: this.config, mcp: this.mcp, stats: this.stats };
  const result = resolveVirtualTool(toolName, args, ctx);
  // result.content als tool_result an LLM zurückgeben
  return;
}
// Sonst: bestehender MCP-Pfad
```

**C) Stats erfassen:**

- **Streaming:** Im bestehenden Loop, wo `chunk.phase === 'stats'` empfangen wird → `this.stats.recordLlm(chunk.tokens)`.
- **Non-Streaming:** `chatWithTools()`/`chat()` liefern künftig `usage` mit (siehe Llm.js unten) → `this.stats.recordLlm(usage)` nach jedem Turn.

**D) Kein anderer Code-Pfad wird berührt.**

#### Änderung: `server/src/Llm.js` (additiv)

- `_extractOpenAITurn()` / `_extractOllamaTurn()` liefern zusätzlich `usage` (`{ prompt, completion, total }`) — OpenAI: `res.data.usage`, Ollama: `prompt_eval_count`/`eval_count`.
- Rückgabe-Objekt von `chatWithTools()`/`chat()` wird um `usage` erweitert (bestehende Felder bleiben unverändert → backward-kompatibel).
- Streaming-Pfad bleibt unverändert (liefert bereits `phase: 'stats'`).

#### Änderung: `server/src/Bridge/TranscribeBridge.js` (additiv)

- Optionaler `onTranscription`-Callback im Konstruktor (oder `stats`-Instanz).
- Bei erfolgreicher Transkription (Wyoming `transcript`-Event) → Callback aufrufen → `stats.recordTranscription()`.
- Bei Fehler: **kein** Inkrement (nur erfolgreiche Transkriptionen zählen).

#### Änderung: `server/src/Config.js`

Optional: Neue Methode `toMarkdown(section?)`:

```js
toMarkdown(section) {
  // Erzeugt das Config-Markdown-Dokument.
  // Verwendet getSettings() + mcp.listServers() für Status.
  // Filtert sensible Felder (systemPrompt, headers).
  // section: 'llm' | 'whisper' | 'security' | 'mcp' | 'badwords' | 'server' | undefined
}
```

Alternativ: Die Markdown-Erzeugung lebt in `VirtualTools.js` und nutzt `config.getSettings()` + `mcp.listServers()`.

### 3.2 Frontend-seitig: Built-in Tools in MCP-Settings

#### Neue Sektion in `McpSettings.jsx`

Oben in der MCP-Settings-Seite, **vor** der MCP-Server-Liste, erscheint ein eigener Abschnitt:

```
┌─────────────────────────────────────────────────────────┐
│ Built-in Tools                                          │
├─────────────────────────────────────────────────────────┤
│ [●] get_config                                          │
│     Liefert die aktuelle Server-Configuration.          │
│                                                         │
│ [●] get_mcp                                             │
│     Liefert MCP-Server, Status und Tool-Listen.         │
│                                                         │
│ [●] get_policies                                        │
│     Liefert Tool-Policies und SSRF-Allowlist.           │
│                                                         │
│ [●] get_stats                                           │
│     Liefert Laufzeit-Statistiken (Tokens, Uptime, …).   │
└─────────────────────────────────────────────────────────┘
```

Die Liste wird **generisch** aus `getVirtualToolDefinitions()` gerendert (Name + Description) — neue virtuelle Tools erscheinen automatisch, ohne Frontend-Änderung.

- **Badge:** „Built-in" (unterscheidet von MCP-Servern).
- **Toggle:** Enable/Disable-Button (wie bei MCP-Servern).
- **Beschreibung:** Kurze Tool-Description aus der Definition.
- **Status:** `enabled` / `disabled` (kein `connected`/`disconnected` — kein Netzwerk).

#### Persistenz

Der Toggle-State wird in `config.json` gespeichert:

```json
{
  "security": {
    "virtualTools": {
      "get_config": true,
      "get_mcp": true,
      "get_policies": true,
      "get_stats": true
    }
  }
}
```

- **Default:** `true` (aktiviert) — fehlt der Key, ist das Tool aktiv.
- **API:** `PUT /api/settings` mit `{ security: { virtualTools: { get_stats: false } } }`.
- **Lesen:** `GET /api/settings` → `data.security.virtualTools`.

#### Server: Conditional Injection

In `Router/index.js`:

```js
// Tool-Liste bauen:
const virtualTools = getVirtualToolDefinitions();
const enabledVirtualTools = virtualTools.filter(t => {
  const name = t.function.name;
  const flag = this.config.getSettings().security?.virtualTools?.[name];
  return flag !== false; // Default: true
});

const tools = [
  ...mcpTools,
  ...enabledVirtualTools,
];
```

Wenn ein Tool deaktiviert ist (z. B. `get_stats`):
- Tool wird **nicht** in die LLM-Request-`tools`-Liste injiziert.
- LLM kann es nicht aufrufen.
- Resolver bleibt vorhanden (falls ein alter Request noch einen Call enthält → Fehler-Response).

#### Änderung: `server/src/Config.js`

- `getSettings()` liefert `security.virtualTools` (neues Feld, Default `{}`).
- `updateSettings()` akzeptiert `security.virtualTools` und persistiert es.
- Validierung: Keys müssen bekannte virtuelle Tool-Namen sein.

#### i18n-Keys (`de.json`)

```json
{
  "mcp": {
    "builtinTools": {
      "title": "Built-in Tools",
      "hint": "Virtuelle Tools, die der Server lokal auflöst. Kein Netzwerk nötig.",
      "enabled": "Aktiviert",
      "disabled": "Deaktiviert"
    }
  }
}
```

#### Chat-Verhalten (unverändert)

- Das LLM ruft `get_config` auf → Tool-Call wird im Chat als „Thinking" angezeigt (bestehendes Verhalten).
- Die Antwort (Markdown) wird normal gerendert (bestehendes Markdown-Rendering in `ChatView.jsx`).
- Kein Autocomplete, keine Command-Parsing, keine neuen API-Endpunkte.

---

## 4. API-Design

### 4.1 Bestehende Endpunkte (unverändert)

```
POST /api/chat
POST /api/chat/stream
```

### 4.2 Request-Body (unverändert)

```json
{
  "question": "Welches LLM-Modell ist konfiguriert?",
  "history": [...]
}
```

### 4.3 LLM-Request (intern, erweitert)

```json
{
  "model": "qwen3.5:2b",
  "messages": [...],
  "tools": [
    { "type": "function", "function": { "name": "mcp_tool_1", ... } },
    { "type": "function", "function": { "name": "get_config", ... } }
  ]
}
```

### 4.4 Tool-Call-Flow (Streaming)

```
event: thinking
data: {"tool": "get_config", "args": {}}

event: thinking
data: {"tool": "get_config", "result": "# VUI Configuration\n\n## LLM\n…"}

event: answer
data: "Dein LLM-Modell ist qwen3.5:2b auf 127.0.0.1:8080."

event: done
data: {}
```

### 4.5 Fehlerfall (unbekannte Sektion)

```json
{
  "content": "Unbekannte Sektion: 'foo'. Verfügbare: llm, whisper, security, mcp, badwords, server.",
  "isError": true
}
```

Das LLM erhält den Fehler als `tool_result` und kann korrigieren oder dem User antworten.

---

## 5. Datei-Änderungen

| Datei | Änderung | Typ |
|-------|----------|-----|
| `server/src/VirtualTools.js` | Neu: Tool-Definitionen (4 Tools), Resolver-Registry, Markdown-Renderer | Neu |
| `server/src/Stats.js` | Neu: In-memory-Stats-Collector (LLM-Tokens, Transkriptionen, Uptime) | Neu |
| `server/src/Router/index.js` | Tool-Liste erweitern (conditional) + Tool-Call-Auflösung + Stats-Erfassung | Edit |
| `server/src/Config.js` | `security.virtualTools` in `getSettings()` + `updateSettings()`; optional `toMarkdown(section?)` | Edit |
| `server/src/Llm.js` | `chatWithTools()`/`chat()` liefern `usage` (additiv, backward-kompatibel) | Edit |
| `server/src/Bridge/TranscribeBridge.js` | `onTranscription`-Callback → Stats-Counter | Edit |
| `server/src/Server.js` | `Stats` instanziieren, an Router + TranscribeBridge übergeben | Edit |
| `server/test/virtual-tools.test.js` | Neu: Unit-Tests für alle 4 Tools (Resolver, Renderer, Toggle-Logik) | Neu |
| `server/test/router-chat.test.js` | Ergänzung: Tests für Tool-Calls (enabled + disabled) + Stats-Erfassung | Edit |
| `frontend/src/components/McpSettings.jsx` | Neue Sektion „Built-in Tools" mit Toggles (generisch aus Definitionen) | Edit |
| `frontend/src/api/settings.js` | Optional: Helper für `virtualTools`-Toggle (oder direkt via bestehendem `updateSettings`) | Edit |
| `frontend/src/locales/de.json` | i18n-Keys für Built-in Tools Sektion | Edit |
| `frontend/src/style/components/mcp.css` | Styles für Built-in Tools Sektion (Badge, Toggle) | Edit |

**Nicht geändert:**
- `frontend/src/hooks/useChatStream.js` (bleibt unverändert)
- `frontend/src/api/chat.js` (bleibt unverändert)
- `frontend/src/components/ChatView.jsx` (Markdown-Rendering existiert bereits)
- `frontend/src/components/ChatInput.jsx` (kein Autocomplete nötig)
- `server/src/Security/SystemPrompt.js` (bleibt unverändert)
- `server/src/McpManager.js` (bleibt unverändert — `listServers()`/`connections` liefern die Daten)

---

## 6. Tests

### 6.1 Server: `server/test/virtual-tools.test.js` (neu)

```
describe('getVirtualToolDefinitions')
  - liefert Array mit genau 4 Tools
  - alle Tools haben name, description, parameters
  - 'get_config'.parameters.section ist optional, enum mit 6 Werten
  - 'get_stats'.parameters.section ist optional, enum mit 3 Werten
  - 'get_mcp'.parameters.serverId ist optional (string)
  - 'get_policies'.parameters.serverId ist optional (string)

describe('resolveVirtualTool — get_config')
  - ohne section → Markdown enthält '## LLM', '## Whisper', '## Security'
  - mit section='llm' → Markdown enthält NUR '## LLM'
  - mit section='mcp' → Markdown enthält '## MCP-Server'
  - → Markdown enthält NICHT 'systemPrompt' (sensibel)
  - → Markdown enthält NICHT 'headers' (sensibel)
  - mit section='foo' → isError: true

describe('resolveVirtualTool — get_mcp')
  - ohne serverId → Markdown enthält alle konfigurierten Server
  - mit serverId → Markdown enthält NUR diesen Server
  - mit unbekannter serverId → isError: true + Liste gültiger IDs
  - → Markdown enthält NICHT 'headers' (sensibel)
  - Server mit status='error' → enthält 'error'-Zeile, keine Tool-Tabelle
  - Server mit Tools → enthält Tool-Tabelle (Name + Beschreibung)

describe('resolveVirtualTool — get_policies')
  - → Markdown enthält 'Default: **deny**'
  - → Markdown enthält Policies des Servers (Tool + Policy)
  - Server ohne Policies → '(keine Policies gesetzt — alle Tools: deny)'
  - → Markdown enthält SSRF-Allowlist (oder '(leer …)')
  - mit unbekannter serverId → isError: true

describe('resolveVirtualTool — get_stats')
  - → Markdown enthält '## Server', '## LLM', '## MCP', '## Transkriptionen'
  - mit section='llm' → Markdown enthält NUR '## LLM'
  - mit section='foo' → isError: true + Liste gültiger Sektionen
  - nach recordLlm({prompt: 10, completion: 5, total: 15}) → 'promptTokens | 10'
  - nach recordTranscription() → 'count | 1'
  - → Markdown enthält NICHT Prompt-Inhalte (nur Zahlen)

describe('resolveVirtualTool — allgemein')
  - 'unbekanntes_tool' → isError: true
  - Handler wirft Exception → isError: true + Fehlermeldung

describe('Stats')
  - recordLlm() akkumuliert requests + Tokens
  - recordLlm(undefined) → keine Exception, requests += 1
  - recordTranscription() inkrementiert count
  - snapshot(mcp) → enthält server/llm/mcp/transcriptions
```

### 6.2 Server: `server/test/router-chat.test.js` (ergänzen)

```
describe('POST /api/chat — virtuelle Tools')
  - LLM ruft get_config auf → tool_result enthält '## LLM'
  - LLM ruft get_config mit section='whisper' auf → tool_result enthält NUR '## Whisper'
  - LLM ruft get_mcp auf → tool_result enthält Server-Liste, NICHT 'headers'
  - LLM ruft get_policies auf → tool_result enthält 'Default: **deny**'
  - LLM ruft get_stats auf → tool_result enthält '## LLM' + Token-Zahlen
  - LLM ruft virtuelles Tool auf → ruft MCP NICHT auf (kein Netzwerk)
  - LLM ruft get_config auf → systemPrompt NICHT im tool_result

describe('POST /api/chat/stream — virtuelle Tools')
  - LLM ruft get_config auf → SSE: thinking (tool_call) + thinking (tool_result) + answer + done
  - LLM ruft get_stats auf → tool_result enthält '## LLM'
  - nach Chat-Request → stats.llm.requests >= 1 (Stats-Erfassung)

describe('Conditional Injection')
  - virtualTools.get_config=false → get_config NICHT in tools-Liste
  - virtualTools.get_stats=false → get_stats NICHT in tools-Liste, andere Tools vorhanden
  - virtualTools={} (leer) → alle 4 Tools in tools-Liste (Default: aktiv)
```

### 6.3 Frontend

- Manuell testen: „Zeig mir die Config" → LLM ruft `get_config` auf → Markdown erscheint im Chat.
- Manuell testen: „Welche MCP-Server sind konfiguriert?" → LLM ruft `get_mcp` auf.
- Manuell testen: „Welche Tools sind erlaubt?" → LLM ruft `get_policies` auf.
- Manuell testen: „Wie viele Tokens wurden verbraucht?" → LLM ruft `get_stats` auf.
- Manuell testen: Normale Frage ohne Config → LLM ruft KEIN virtuelles Tool auf.
- Manuell testen: Toggle in MCP-Settings → Tool wird aktiviert/deaktiviert → LLM kann es nicht mehr aufrufen.

---

## 7. Sicherheit

| Risiko | Maßnahme |
|--------|----------|
| Secrets in Config-Markdown | `systemPrompt` und MCP `headers` werden **nicht** im Markdown angezeigt (gilt für `get_config` UND `get_mcp`). |
| Prompt-Injection via Tool-Name | Tool-Namen sind eine feste Whitelist (`get_config`, `get_mcp`, `get_policies`, `get_stats`). Keine dynamische Ausführung. |
| DoS via sehr langer Section-String | `section` ist ein Enum (6 bzw. 3 Werte). `serverId` wird gegen bekannte IDs geprüft. Ungültige Werte → Fehler-Response. |
| SSRF via MCP-URL im Markdown | MCP-URLs werden als Text angezeigt, nicht als klickbare Links. |
| Stats enthalten sensible Daten | `get_stats` liefert nur Zahlen (Tokens, Counts, Uptime) — keine Prompts, keine Inhalte, keine URLs. |
| Policies zeigen Freigaben | `get_policies` zeigt nur Policy-Klassen (read/write/execute/deny) + Allowlist-Hosts — lokal, nicht sensibel. |
| LLM ruft Tool unnötig auf | Tool-Descriptions sind präzise („Aufrufen, wenn der Nutzer nach … fragt"). Kein Zwang. |
| Tool-Definitionen vergrößern Prompt | ~50 Tokens pro Tool pro Request (4 Tools ≈ 200 Tokens). Akzeptabler Overhead; deaktivierbare Tools reduzieren den Overhead. |

---

## 8. Rollout

### Phase 1: Server (MVP)
1. `server/src/Stats.js` erstellen (Collector: LLM-Tokens, Transkriptionen, Uptime).
2. `server/src/Llm.js` anpassen (`usage` in `chatWithTools()`/`chat()` liefern — additiv).
3. `server/src/Bridge/TranscribeBridge.js` anpassen (`onTranscription`-Callback).
4. `server/src/VirtualTools.js` erstellen (4 Tool-Definitionen + Resolver-Registry + 4 Markdown-Renderer).
5. `server/src/Config.js` anpassen (`security.virtualTools` in `getSettings()` + `updateSettings()`).
6. `server/src/Server.js` anpassen (`Stats` instanziieren, an Router + TranscribeBridge übergeben).
7. `server/src/Router/index.js` anpassen (conditional Tool-Liste + Tool-Call-Auflösung + Stats-Erfassung).
8. `server/test/virtual-tools.test.js` + `router-chat.test.js` ergänzen.
9. `npm test` in `/server` → alle Tests grün.

### Phase 2: Frontend (UI)
10. `frontend/src/components/McpSettings.jsx` — neue Sektion „Built-in Tools" mit Toggles (generisch aus Definitionen).
11. `frontend/src/locales/de.json` — i18n-Keys.
12. `frontend/src/style/components/mcp.css` — Styles für Built-in Tools.
13. Manuell testen: Toggle in MCP-Settings → Tool wird aktiviert/deaktiviert.

### Phase 3: Verifikation
14. Manuell testen: „Zeig mir die Config" → LLM ruft `get_config` auf.
15. Manuell testen: „Welche MCP-Server sind konfiguriert?" → LLM ruft `get_mcp` auf.
16. Manuell testen: „Welche Tools sind erlaubt?" → LLM ruft `get_policies` auf.
17. Manuell testen: „Wie viele Tokens wurden verbraucht?" → LLM ruft `get_stats` auf.
18. Manuell testen: Normale Frage → LLM ruft KEIN virtuelles Tool auf.
19. Manuell testen: Tool deaktivieren → LLM kann es nicht mehr aufrufen.

### Phase 4: Härtung
20. Edge-Cases: leere Config, keine MCP-Server, leere Policies, Stats nach Neustart (Reset).
21. Lint + Typecheck (falls vorhanden).

---

## 9. Offene Fragen

1. **Soll `get_config` die MCP-Server-Status (connected/disconnected) anzeigen?**
   → Ja, empfohlen. `mcp.listServers()` liefert den Status.

2. **Soll das Tool auch in der System-Prompt erwähnt werden?**
   → Nein. Die Tool-Definition ist selbst-deskriptiv. Das LLM sieht sie in der `tools`-Liste.

3. **Soll es ein `get_help`-Tool geben, das alle verfügbaren Tools auflistet?**
   → Nein. Das LLM sieht bereits alle Tools in der `tools`-Liste. Redundant.

4. **Soll `get_config` auch die Env-Variablen anzeigen, die die Config überschreiben?**
   → Nein. Die Config zeigt den *effektiven* Wert (env > file > default). Die Herkunft ist nicht relevant.

5. **Soll das Tool auch für Non-Streaming (`POST /api/chat`) funktionieren?**
   → Ja. Der Tool-Call-Loop ist identisch für Streaming und Non-Streaming.

6. **Sollen `get_stats`-Werte über Server-Neustarts persistiert werden?**
   → Nein. In-memory ist bewusst gewählt (kein Persistenz-Overhead, kein `data/`-File). Reset bei Neustart ist dokumentiert.

7. **Soll `get_mcp` die vollständigen Tool-Beschreibungen anzeigen?**
   → Namen + kurze Beschreibung (max. ~100 Zeichen, abgeschnitten). Vollständige Beschreibungen wären zu lang für den Prompt.

8. **Soll `get_policies` auch den Approval-Flow (ApprovalService) anzeigen?**
   → Nein. Nur die Policy-Klassen (read/write/execute/deny) + SSRF-Allowlist. Der Approval-Flow ist ein separater Mechanismus.

9. **Soll `get_stats` auch die Anzahl der MCP-Tool-Calls zählen?**
   → Optional, Phase 4. Der `ExecutionGateway` könnte einen Counter liefern. Nicht im MVP.

---

## 10. Abarbeitungs-Reihenfolge & Aufwand

Aufwands-Skala: **1** = trivial (< 15 Min) … **5** = halber Tag … **10** = ganzer Tag +.

| # | Schritt | Dateien | Aufwand (1–10) | Abhängigkeit |
|---|---------|---------|:--------------:|--------------|
| 1 | `Stats`-Collector erstellen (`recordLlm`, `recordTranscription`, `snapshot`) | `server/src/Stats.js` | 2 | — |
| 2 | `Llm.js`: `usage` aus OpenAI/Ollama-Turns extrahieren, `chatWithTools()`/`chat()` liefern es additiv | `server/src/Llm.js` | 3 | — |
| 3 | `TranscribeBridge`: `onTranscription`-Callback, bei Wyoming-`transcript`-Event aufrufen | `server/src/Bridge/TranscribeBridge.js` | 2 | 1 |
| 4 | `VirtualTools.js`: 4 Tool-Definitionen + Resolver-Registry + `ctx`-Handling | `server/src/VirtualTools.js` | 3 | — |
| 5 | Markdown-Renderer (alle 4): `renderConfigMarkdown`, `renderMcpMarkdown`, `renderPoliciesMarkdown`, `renderStatsMarkdown` | `server/src/VirtualTools.js` | 5 | 4 |
| 6 | `Config.js`: `security.virtualTools` in `getSettings()`/`updateSettings()` + Validierung | `server/src/Config.js` | 2 | — |
| 7 | `Server.js`: `Stats` instanziieren, an Router + TranscribeBridge injizieren | `server/src/Server.js` | 2 | 1, 3 |
| 8 | `Router/index.js`: conditional Tool-Liste, Tool-Call-Auflösung (virtuell vor MCP), Stats-Erfassung (Streaming + Non-Streaming) | `server/src/Router/index.js` | 5 | 1, 2, 4, 5, 6, 7 |
| 9 | Tests: `virtual-tools.test.js` (neu) + `router-chat.test.js` (ergänzen) → `npm test` grün | `server/test/*` | 4 | 8 |
| 10 | Frontend: Built-in-Tools-Sektion in `McpSettings.jsx` (generisch) + i18n + CSS + manuelle Verifikation (alle 4 Tools, Toggles, Edge-Cases, Lint) | `frontend/src/*` | 6 | 6 |

**Gesamt: ~34 Aufwandspunkte ≈ 2–3 Arbeitstage** (inkl. Tests + Frontend + Verifikation).

**Kritischer Pfad:** 1 → 3 → 7 → 8 → 9 (Server-Kern). Frontend (10) kann parallel zu 4–9 laufen.

**Empfohlene Batch-Größe pro Arbeitszyklus:**
- **Zyklus A (Server-Fundament):** 1, 2, 3, 6, 7 — alle unabhängig, ~11 Punkte.
- **Zyklus B (Tools + Renderer):** 4, 5 — ~8 Punkte.
- **Zyklus C (Integration + Tests):** 8, 9 — ~9 Punkte.
- **Zyklus D (Frontend + Verifikation):** 10 — ~6 Punkte.
