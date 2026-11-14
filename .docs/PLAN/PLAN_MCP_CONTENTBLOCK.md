# PLAN: MCP ContentBlock — ImageContent in Chat

## Ziel

MCP-Server können Tool-Ergebnisse mit **`ImageContent`-Blöcken** liefern (MCP-Spec 2026-07-28: `type:'image'`, `data`=base64, `mimeType`). VUI wirft diese heute stillschweigend weg.

Ziel:

- Das **LLM** (Vision-Modell) erhält das Bild als Teil des Tool-Ergebnisses.
- Der **User** sieht das Bild im Chat (Thumbnail + Lightbox).
- **Keine neue Dependency** — der MCP-SDK-Client liefert die Blöcke bereits in `result.content`.
- Graceful Degradation: kein Vision-Modell / kein Bild → exakt wie heute (Text-only).

Referenz: MCP-Spec `https://modelcontextprotocol.io/specification/2026-07-28/schema` (ContentBlock-Union: `TextContent | ImageContent | AudioContent | ResourceLink | EmbeddedResource`).

---

## Ausgangslage

| Schicht | Datei | Status heute |
|---|---|---|
| MCP-Client | `server/src/McpManager.js:217` (`callTool`) | filtert **nur** `type:'text'`, join zu String. `ImageContent` wird verworfen |
| Gateway | `server/src/Security/ExecutionGateway.js:67` (`executeRead`) | Größenlimit `security.maxToolResultBytes` (Default 64 KB) auf den **String**, harte Truncation |
| Untrusted | `server/src/Security/Untrusted.js` | `wrapUntrusted(content)` — String-Wrap |
| Tool-Loop | `server/src/Router/index.js:274` (streaming), `:770` (non-streaming) | SSE `tool_result` `{ id, content, isError }`; LLM-Message `{ role:'tool', tool_call_id, content }` (String) |
| Tool-Dispatch | `server/src/Router/index.js:655` (`handleToolCall`) | `executeRead` → `wrapUntrusted` → `{ content, isError }` |
| LLM | `server/src/Llm.js` | OpenAI-kompatibel + Ollama, Messages als Text |
| Stream-Hook | `frontend/src/hooks/useChatStream.js` | behandelt `thinking`/`answer`/`approval_*`/`done`/`error` — **`tool_result` wird ignoriert** |
| History | `frontend/src/hooks/useConversation.js` | Turns in `localStorage` (`vui:conversations`, max 50), `persist()` swallows Quota-Fehler |
| View | `frontend/src/components/ChatView.jsx` | User-Bubble + Assistant-Bubble (ThinkBlock, Markdown, Meta) |
| CSS | `frontend/src/style/components/chat.css` | BEM + CSS-Variablen |
| i18n | `frontend/src/locales/{en,de,it}.json` | i18next, Namespace `chat.*` |

**Kernproblem:** `callTool()` ist der einzige Engpass — dort gehen die Bilder verloren. Alles downstream (Gateway, Router, LLM, Frontend) arbeitet mit String.

---

## Architektur-Entscheidung

### Zwei unabhängige Pfade (Anzeige vs. LLM-Kontext)

Ein `ImageContent`-Block hat **zwei mögliche Ziele, die unabhängig voneinander entschieden werden**:

- **Pfad A — Anzeige im Chat:** Bild → SSE `tool_result` → Frontend rendert. **Immer aktiv**, wenn das MCP-Tool ein Bild liefert. Das ist der Fall "landet direkt im Chat, ohne in den LLM-Kontext zu wandern".
- **Pfad B — LLM-Kontext:** Bild → `role:'tool'`-Message → LLM. **Das LLM entscheidet pro Call**, ob es das Bild sehen will.

**Pfad B wird vom LLM selbst entschieden** (nicht statisches Config-Flag). Mechanismus:

