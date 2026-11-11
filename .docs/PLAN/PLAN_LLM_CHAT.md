# PLAN: LLM Chat für VUI (verfeinert)

## Ziel

LLM-Chat-Funktionalität aus `gitea-qdrant-sync` nach `vui` portieren — **ohne** Qdrant/Vektor-Suche.
Reiner Chat (Streaming + History), der später per Voice (Whisper-Transkript) gefüttert wird.

## Ausgangslage

| Aspekt | gitea-qdrant-sync (Quelle) | vui (Ziel) |
|---|---|---|
| LLM-Service | `server/llm.js` (embed + chat + stream) | fehlt |
| Chat-Route | `POST /search/stream` (SSE) | fehlt |
| Config | `CHAT_API`, `CHAT_URL`, `CHAT_MODEL` | `LLM_HOST`, `LLM_PORT` (leer) in `.env` + `compose.yml` |
| Frontend-Chat | `useSearchStream` + `useConversation` + Komponenten | fehlt |
| Markdown | `react-markdown` + `remark-gfm` | **bereits in `package.json`** |
| i18n | keine | i18next (en/de/it), Sektionen `transcription`, `status`, `settings` |
| CSS | BEM-Klassen, eigene Dateien | CSS-Variablen + `style/components/*.css`, `.btn`-Klassen vorhanden |
| Server-HTTP | `axios` | **bereits in `package.json`** |
| LLM-Backend | Ollama / OpenAI-kompatibel | LocalAI (OpenAI-kompatibel) via `localai/` |
| Settings-UI | keine | `SettingsPanel.jsx` (Whisper-Parameter, Sektionen-basiert) |
| Topbar | — | `SettingsToggle`, `ThemeToggle`, `LanguageSwitcher` (keine Nav) |
| Tests | — | `server/test/` leer, `vitest` in devDependencies |

## Architektur-Entscheidung

- **Kein Qdrant, kein Embedding.** Nur `chat()` + `streamChat()` aus `llm.js`.
- **LLM-Backend:** OpenAI-kompatible API (LocalAI). `LLM_HOST` + `LLM_PORT` bereits in `.env`/`compose.yml`.
- **Streaming:** SSE (`text/event-stream`) — identisch zum gitea-qdrant-sync-Pattern.
- **History:** `localStorage` (kein Server-State) — identisch zum gitea-qdrant-sync-Pattern.
- **Voice-Anbindung:** `useTranscription` (bestehend) liefert Text → `useChatStream` konsumiert ihn. Kein eigener Voice-Chat-Endpoint nötig. ChatPage integriert beide Hooks.

### Kern-Refinements gegenüber dem Originalplan

1. **Dynamisches Config-Reading (wichtig):** `Llm` liest `config.llm.*` **zur Aufrufzeit** (Getter), nicht im Konstruktor. So wirken Settings-Änderungen (via `PUT /api/settings`) sofort, ohne Neustart — exakt das etablierte `TranscribeBridge`-Pattern (`this.config?.whisperHost` pro Call). Der Originalplan hätte Werte im Konstruktor eingefroren.
2. **Config-Konsistenz:** LLM-Parameter als deklarative `LLM_PARAMS`-Spec (analog `WHISPER_PARAMS`) + verschachteltes `this.llm`-Objekt (analog `this.whisper`), statt flacher `this.llmApi`-Zeilen. Einheitliches Validate/Merge/Persist.
3. **LocalAI-Service wiederverwenden:** Der (kommentierte) `vui-tts`-LocalAI-Container kann TTS **und** Chat bedienen (LocalAI beides). `LLM_HOST` auf denselben Container zeigen, statt einen zweiten `vui-llm`-Service zu starten. Gemeinsames `localai/models`-Verzeichnis.
4. **Topbar-Navigation fehlt im Original:** Die Topbar hat aktuell **keine** Nav-Links (nur Toggles). Neue `TopNav`-Komponente (Tabs: Transkription | Chat) ergänzen.
5. **Settings-UI für LLM fehlt im Original:** `SettingsPanel.jsx` um eine „LLM“-Sektion erweitern (Host, Port, Modell, System-Prompt) + i18n + CSS.
6. **i18n-Deduplizierung:** Bestehende `status.*`-Keys (`disconnected`/`ready`/`recording`/`error`) wiederverwenden statt neuer `voice.status.*`.
7. **CSS-Wiederverwendung:** Bestehende `.btn`, `.btn--primary`, `.btn--secondary` (in `transcription.css` global definiert) nutzen statt neuer `.chat-input__button`.
8. **Think-Tag-Extraktion behalten:** Die Inline-`think`-Tag-Logik aus `useSearchStream` (OPEN_TAG/CLOSE_TAG) übernehmen — manche Modelle emittieren Thinking inline im Content, nicht als `reasoning_content`-Feld.
9. **SSE-Events vereinfachen:** Für reinen Chat `thinking`, `answer`, `done`, `error` (kein `empty`, kein `status` nötig — keine Search-Phasen).
10. **LLM-nicht-konfiguriert-Handling:** `LLM_HOST` leer → Chat-Endpunkte liefern 503 mit klarem Fehler, statt ungültige URL `http://:8080/v1` zu bauen.

---

## Schritt 1: Server — LLM-Service

**Datei:** `server/src/Llm.js` (neu)

Aus `gitea-qdrant-sync/server/llm.js` übernehmen, **ohne** Embedding-Teile, **mit** dynamischem Config-Reading:

- `class Llm`
  - `constructor({ config, logger })` — nimmt das **Config-Objekt**, keine Einzelwerte
  - `get chatConfig()` — **Getter**, liest `config.llm.*` zur Aufrufzeit:
    ```js
    get chatConfig() {
        const llm = this.config?.llm || {};
        const api = (llm.api === 'openai') ? 'openai' : 'ollama';
        const host = llm.host || '';
        const port = llm.port || 8080;
        const base = (api === 'openai')
            ? `http://${host}:${port}/v1`
            : `http://${host}:${port}`;
        return { api, baseUrl: this.normalizeUrl(base), modelName: llm.model || '' };
    }
    ```
  - `normalizeUrl(url)`
  - `async chat(messages, options)` — non-streaming, Ollama + OpenAI
  - `async *_readSSE(body)` — SSE-Parser
  - `async *_readNDJSON(body)` — NDJSON-Parser (Ollama)
  - `async *streamChunks(messages, options)` — raw chunks
  - `async *streamChat(messages, options)` — `{ phase, token }`

**Nicht übernehmen:** `embed()`, `_embeddingCache`, `embeddingsConfig`.

**Wichtig:** `chat()`/`streamChunks()`/`streamChat()` nutzen `this.chatConfig` (Getter) statt eines im Konstruktor gesetzten `this.chatConfig`-Properties. So wirken Runtime-Settings-Änderungen sofort.

**Config-Parameter** (aus `config.llm`, siehe Schritt 2):
```
api           → 'openai' (LocalAI ist OpenAI-kompatibel)
baseUrl       → `http://${host}:${port}/v1` (openai) bzw. `http://${host}:${port}` (ollama)
modelName     → config.llm.model
```

---

## Schritt 2: Server — Config-Erweiterung

**Datei:** `server/src/Config.js` (bestehend)

**Neue `LLM_PARAMS`-Spec** (analog `WHISPER_PARAMS`, oben im File):

```js
const LLM_PARAMS = {
    api:          { env: 'LLM_API',           type: 'string',  default: 'openai' },
    host:         { env: 'LLM_HOST',          type: 'string',  default: '' },
    port:         { env: 'LLM_PORT',          type: 'integer', default: 8080 },
    model:        { env: 'LLM_MODEL',         type: 'string',  default: '' },
    systemPrompt: { env: 'LLM_SYSTEM_PROMPT', type: 'string',  default: 'You are a helpful assistant. Answer in markdown format.' },
};
```

**Konstruktor** — verschachteltes `this.llm` (analog `this.whisper`):
```js
this.llm = this.resolveLlmParams(loaded);
```

**Neue Methode** `resolveLlmParams(loaded)` (analog `resolveWhisperParams`):
- env > config.json > Default, pro Feld via `parseEnvValue`
- `port` als Integer parsen

**`getSettings()`** → `llm: { ...this.llm }` hinzufügen

**`validateSettings()`** → Validierung für `llm`-Felder:
- `api` ∈ {`openai`, `ollama`}
- `host` String
- `port` Integer 1–65535
- `model` String
- `systemPrompt` String

**`updateSettings()`** → Deep-Merge für `llm` (analog `whisper`):
```js
llm: { ...current.llm, ...(patch.llm || {}) }
```

**`persist()`** → `llm: this.llm` in `config.json` schreiben

**`saveDefaults()`** → `llm`-Defaults aus `LLM_PARAMS` schreiben

**`runtimeKeys`** → `'llm'` hinzufügen (wirkt ohne Neustart, da `Llm` dynamisch liest)

**`.env`** — `LLM_HOST` und `LLM_PORT` sind bereits vorhanden. `LLM_MODEL` ergänzen.

**`compose.yml`** — `LLM_MODEL` an `vui-server` durchreichen.

---

## Schritt 3: Server — Chat-Route

**Datei:** `server/src/Router/index.js` (bestehend)

Zwei Endpunkte ergänzen (analog zu gitea-qdrant-sync `router.js`):

### `POST /api/chat`
Non-streaming. Body: `{ question, history? }`.
- `history` = optionales Array `{ role, content }` (frühere Nachrichten)
- Antwort: `{ success: true, data: { answer } }`

### `POST /api/chat/stream`
SSE-Streaming. Body: `{ question, history? }`.
- Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`
- Events: `thinking`, `answer`, `done`, `error` (vereinfacht, keine Search-Phasen)
- `AbortController` + `res.on('close')` für Client-Abbruch
- System-Prompt aus `config.llm.systemPrompt`
- Message-Reihenfolge: `system` → `history` → aktuelle `question`