1. Server injiziert `include_image` (optionales `boolean`) in das Tool-Schema, das das LLM sieht (`McpManager.toOpenAITools()`).
2. LLM ruft das Tool auf und gibt `include_image: true`, wenn es das zurückgegebene Bild sehen muss. System-Prompt weist an: *"Gib `include_image: true`, wenn du das Bild des Ergebnisses sehen musst, um gut zu antworten."*
3. Server liest `include_image` aus den Tool-Call-Args, **stript es vor dem Forward** an das MCP-Tool (das MCP-Tool sieht es nie), nutzt es für Pfad B.

**Pfad B-Logik:** `feedToLlm = (llmRequestedImage) && (visionEnabled())`

- `llmRequestedImage` = LLM hat `include_image: true` gesetzt (pro-Call-Entscheidung).
- `visionEnabled()` = **Capability-Gate** (nur noch "kann das Modell Vision?"), nicht mehr die Entscheidung:
  - `llm.vision` TriState `auto`/`true`/`false` (Default `auto`).
  - `auto` + Ollama → `GET /api/show?name=<modell>` → `capabilities` enthält `"vision"`? (verlässlich, gecacht).
  - `auto` + OpenAI → `false` (kein Capabilities-Endpoint).
  - `true`/`false` erzwingen.

Konsequenz: Bild wird **immer** angezeigt (Pfad A). Es landet **nur** im LLM-Kontext, wenn das LLM es per `include_image` angefordert UND das Modell Vision kann. LLM hat die Agency, Capability-Gate verhindert sinnlose/fehlerhafte Bild-Übergabe an Text-Modelle.

1. **Strukturiertes Ergebnis, String bleibt.** `callTool()` liefert `{ content: string, images: [{ mimeType, data }], isError }`. `content` bleibt der joined Text → Backward-Compat für Tests, Gateway, Audit, `wrapUntrusted`. `images` ist `[]` wenn keine.

2. **Bilder durchlaufen denselben Zero-Trust-Pfad wie Text** (Gateway-Timeout, Policy, Audit), haben aber ein **eigenes Größenlimit** (`security.maxToolImageBytes`). Ein Base64-Bild mitten zu truncieren = kaputtes Bild → zu große Bilder werden **verworfen + Text-Hinweis**, nicht abgeschnitten.

3. **LLM-Message je Backend** (Multimodal-Content-Parts im `role:'tool'`-Message):
   - **OpenAI-kompatibel:** `content: [{ type:'text', text }, { type:'image_url', image_url: { url: 'data:<mime>;base64,<data>' } }]`
   - **Ollama:** `content: [{ type:'text', text }, { type:'image', images: ['<base64>'] }]`
   - **Kein Vision-Modell:** plain String (wie heute).

4. **Pfad B wird vom LLM pro Call entschieden** (per `include_image`-Tool-Arg, injiziert in das Tool-Schema, gestript vor dem Forward). `llm.vision` ist nur noch ein **Capability-Gate** (TriState `auto`/`true`/`false`, Default `auto`): `auto` detectet bei Ollama via `/api/show` (verlässlich), bei OpenAI default `false`; `true`/`false` erzwingen. Kein Modell-Namen-Raten.

5. **Frontend: Bilder sind session-only.** `localStorage` hat ~5 MB Quota, ein einziges Base64-Bild sprengt das. `useConversation.persist()` **stript `images`** vor dem Write. In-Memory-State behält sie → sichtbar während der Session, nach Reload weg (Turn bleibt, ohne Bild).

6. **Anzeige über Data-URL** (`data:<mime>;base64,<data>`) — stateless, kein neuer HTTP-Endpunkt, kein CORS. `<img>`-Kontext ist inert (kein Script-Execution).

7. **SSE-Event bleibt backward-kompatibel:** `tool_result` bekommt optionales `images: [...]`. Altes Frontend (ignoriert das Event) bricht nicht.

---

## Schritt 1: Server — `McpManager.callTool()`

`server/src/McpManager.js:217`

```js
const blocks = result.content || [];
const content = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
const images = blocks
    .filter((b) => b.type === 'image' && typeof b.data === 'string' && typeof b.mimeType === 'string')
    .map((b) => ({ mimeType: b.mimeType, data: b.data }));
return { content, images, isError: Boolean(result.isError) };
```