**LLM-nicht-konfiguriert-Handling:**
- Vor dem Stream-Start prüfen: `if (!this.config.llm?.host)` → `res.status(503).json({ success: false, error: 'LLM is not configured. Set LLM_HOST.' })`
- Gilt für beide Endpunkte (`/api/chat` und `/api/chat/stream`).

**Instanziierung:** `Llm`-Instanz im `Router`-Konstruktor erzeugen (wie `TranscribeBridge`):
```js
this.llm = new Llm({ config: this.config, logger: this.logger });
```

---

## Schritt 4: Frontend — API-Client

**Datei:** `frontend/src/api/chat.js` (neu)

```js
// POST /api/chat → { answer }
// POST /api/chat/stream → async generator { event, data }
```

- `chat(question, history)` — non-streaming
- `chatStream(question, history)` — async generator, SSE-Parser
- SSE-Parser: identisch zu `gitea-qdrant-sync/frontend/src/api/client.js` (`searchStream`)
- `history` im Request-Body mitsenden

---

## Schritt 5: Frontend — Hooks

### `frontend/src/hooks/useChatStream.js` (neu)

Analog zu `useSearchStream` aus gitea-qdrant-sync, **ohne** Qdrant-Status-Phasen:

- State: `thinking`, `answer`, `question`, `pending`, `error`, `done`
- **Kein** `phase`, **kein** `statusMessage` (keine Embedding/Search-Phasen)
- `run(question, history)` → iteriert über `chatStream(question, history)`
- Thinking-Extraktion:
  - Server-Events: `event === 'thinking'` → `thinking`, `event === 'answer'` → `answer`
  - **Inline-Think-Tags behalten:** OPEN_TAG/CLOSE_TAG-Logik aus `useSearchStream` übernehmen (manche Modelle emittieren `think` inline im Content)
- `setResult({ thinking, answer, error, question })` — für History-Selektion

### `frontend/src/hooks/useConversation.js` (neu)

1:1 aus gitea-qdrant-sync, nur `STORAGE_KEY` auf `'vui:chat-history'` ändern.

---

## Schritt 6: Frontend — Komponenten

### `frontend/src/components/ChatInput.jsx` (neu)
- Textarea + Send-Button
- `onSubmit(text)`, `disabled` prop
- Enter = senden, Shift+Enter = Zeilenumbruch
- i18n-Platzhalter
- **Send-Button:** bestehende `.btn .btn--primary`-Klassen nutzen (nicht neu definieren)
- **Controlled mode:** `value` + `onChange` Props (damit ChatPage das Voice-Transkript setzen kann)

### `frontend/src/components/ChatView.jsx` (neu)
- Zeigt `thinking` (ThinkBlock) + `answer` (Markdown)
- Auto-Scroll (`useLayoutEffect`)
- States: loading (Spinner), empty, streaming, error
- i18n-Texte
- **Spinner:** bestehende `.spinner`-Klasse nutzen (falls vorhanden) oder neu in `chat.css`

### `frontend/src/components/ThinkBlock.jsx` (neu)
- 1:1 aus gitea-qdrant-sync (expand/collapse)
- i18n-Labels (`chat.thinking`, `chat.hideThinking`)

### `frontend/src/components/Markdown.jsx` (neu)
- 1:1 aus gitea-qdrant-sync (`react-markdown` + `remark-gfm`)

### `frontend/src/components/ChatHistory.jsx` (neu)
- Liste der History-Items
- `onSelect`, `onRemove`
- i18n-Texte
- **Delete-Button:** bestehende `.btn .btn--secondary` oder Icon-Button

---

## Schritt 7: Frontend — ChatPage

**Datei:** `frontend/src/pages/ChatPage.jsx` (neu)

Layout:
```
┌─────────────────────────────────────────────┐
│  ChatHistory (links, optional)              │
│  ┌───────────────────────────────────────┐  │
│  │  ChatView (thinking + answer)         │  │
│  │                                       │  │
│  │  ChatInput (textarea + send)          │  │
│  └───────────────────────────────────────┘  │
└─────────────────────────────────────────────┘
```

- `useChatStream` + `useConversation`
- `handleSubmit(question)`:
  1. History-Item anlegen (`pending: true`)
  2. `run(question, history)` aufrufen
  3. History-Item aktualisieren (`pending: false`, `answer`, `thinking`)
- History-Selektion: klick auf Item → zeigt gespeicherten Stand

---

## Schritt 8: Frontend — Routing + App + Topbar-Navigation

**Datei:** `frontend/src/App.jsx` (bestehend)

- Neue Route: `<Route path="/chat" element={<ChatPage />} />`
- **Topbar-Navigation (neu):** Die Topbar hat aktuell keine Nav-Links. Neue `TopNav`-Komponente ergänzen:
  - Tabs: „Transkription“ (`/`) | „Chat“ (`/chat`)
  - `NavLink` aus `react-router-dom` mit `active`-Styling
  - Position: links in der Topbar (vor den Toggles)
  - i18n-Labels (`nav.transcription`, `nav.chat`)
- `TranscriptionPage` bleibt auf `/`

**Neue Datei:** `frontend/src/components/TopNav.jsx` (neu)
- `NavLink`-Tabs, `active`-Klasse
- i18n-Labels

**CSS:** `frontend/src/style/components/topbar.css` → `.topnav`, `.topnav__link`, `.topnav__link--active` ergänzen

---

## Schritt 9: Frontend — i18n (chat)

**Dateien:** `frontend/src/locales/{en,de,it}.json` (bestehend)

Neue Sektion `"chat"`:
```json
{
  "chat": {
    "title": "Chat",
    "placeholder": "Ask something…",
    "send": "Send",
    "thinking": "show thinking",
    "hideThinking": "hide thinking",
    "empty": "No messages yet — ask something above.",
    "loading": "Thinking…",
    "error": {
      "network": "Connection to server failed.",
      "server": "Server error, please try again."
    },
    "history": {
      "title": "History",
      "clear": "Clear history",
      "empty": "No conversations yet.",
      "delete": "Delete"
    }
  },
  "nav": {
    "transcription": "Transcription",
    "chat": "Chat"
  }
}
```