- Fehler-Pfade (nicht verbunden, Client wirft): `{ content: msg, images: [], isError: true }`.
- `AudioContent`/`ResourceLink`/`EmbeddedResource` bleiben ignoriert (Scope: nur `ImageContent`).

## Schritt 1b: Server — `McpManager.toOpenAITools()` (`include_image` injizieren)

`server/src/McpManager.js:199`

Jedes Tool-Schema bekommt ein optionales `include_image`-Boolean, das das LLM sieht:

```js
toOpenAITools() {
    return this.listTools().map((t) => {
        const props = { ...(t.inputSchema?.properties || {}) };
        props.include_image = {
            type: 'boolean',
            description: 'Set to true if you need to SEE the returned image to answer well. The image is always shown to the user regardless.',
        };
        return {
            type: 'function',
            function: {
                name: t.name,
                description: t.description,
                parameters: { ...t.inputSchema, properties: props },
            },
        };
    });
}
```

- `include_image` ist **kein MCP-Tool-Arg** — der Server stript es vor dem Forward (Schritt 4). Das MCP-Tool sieht es nie.
- System-Prompt (Config `llm.systemPrompt` oder VirtualTools-Hinweis) weist an: *"Gib `include_image: true`, wenn du das Bild des Ergebnisses sehen musst."*

## Schritt 2: Server — `ExecutionGateway`

`server/src/Security/ExecutionGateway.js`

- Neuer Config-Key: `security.maxToolImageBytes` (Default **2 MB** = `2097152`), gelesen wie `#maxResultBytes()`.
- `executeRead()` (Zeile 67) und `executeApproved()` (Zeile 123) nach `callTool`:
  ```js
  const images = (result.images || []).filter((img) =>
      Buffer.byteLength(img.data, 'base64') <= maxImageBytes);
  const dropped = (result.images || []).length - images.length;
  if (dropped > 0) {
      content += `\n[IMAGE DROPPED: ${dropped} Bild(er) über maxToolImageBytes]`;
  }
  return { content, images, isError: result.isError };
  ```
- Text-Limit (`maxToolResultBytes`) bleibt unverändert, gilt nur für `content`.
- Audit-Metadata: `imageCount`, `droppedImageCount` (optional, `EXECUTION_COMPLETED`).

## Schritt 3: Server — `Llm` (Capability-Gate + Multimodal-Tool-Message)

`server/src/Llm.js`

- `visionEnabled()` ist nur noch ein **Capability-Gate** ("kann das Modell Vision?"), nicht die Entscheidung. Die Entscheidung trifft das LLM pro Call (`include_image`, siehe Schritt 1b/4).
- Config: `LLM_PARAMS` um `vision` (TriState `auto`/`true`/`false`, Default `auto`) erweitern → `getSettings`/`validateSettings`/Settings-UI (3-Wege-Toggle oder Dropdown).
- **Neuer Helper `visionEnabled()`** (async, gecacht):
  ```js
  async visionEnabled() {
      const v = this.config?.llm?.vision ?? 'auto';
      if (v === true) return true;
      if (v === false) return false;
      // auto
      if (this.#visionCache !== undefined) return this.#visionCache;
      const cfg = this.chatConfig;
      if (cfg.api === 'ollama') {
          try {
              const res = await axios.get(`${cfg.baseUrl}/api/show`, { params: { name: cfg.modelName } });
              this.#visionCache = Array.isArray(res.data?.capabilities) && res.data.capabilities.includes('vision');
          } catch { this.#visionCache = false; }
      } else {
          this.#visionCache = false; // openai: kein Capabilities-Endpoint
      }
      return this.#visionCache;
  }
  ```
  Cache wird bei Config-Änderung (Modell/Host) invalidiert.