---

## Schritt 10: Frontend — CSS (chat)

**Datei:** `frontend/src/style/components/chat.css` (neu)

- `.chat-page`, `.chat`, `.chat__header`
- `.chat-input`, `.chat-input__textarea`
- **Send-Button:** bestehende `.btn .btn--primary` nutzen (nicht neu definieren)
- `.chat-view`, `.chat-view__loading`, `.chat-view__empty`, `.chat-view__error`
- `.chat-history`, `.chat-history__item`, `.chat-history__item--active`
- `.thinking`, `.thinking__label`, `.thinking__body`
- `.markdown` (Code-Blöcke, Tabellen)
- `.spinner` (Loading-Animation, falls nicht vorhanden)
- `.answer__cursor` (Blink-Cursor beim Streaming)

**Import:** `frontend/src/style/components/index.css` → `@import './chat.css';`

Alle Werte aus bestehenden CSS-Variablen (`--color-*`, `--space-*`, `--radius-*`, `--fs-*`).

---

## Schritt 11: `.env` + `compose.yml` + LocalAI-Service

**`.env`:**
```
LLM_HOST=vui-tts          # LocalAI-Container (TTS + LLM gemeinsam)
LLM_PORT=8080
LLM_MODEL=                # Modell-Name (z. B. 'llama3.1')
```

**`compose.yml`:**
- `LLM_MODEL` an `vui-server` durchreichen
- **LocalAI-Service wiederverwenden:** Den (kommentierten) `vui-tts`-Service entkommentieren. LocalAI bedient TTS **und** Chat-Completions. `LLM_HOST` auf `vui-tts` zeigen.
- Alternativ: separater `vui-llm`-Service, wenn TTS und LLM getrennt laufen sollen.

**Wichtig:** `localai/models`-Verzeichnis ist aktuell leer. Ein Chat-fähiges Modell muss geladen werden (z. B. via LocalAI-Gallery oder manuell).

---

## Schritt 12: Tests

**Datei:** `server/test/llm.test.js` (neu)

- `Llm.chat()` — Mock-Server (OpenAI + Ollama)
- `Llm.streamChat()` — SSE + NDJSON Parsing
- `Llm.streamChunks()` — AbortSignal
- **Dynamisches Config-Reading:** Config-Objekt ändern → `chatConfig`-Getter liefert neue Werte

**Datei:** `server/test/router-chat.test.js` (neu)

- `POST /api/chat` — 200 + answer
- `POST /api/chat` — 400 (missing question)
- `POST /api/chat` — 503 (LLM not configured, `LLM_HOST` leer)
- `POST /api/chat/stream` — SSE Events (thinking, answer, done)
- `POST /api/chat/stream` — Client-Abbruch

**Test-Setup:** `server/test/` ist aktuell leer. `vitest` ist in devDependencies. Test-Dateien werden von `vitest run` automatisch erkannt.

---

## Schritt 13: Frontend — Voice-Integration in ChatPage

**Keine Server-Änderung nötig.** Der Chat-Endpoint akzeptiert bereits beliebige Text-Fragen.
Die Voice-Anbindung ist rein frontend-seitig: `useTranscription` (bestehend) liefert Text, `useChatStream` (neu) konsumiert ihn.

### Flow

```
User klickt Mic → useTranscription.startRecording()
  → AudioWorklet → WebSocket /transcribe → Whisper → interim/final Text
User klickt Stop → useTranscription.stopRecording()
  → finalText enthält das vollständige Transkript
  → finalText wird in die ChatInput-Textarea gefüllt (editierbar)
User klickt Send → handleSubmit(finalText) → useChatStream.run()
  → LLM-Antwort streamt in ChatView
```

### `frontend/src/pages/ChatPage.jsx` (Erweiterung aus Schritt 7)

Zusätzlich zu `useChatStream` + `useConversation`:

```js
const {
  status: micStatus,
  isRecording,
  finalText,
  interimText,
  startRecording,
  stopRecording,
  clearTranscript,
} = useTranscription();
```

- `handleVoiceToggle()`:
  - Wenn `!isRecording` → `startRecording()`
  - Wenn `isRecording` → `stopRecording()` → `finalText` in ChatInput setzen → `clearTranscript()`
- `handleSubmit(text)` bleibt identisch für Text- und Voice-Eingabe
- `micStatus` wird als Badge neben dem Mic-Button angezeigt (analog `StatusBadge` in TranscriptionPage)

### `frontend/src/components/VoiceControls.jsx` (neu)

- Mic-Button (Play/Stop-Icon aus `lucide-react`)
- Status-Badge: `ready` / `recording` / `disconnected` / `error`
- **Status-Labels:** bestehende `status.*`-i18n-Keys nutzen (nicht neue `voice.status.*`)
- Interim-Text-Anzeige (während Aufnahme, kursiv, `--color-primary`)
- Props: `isRecording`, `micStatus`, `interimText`, `onToggle`
- i18n-Labels

### `frontend/src/components/ChatInput.jsx` (Erweiterung aus Schritt 6)

- Zusätzlich: `value` + `onChange` Props (controlled mode)
- Damit ChatPage das Transkript in die Textarea setzen kann
- Mic-Button rechts neben dem Send-Button (oder VoiceControls darüber)

---

## Schritt 14: Frontend — i18n (voice)

**Dateien:** `frontend/src/locales/{en,de,it}.json` (Erweiterung aus Schritt 9)

Neue Sektion `"voice"` (**ohne** `status`-Untersektion — bestehende `status.*`-Keys wiederverwenden):
```json
{
  "voice": {
    "start": "Start recording",
    "stop": "Stop recording",
    "listening": "Listening…",
    "interim": "Recognized text",
    "micDenied": "Microphone access was denied."
  }
}
```

**Bestehende `status.*`-Keys (wiederverwenden):**
```json
{
  "status": {
    "disconnected": "Disconnected",
    "ready": "Ready",
    "recording": "Recording...",
    "error": "Error"
  }
}
```

---

## Schritt 15: Frontend — CSS (voice)

**Datei:** `frontend/src/style/components/chat.css` (Erweiterung aus Schritt 10)

- `.voice-controls` — Flex-Container für Mic-Button + Status
- `.voice-controls__mic` — Mic-Button (rund, `--color-primary`, Puls-Animation bei `recording`)
- `.voice-controls__mic--recording` — Rote Farbe + Puls
- `.voice-controls__status` — Status-Badge (wie `.status-badge` in transcription.css)
- `.voice-controls__interim` — Interim-Text (kursiv, `--color-primary`, max 3 Zeilen, `overflow: hidden`)
- `.chat-input__mic` — Mic-Button in der ChatInput (kompakt)

Alle Werte aus bestehenden CSS-Variablen.

---

## Schritt 16: TranscriptionPage — "Send to Chat"

**Datei:** `frontend/src/pages/TranscriptionPage.jsx` (bestehend)

Optional: Button "An Chat senden" unter dem Transkript.

- Klick → `navigate('/chat', { state: { question: finalText } })`
- `ChatPage` liest `location.state.question` beim Mount → füllt ChatInput → optional auto-submit
- `finalText` wird danach geleert

Dies ist ein Convenience-Pfad: User testet Transkription auf `/`, schickt das Ergebnis direkt an den Chat.

---

## Schritt 17: Frontend — Settings-UI für LLM (NEU)

**Datei:** `frontend/src/components/SettingsPanel.jsx` (bestehend)

Neue Sektion „LLM“ ergänzen (analog den bestehenden Whisper-Sektionen):