- **Neuer Helper `buildToolMessage(content, images, backend)`**:
  ```js
  buildToolMessage(content, images = [], backend) {
      if (!images.length) return content; // wie heute
      if (backend === 'ollama') {
          return [
              { type: 'text', text: content },
              ...images.map((i) => ({ type: 'image', images: [i.data] })),
          ];
      }
      // openai-kompatibel
      return [
          { type: 'text', text: content },
          ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mimeType};base64,${i.data}` } })),
      ];
  }
  ```
- Backend-Erkennung: bestehende Logik in `Llm.js` (`llm.api === 'openai'`) wiederverwenden.
- `visionEnabled() === false` → Router ruft `buildToolMessage` nicht auf, Message bleibt String.

## Schritt 4: Server — `Router` (Dispatch + Tool-Loop + SSE)

`server/src/Router/index.js`

- **`include_image` lesen + strippen** (vor dem Forward an das MCP-Tool):
  ```js
  const { include_image: llmWantsImage, ...mcpArgs } = args; // LLM-Entscheidung
  const result = await this.security.gateway.execute(parsed.serverId, parsed.toolName, mcpArgs);
  ```
  Das MCP-Tool sieht `include_image` nie. `llmWantsImage` ist die pro-Call-Entscheidung des LLMs.
- `handleToolCall()` (Zeile 655): Rückgabe wird `{ content, images, isError, llmWantsImage }`:
  ```js
  return {
      content: wrapUntrusted(result.content), // Wrap gilt nur für den Text-Teil
      images: result.images || [],
      isError: result.isError,
      llmWantsImage: Boolean(llmWantsImage),
  };
  ```
  (deny/approval-Pfade: `images: []`, `llmWantsImage: false`.)
- **Streaming-Loop** (Zeile 274):
  ```js
  const vision = await this.llm.visionEnabled(); // Capability-Gate, gecacht
  const feedToLlm = result.llmWantsImage && vision; // LLM-Entscheidung AND Capability
  send('tool_result', { id: call.id, content, isError, images }); // Pfad A: IMMER
  messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: feedToLlm ? this.llm.buildToolMessage(content, images, backend) : content, // Pfad B: gated
  });
  ```
- **Non-Streaming-Loop** (Zeile 770): identisch.
- Non-Streaming-Response (`POST /api/chat`): aggregierte `images: [...]` optional im Payload (für API-Consumer; Frontend nutzt Streaming).

## Schritt 5: Frontend — `useChatStream`

`frontend/src/hooks/useChatStream.js`

- State um `images: []` erweitern (Reset bei `run()`-Start).
- Event-Handling im `for await`-Loop:
  ```js
  } else if (event === 'tool_result') {
      if (data && Array.isArray(data.images)) {
          images.push(...data.images);
          setState({ images: [...images] });
      }
  }
  ```
- `run()`-Rückgabe: `{ thinking, answer, error, images, tokens, model }`.
- `setResult()` akzeptiert `images` (Default `[]`).

## Schritt 6: Frontend — `useConversation` (Persistence-Schutz)

`frontend/src/hooks/useConversation.js`

- `updateTurn(id, { images })` funktioniert ohne Änderung (Patch-Mechanik).
- **`persist()` stript Bilder** (Quota-Schutz):
  ```js
  function stripImages(state) {
      return {
          ...state,
          conversations: state.conversations.map((c) => ({
              ...c,
              turns: c.turns.map(({ images, ...rest }) => rest),
          })),
      };
  }
  // persist(): localStorage.setItem(STORAGE_KEY, JSON.stringify(stripImages(state)));
  ```
- In-Memory-State behält `images` → Live-Anzeige bleibt, nach Reload sind Bilder weg (Turn bleibt).

## Schritt 7: Frontend — Komponenten (ChatImage + Lightbox + ChatView)

### Neu: `frontend/src/components/ChatImage.jsx`

```jsx
export default function ChatImage({ mimeType, data, alt, onOpen }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <div className="msg__image msg__image--error">{t('chat.image.error')}</div>;
  }
  return (
    <img
      className="msg__image"
      src={`data:${mimeType};base64,${data}`}
      alt={alt || t('chat.image.alt')}
      loading="lazy"
      onError={() => setFailed(true)}
      onClick={() => onOpen && onOpen({ mimeType, data })}
    />
  );
}
```

### Neu: `frontend/src/components/ImageLightbox.jsx`

- Props: `{ image: { mimeType, data } | null, onClose }`.
- Fixed-Overlay (z-index über Chat), `<img>` max 90vw/90vh, Close-Button + Esc + Backdrop-Klick.
- `useEffect` für `keydown` (Escape) mit Cleanup.

### `ChatView.jsx` (Erweiterung)

- Lightbox-State: `const [lightbox, setLightbox] = useState(null);`
- Pro Turn:
  ```jsx
  const itemImages = isLive ? (images || []) : (item.images || []);
  ```
  (`images` aus `useChatStream()` für den Live-Turn.)
- Rendering nach der Answer-Bubble, vor `turn__meta`:
  ```jsx
  {itemImages.length > 0 && (
    <div className="msg__images">
      {itemImages.map((img, i) => (
        <ChatImage key={i} {...img} onOpen={setLightbox} />
      ))}
    </div>
  )}
  ```
- Am Ende: `{lightbox && <ImageLightbox image={lightbox} onClose={() => setLightbox(null)} />}`
- Scroll-Logik (`useLayoutEffect`) um `images` in die Dependency-Liste nehmen (neues Bild → ggf. nach unten scrollen, wenn User unten ist).

## Schritt 8: Frontend — i18n

`frontend/src/locales/{en,de,it}.json` — unter `chat`:

```json
"image": {
  "alt": "Bild aus Tool-Ergebnis",
  "error": "Bild konnte nicht geladen werden.",
  "close": "Schließen"
}
```

(EN: "Image from tool result" / "Image could not be loaded." / "Close"; IT analog.)

## Schritt 9: Frontend — CSS

`frontend/src/style/components/chat.css` (BEM, CSS-Variablen wie bestehend):

```css
.msg__images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.msg__image {
  max-width: 240px;
  max-height: 240px;
  object-fit: contain;
  border-radius: 8px;
  border: 1px solid var(--border, #ccc);
  background: var(--surface-2, #f5f5f5);
  cursor: zoom-in;
}
.msg__image--error {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 120px;
  min-height: 60px;
  padding: 8px;
  font-size: 0.8rem;
  color: var(--text-muted, #888);
  cursor: default;
}
.lightbox {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.8);
}
.lightbox img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
}
.lightbox__close {
  position: absolute;
  top: 16px;
  right: 16px;
  /* Button-Styling wie bestehende Icon-Buttons */
}
```

## Schritt 9b: Frontend — Security-Settings-UI (alle Werte in die UI)

**Entscheidung (Punkt 3):** Alle Security-Limit-Werte + `llm.vision` in die Settings-UI — nicht nur config-only.

### Neu: `frontend/src/components/SecuritySettings.jsx`

Folgt dem `McpSettings.jsx`-Muster (`getSettings()`/`updateSettings()`, optimistischer Update + sofortiger Save via `PUT /api/settings`). Felder (alle `security.*`):

| Feld | Typ | Default | Hinweis |
|---|---|---|---|
| `maxToolTurns` | number | 10 | max. Tool-Runden pro Turn |
| `maxToolResultBytes` | number | 65536 | Text-Limit (Bytes) |
| `maxToolImageBytes` | number | 2097152 | **NEU** Bild-Limit (Bytes) |
| `toolTimeoutMs` | number | 30000 | Tool-Timeout |
| `maxPendingActions` | number | 20 | offene Approval-Aktionen |
| `approvalTtlMs` | number | 600000 | Approval-TTL |
| `systemPrompt` | textarea | '' | Security-System-Prompt |

- Laden: `getSettings()` → `data.security.*` in Local-State.
- Speichern: `updateSettings({ security: { <geändertes Feld>: value } })` → `applied`/`restartRequired` anzeigen (wie `McpSettings`).
- `toolPolicies`/`allowedHosts`/`virtualTools` bleiben in `McpSettings` (bereits da) — keine Duplikate.

### `SettingsPage.jsx` (Erweiterung)

- `TABS` um `{ id: 'security', title: 'settings.sections.security' }` ergänzen.
- Render: `{activeTab === 'security' ? <SecuritySettings /> : ...}`.

### `llm.vision` in den `llm`-Tab

- `SECTIONS` → `llm.fields` um `{ key: 'vision', type: 'select', label: 'settings.fields.llmVision', options: ['auto','true','false'] }` ergänzen (TriState-Dropdown).
- `useSettings`/`appSettings` schreiben `llm.vision` mit (Gruppe `llm`).

### i18n (Schritt 8 ergänzen)

```json
"settings": {
  "sections": { "security": "Security" },
  "fields": {
    "maxToolTurns": "Max. Tool-Runden",
    "maxToolResultBytes": "Max. Tool-Ergebnis (Bytes)",
    "maxToolImageBytes": "Max. Bildgröße (Bytes)",
    "toolTimeoutMs": "Tool-Timeout (ms)",
    "maxPendingActions": "Max. offene Aktionen",
    "approvalTtlMs": "Approval-TTL (ms)",
    "securitySystemPrompt": "Security-System-Prompt",
    "llmVision": "Vision (auto/true/false)"
  }
}
```

## Schritt 10: Tests

### Server (`server/test/`, vitest)

| Test-Datei | Fall |
|---|---|
| `mcp.test.js` | Mock-Client liefert `[{type:'text'},{type:'image'}]` → `callTool()` gibt `images:[{mimeType,data}]` + Text zurück; nur Text → `images: []`; Fehler-Pfad → `images: []` |
| `security-gateway.test.js` | Bild ≤ Limit → behalten; Bild > `maxToolImageBytes` → verworfen + `[IMAGE DROPPED` im Text; Text-Limit bleibt unabhängig |
| `router-mcp.test.js` | SSE `tool_result` enthält `images` (immer); `include_image:true` + `vision:true` → LLM-Message (openai) `image_url`-Part / (ollama) `image`-Part; `include_image:false` → String; `vision:false` → String (Gate); `include_image` wird vor dem Forward gestript (MCP-Tool sieht es nie) |
| `llm.test.js` | `buildToolMessage()` je Backend, leer → String |

### Frontend (`frontend/src/`, vitest + Testing-Library)

| Test-Datei | Fall |
|---|---|
| `useChatStream.test.js` | `tool_result` mit `images` → `result.images` gefüllt; ohne `images` → `[]` |
| `useConversation.test.js` (neu) | `updateTurn` mit `images` → in State; `persist()` → localStorage-String enthält **kein** `images` |
| `ChatImage.test.jsx` (neu) | rendert `<img>` mit Data-URL; `onError` → Fallback-Box; Klick → `onOpen` |
| `ChatView.test.jsx` (erweitern) | Turn mit `images` → `<img>` sichtbar; Lightbox öffnet/schließt |
| `SecuritySettings.test.jsx` (neu) | lädt `security.*` aus `getSettings()`; Feld-Change → `updateSettings({security:{...}})`; `maxToolImageBytes`-Feld vorhanden |

## Dateibaum (Ergebnis)

```
server/src/McpManager.js                 # callTool(): images extrahieren; toOpenAITools(): include_image injizieren
server/src/Security/ExecutionGateway.js  # maxToolImageBytes, Drop-Logik
server/src/Security/PolicyEngine.js      # (ggf. Config-Default maxToolImageBytes)
server/src/Config.js                     # security.maxToolImageBytes, llm.vision
server/src/Llm.js                        # visionEnabled() (Gate), buildToolMessage()
server/src/Router/index.js               # include_image lesen/strippen, Tool-Loops, SSE images
server/test/mcp.test.js                  # + ImageContent-Fälle
server/test/security-gateway.test.js     # + Bild-Limit-Fälle
server/test/router-mcp.test.js           # + SSE/LLM-Message-Fälle
server/test/llm.test.js                  # + buildToolMessage-Fälle
frontend/src/hooks/useChatStream.js      # images sammeln
frontend/src/hooks/useConversation.js    # persist() stript images
frontend/src/components/ChatImage.jsx    # NEU
frontend/src/components/ImageLightbox.jsx# NEU
frontend/src/components/ChatView.jsx     # Bilder + Lightbox rendern
frontend/src/components/ChatImage.test.jsx # NEU
frontend/src/components/SecuritySettings.jsx # NEU (alle Security-Werte + maxToolImageBytes)
frontend/src/pages/SettingsPage.jsx       # + security-Tab, llm.vision im llm-Tab
frontend/src/locales/{en,de,it}.json     # chat.image.*, settings.security.*, settings.fields.*
frontend/src/style/components/chat.css   # .msg__images, .lightbox
```

## Sicherheits-Notizen

- **Untrusted Data:** Bild-Inhalt kann das LLM beeinflussen (Prompt-Injection via Bild). Der Text-Teil bleibt `wrapUntrusted`; das Bild ist reines Data. Akzeptiertes Risiko, dokumentiert.
- **Größenlimit:** `maxToolImageBytes` (Default 2 MB) verhindert Memory-/Quota-Explosion. Drop statt Truncation.
- **Frontend:** `<img>` mit Data-URL ist inert (kein Script-Execution). Kein `dangerouslySetInnerHTML`.
- **Keine Secrets:** Bilder fließen nur Server→Client (SSE) und Client→LLM (API). Kein Persist, kein Upload.

## Offene Fragen (vor Implementierung klären)

Pfad A (Anzeige) ist immer an und braucht keine Entscheidung. Pfad B (LLM-Kontext) wird **vom LLM pro Call entschieden** (`include_image`), gated durch die Capability (`llm.vision`).

1. **LLM-entscheidet-Mechanismus (`include_image`):** OK? LLM gibt `include_image: true` im Tool-Call, wenn es das Bild sehen will; Server stript es vor dem Forward, nutzt es für Pfad B. System-Prompt weist an. (Alternative: statisches Config-Flag statt LLM-Entscheidung — aber du wolltest LLM-Entscheidung.)
2. **Capability-Gate `llm.vision` TriState `auto`/`true`/`false` (Default `auto`):** OK? `auto` detectet bei Ollama via `/api/show` (verlässlich), bei OpenAI default `false`. `true`/`false` erzwingen. **Welches Modell läuft real?** (Ollama: `llava`/`qwen2.5vl`/`minicpm-v`; OpenAI-kompatibel: `gpt-4o` etc.) — bestimmt, ob `auto` bei dir "ja" oder "nein" ergibt.
3. **`security.maxToolImageBytes` Default 2 MB:** OK? (Gilt für beide Pfade — ein zu großes Bild wird dropped, egal ob es ans LLM ginge.) **Entschieden: alle Security-Werte + `llm.vision` in die Settings-UI** (neuer Security-Tab, siehe Schritt 9b) — nicht nur config-only.
4. **Non-Streaming `POST /api/chat`:** aggregierte `images` im Response-Payload nötig oder nur Streaming? (Empfehlung: nur Streaming — das Frontend nutzt `/api/chat/stream`, Non-Streaming bleibt schlank.)

## Agent-Workflow (sequenzielle Sub-Agenten)

Umsetzung in **6 sequenzielle Schritte**. Jeder Schritt ist ein eigenständiger Sub-Agent-Lauf: klare Scope, Voraussetzung (Vor-Schritt), Definition of Done (Tests). Die Schritte laufen **nacheinander** — jeder baut auf dem Ergebnis des Vor-Schritts auf. Ein Sub-Agent bekommt: diesen Abschnitt + die referenzierten Plan-Schritte + die betroffenen Dateien.

**Ausführungsregel:** Schritt N startet erst, wenn Schritt N-1 seine Definition of Done erfüllt (Tests grün). Kein Schritt überspringt einen anderen.

### Schritt A — Server: Datenfluss (Bilder extrahieren + Limit)
- **Scope:** `McpManager.callTool()` (Schritt 1), `McpManager.toOpenAITools()` (Schritt 1b), `ExecutionGateway` (Schritt 2), `Config.js` (`maxToolImageBytes`).
- **Voraussetzung:** keine (Start).
- **Ergebnis:** `callTool()` liefert `{ content, images, isError }`; `toOpenAITools()` injiziert `include_image`; Gateway droppt über große Bilder + Text-Hinweis; `maxToolImageBytes` in Config.
- **Definition of Done:** `mcp.test.js` + `security-gateway.test.js` grün (neue Fälle: ImageContent-Extraktion, `include_image`-Injection, Bild-Drop).

### Schritt B — Server: LLM + Router (Gate + Dispatch + SSE)
- **Scope:** `Llm.js` (Schritt 3: `visionEnabled()`, `buildToolMessage()`), `Router/index.js` (Schritt 4: `include_image` lesen/strippen, Tool-Loops, SSE `images`).
- **Voraussetzung:** Schritt A (Bilder + `include_image` vorhanden).
- **Ergebnis:** `feedToLlm = llmWantsImage && vision`; SSE `tool_result` enthält `images` (immer); LLM-Message multimodal nur wenn gated; `include_image` vor dem Forward gestript.
- **Definition of Done:** `llm.test.js` + `router-mcp.test.js` grün (neue Fälle: Gate-Logik, SSE `images`, `include_image`-Stripping, Backend-Message-Formate).

### Schritt C — Frontend: Datenfluss (Hooks)
- **Scope:** `useChatStream.js` (Schritt 5: `images` sammeln), `useConversation.js` (Schritt 6: `persist()` stript `images`).
- **Voraussetzung:** Schritt B (SSE sendet `images`).
- **Ergebnis:** `result.images` gefüllt bei `tool_result`; Live-Turn hat `images`; `persist()` schreibt kein `images` nach localStorage.
- **Definition of Done:** `useChatStream.test.js` + `useConversation.test.js` grün.

### Schritt D — Frontend: Anzeige (Komponenten + CSS + i18n)
- **Scope:** `ChatImage.jsx` (neu), `ImageLightbox.jsx` (neu), `ChatView.jsx` (Schritt 7), `chat.css` (Schritt 9), i18n `chat.image.*` (Schritt 8).
- **Voraussetzung:** Schritt C (`images` im State).
- **Ergebnis:** Bilder unter der Answer-Bubble; Lightbox (Klick/Esc/Backdrop); Fallback-Box bei Fehler; i18n in en/de/it.
- **Definition of Done:** `ChatImage.test.jsx` + `ChatView.test.jsx` grün; Build (`npm run build`) fehlerfrei.

### Schritt E — Frontend: Security-Settings-UI
- **Scope:** `SecuritySettings.jsx` (neu), `SettingsPage.jsx` (security-Tab + `llm.vision` im llm-Tab), i18n `settings.*`.
- **Voraussetzung:** Schritt A (`maxToolImageBytes` + `llm.vision` in Config existieren).
- **Ergebnis:** Security-Tab mit allen `security.*`-Feldern + `maxToolImageBytes`; `llm.vision`-Dropdown; Save via `updateSettings`.
- **Definition of Done:** `SecuritySettings.test.jsx` grün; Build fehlerfrei.

### Schritt F — Integration + End-to-End-Verifikation
- **Scope:** gesamtes System (Server + Frontend).
- **Voraussetzung:** Schritte A–E.
- **Ergebnis:** kompletter Pfad: MCP-Tool liefert Bild → Server extrahiert + limitiert → SSE → Frontend rendert → (optional) LLM sieht Bild. Settings-UI ändert Limits zur Laufzeit.
- **Definition of Done:** alle Server-Tests + alle Frontend-Tests grün; `npm run build` (beide) fehlerfrei; manueller Smoke-Test: Bild-Tool-Call → Bild im Chat sichtbar, Lightbox öffnet, `include_image:true` + Vision-Modell → LLM antwortet bildbezogen.

**Sequenz:** A → B → C → D → E → F. (C/D/E sind Frontend, können nach B parallelisiert werden, wenn gewünscht — aber die Vorgabe ist nacheinander.)