```js
{
  id: 'llm',
  title: 'settings.sections.llm',
  fields: [
    { key: 'host', type: 'text', label: 'settings.fields.llmHost', placeholder: 'vui-tts' },
    { key: 'port', type: 'number', label: 'settings.fields.llmPort', min: 1, max: 65535, step: 1 },
    { key: 'model', type: 'text', label: 'settings.fields.llmModel', placeholder: 'llama3.1' },
    { key: 'systemPrompt', type: 'textarea', label: 'settings.fields.llmSystemPrompt' },
  ],
}
```

- `draft`-State um `llm`-Objekt erweitern
- `handleSave()` → `patch.llm` mitsenden
- `renderField()` → `textarea`-Typ für `systemPrompt` (analog `badwords`)
- **i18n:** `settings.sections.llm`, `settings.fields.llmHost`, `settings.fields.llmPort`, `settings.fields.llmModel`, `settings.fields.llmSystemPrompt` in `{en,de,it}.json`
- **CSS:** `.settings__textarea` bereits vorhanden (für `systemPrompt`)

---

## Dateibaum (Ergebnis)

```
server/
  src/
    Llm.js              ← NEU
    Config.js           ← ERWEITERT (LLM_PARAMS + this.llm)
    Router/
      index.js          ← ERWEITERT (Chat-Routen + Llm-Instanz)
  test/
    llm.test.js         ← NEU
    router-chat.test.js ← NEU

frontend/
  src/
    api/
      chat.js           ← NEU
    hooks/
      useChatStream.js  ← NEU
      useConversation.js← NEU
      useTranscription.js ← BESTEHEND (wird in ChatPage genutzt)
    components/
      TopNav.jsx        ← NEU (Topbar-Navigation)
      ChatInput.jsx     ← NEU (Text + Mic-Button)
      ChatView.jsx      ← NEU
      ThinkBlock.jsx    ← NEU
      Markdown.jsx      ← NEU
      ChatHistory.jsx   ← NEU
      VoiceControls.jsx ← NEU (Mic + Status + Interim)
      SettingsPanel.jsx ← ERWEITERT (LLM-Sektion)
    pages/
      ChatPage.jsx      ← NEU (Chat + Voice-Integration)
      TranscriptionPage.jsx ← ERWEITERT ("Send to Chat" Button)
    App.jsx             ← ERWEITERT (Route + TopNav)
    locales/
      en.json           ← ERWEITERT (chat + voice + nav + settings.llm)
      de.json           ← ERWEITERT (chat + voice + nav + settings.llm)
      it.json           ← ERWEITERT (chat + voice + nav + settings.llm)
    style/
      components/
        chat.css        ← NEU (Chat + Voice Styles)
        topbar.css      ← ERWEITERT (TopNav-Styles)
        index.css       ← ERWEITERT (Import)

.env                    ← ERWEITERT (LLM_MODEL)
compose.yml             ← ERWEITERT (LLM_MODEL + LocalAI-Service)
```

---

## Reihenfolge (Umsetzung)

| # | Schritt | Abhängigkeit |
|---|---------|-------------|
| 1 | Config-Erweiterung (LLM_PARAMS + this.llm) | — |
| 2 | Llm.js (dynamisches Config-Reading) | 1 |
| 3 | Chat-Routen (+ 503-Handling) | 2 |
| 4 | Server-Tests | 3 |
| 5 | API-Client | 3 |
| 6 | Hooks (useChatStream + useConversation) | 5 |
| 7 | Komponenten (ChatInput, ChatView, ThinkBlock, Markdown, ChatHistory) | 6 |
| 8 | ChatPage | 7 |
| 9 | Routing + App + TopNav | 8 |
| 10 | i18n (chat + nav) | 7 |
| 11 | CSS (chat) | 7 |
| 12 | .env + compose.yml + LocalAI-Service | 1 |
| 13 | Voice-Integration in ChatPage (useTranscription + VoiceControls) | 8, 6 |
| 14 | i18n (voice) | 13 |
| 15 | CSS (voice) | 13 |
| 16 | TranscriptionPage "Send to Chat" | 8 |
| 17 | Settings-UI für LLM (SettingsPanel + i18n + CSS) | 1, 10 |
