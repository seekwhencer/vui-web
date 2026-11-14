# PLAN: LLM Images — Serverseitige Persistierung (Variante B)

## Ziel

- Bilder aus MCP-Tool-Ergebnissen (Screenshots) bleiben **nach Reload sichtbar**.
- Der Server persistiert die Bild-Bytes auf Disk unter einem **konfigurierbaren Media-Pfad**.
- Ein **Cleanup-Mechanismus** (TTL + Caps) verhindert unkontrolliertes Wachstum.
- Media-Pfad, TTL und Caps sind in **Settings > App** (UI) und per **Env** setzbar.
- **Bilder sind priorisiert**; die Struktur ist für andere Mediatypen (Audio, Video, PDF) erweiterbar.
- Ergebnis: Konzeptdokument, keine Codeänderung.

## Ausgangslage

| Aspekt | Status |
|---|---|
| Bild-Quelle | MCP-Tool-Ergebnisse (`ImageContent`) → `McpManager.callTool()` extrahiert `{ mimeType, data }` (Base64) |
| SSE-Format | `tool_result` → `images: [{ mimeType, data }]` (Base64 inline, `Router/index.js:312-313`) |
| LLM-Pfad | `buildToolMessage()` nutzt `images` (Base64) für Vision-LLM (`Router/index.js:856-872`) |
| Frontend | `ChatImage.jsx` rendert `data:`-URL; `useConversation.js:60-68` → `stripImages()` entfernt Bilder vor localStorage-Write |
| Persistenz | **Keine** — Bilder sind session-only, verschwinden nach Reload |
| Settings | `AppSettings.jsx` ist Platzhalter; kein `media`-Block in `Config.js` |
| Data-Dir | `server/data/` (git-ignored) — bereits für `actions.json` / `audit.jsonl` |
| Env | `MEDIA_*` Variablen existieren noch nicht |

## Architektur-Entscheidung

**Variante B: Server persistiert Bild-Bytes auf Disk.**

- Neue Klasse `MediaStore` (`server/src/MediaStore.js`) — `save()`, `get()`, `delete()`, `cleanup()`, `list()`.
- Config-Block `media` in `Config.js` (`MEDIA_PARAMS`) — `dir`, `imageTtlDays`, `maxImages`, `maxBytes`, `cleanupIntervalMs`.
- Cleanup: **mtime-basiert** (einfacher als Sidecar-Index) — TTL + maxImages + maxBytes.
- API: `GET /api/media/:id` (Path-Traversal-Guard, UUID-Regex).
- Frontend: `ChatImage.jsx` + `ImageLightbox.jsx` akzeptieren `url` ODER `data`; `useConversation.js` entfernt `stripImages()`.
- Settings-UI: `AppSettings.jsx` ausbauen (Media-Pfad, TTL, Caps).
- i18n: `settings.app.*` + `settings.fields.media*` (en, de, it).
- Fallback: `mediaStore.save()` schlägt fehl → inline `{ mimeType, data }` (Legacy).

**Verzeichnisstruktur:**

```
server/data/media/          ← media.dir (Default, git-ignored)
└── images/                 ← Subdir pro Mediatyp (erweiterbar: audio/, video/, docs/)
    ├── <uuid>.png
    ├── <uuid>.jpg
    └── <uuid>.webp
```

**SSE-Format (neu):**

```json
{ "id": "<uuid>", "mimeType": "image/png", "url": "/api/media/<uuid>", "size": 12345 }
```

**SSE-Format (Fallback, wenn save() fehlschlägt):**

```json
{ "mimeType": "image/png", "data": "<base64>" }
```

---

## Schritt 1: Server — Config (media-Block)

**Datei:** `server/src/Config.js`

Neuer `MEDIA_PARAMS`-Block (analog `SECURITY_PARAMS`):

```js
const MEDIA_PARAMS = {
    dir:               { env: 'MEDIA_DIR',                type: 'string',  default: '' },
    imageTtlDays:      { env: 'MEDIA_IMAGE_TTL_DAYS',     type: 'integer', default: 30, min: 0 },
    maxImages:         { env: 'MEDIA_MAX_IMAGES',         type: 'integer', default: 500, min: 0 },
    maxBytes:          { env: 'MEDIA_MAX_BYTES',          type: 'integer', default: 524288000, min: 0 },
    cleanupIntervalMs: { env: 'MEDIA_CLEANUP_INTERVAL_MS',type: 'integer', default: 3600000, min: 60000 },
};
```

- `dir`: leer → Default `server/data/media`; gesetzt → absoluter Pfad.
- `imageTtlDays`: 0 = keine TTL (Bilder bleiben ewig).
- `maxImages`: 0 = unbegrenzt.
- `maxBytes`: 0 = unbegrenzt (Default 500 MB).
- `cleanupIntervalMs`: min 60000 (1 Minute).

**Änderungen in `Config.js`:**

1. `MEDIA_PARAMS` definieren (nach `SECURITY_PARAMS`).
2. `resolveMediaParams(loaded)` — env > config.json > Default (analog `resolveSecurityParams`).
3. Constructor: `this.media = this.resolveMediaParams(loaded);`
4. `getSettings()`: `media: { ...this.media }` hinzufügen.
5. `validateSettings()`: `errors.push(...this.validateMediaParams(s.media || {}));`
6. `validateMediaParam(key, spec, value)` — analog `validateSecurityParam` (string, integer mit min).
7. `updateSettings(patch)`: `media: { ...current.media, ...(patch.media || {}) }` im Deep-Merge; `this.media = { ...next.media };` im Runtime-State.
8. `persist()`: `media: this.media` hinzufügen.
9. `saveDefaults()`: `media: Object.fromEntries(Object.entries(MEDIA_PARAMS).map(([k, s]) => [k, s.default]))` hinzufügen.
10. `runtimeKeys`: `'media'` hinzufügen.
11. Export: `MEDIA_PARAMS` hinzufügen.

---

## Schritt 2: Server — MediaStore (neue Klasse)

**Datei:** `server/src/MediaStore.js` (neu)

```js
import { randomUUID } from 'node:crypto';
import {
    mkdirSync, readdirSync, statSync, unlinkSync,
    writeFileSync, renameSync, existsSync,
} from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIME_EXT = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
};

const EXT_MIME = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.bin': 'application/octet-stream',
};

const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export class MediaStore {
    constructor({ config, logger }) {
        this.config = config;
        this.logger = logger || { log: () => {}, error: () => {} };
        this.label = '[MediaStore]';
        this.baseDir = this.resolveDir();
        this.imagesDir = join(this.baseDir, 'images');
        mkdirSync(this.imagesDir, { recursive: true });
    }

    /** media.dir (env/config) > Default (server/data/media). */
    resolveDir() {
        const configured = this.config?.media?.dir;
        if (configured && typeof configured === 'string' && configured.trim() !== '') {
            return resolve(configured);
        }
        return join(__dirname, '..', 'data', 'media');
    }

    /**
     * Speichert ein Bild (Base64) auf Disk.
     * @returns {{ id: string, mimeType: string, url: string, size: number }}
     */
    save(mimeType, base64Data) {
        const ext = MIME_EXT[mimeType] || '.bin';
        const id = randomUUID();
        const filePath = join(this.imagesDir, `${id}${ext}`);
        const buffer = Buffer.from(base64Data, 'base64');
        // Atomares Write: Temp-Datei → Rename (verhindert korrupte Dateien bei Crash).
        const tmpPath = `${filePath}.tmp`;
        writeFileSync(tmpPath, buffer);
        renameSync(tmpPath, filePath);
        return { id, mimeType, url: `/api/media/${id}`, size: buffer.length };
    }

    /**
     * Lädt Metadaten für ein Bild (Path-Traversal-Guard).
     * @returns {{ filePath: string, mimeType: string, size: number } | null}
     */
    get(id) {
        if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
        let files;
        try { files = readdirSync(this.imagesDir); } catch { return null; }
        const match = files.find((f) => f.startsWith(id));
        if (!match) return null;
        const filePath = join(this.imagesDir, match);
        // Zweite Guard: aufgelöster Pfad muss innerhalb imagesDir liegen.
        if (!resolve(filePath).startsWith(resolve(this.imagesDir) + '/')) return null;
        const stat = statSync(filePath);
        const mimeType = EXT_MIME[extname(match)] || 'application/octet-stream';
        return { filePath, mimeType, size: stat.size };
    }

    /** Löscht ein Bild. @returns {boolean} true wenn gelöscht. */
    delete(id) {
        const meta = this.get(id);
        if (!meta) return false;
        unlinkSync(meta.filePath);
        return true;
    }

    /**
     * Cleanup: TTL + maxImages + maxBytes (mtime-basiert, älteste zuerst).
     * @returns {{ deleted: number, freedBytes: number }}
     */
    cleanup() {
        const { imageTtlDays = 0, maxImages = 0, maxBytes = 0 } = this.config?.media || {};
        const now = Date.now();
        const ttlMs = imageTtlDays > 0 ? imageTtlDays * 86400000 : Infinity;
        let deleted = 0;
        let freedBytes = 0;

        const listFiles = () => {
            let names;
            try { names = readdirSync(this.imagesDir); } catch { return []; }
            return names
                .filter((f) => !f.endsWith('.tmp'))
                .map((f) => {
                    const filePath = join(this.imagesDir, f);
                    const stat = statSync(filePath);
                    return { filePath, mtime: stat.mtimeMs, size: stat.size };
                })
                .sort((a, b) => a.mtime - b.mtime); // älteste zuerst
        };

        const remove = (file) => {
            try {
                unlinkSync(file.filePath);
                deleted++;
                freedBytes += file.size;
            } catch (err) {
                this.logger.error(this.label, 'Cleanup: Datei konnte nicht gelöscht werden', { file: file.filePath, error: err.message });
            }
        };

        // 1. TTL
        for (const file of listFiles()) {
            if (now - file.mtime > ttlMs) remove(file);
        }

        // 2. maxImages (Cap auf Anzahl)
        if (maxImages > 0) {
            const remaining = listFiles();
            if (remaining.length > maxImages) {
                for (const file of remaining.slice(0, remaining.length - maxImages)) remove(file);
            }
        }

        // 3. maxBytes (Cap auf Gesamtgröße)
        if (maxBytes > 0) {
            let total = 0;
            const current = listFiles();
            for (const file of current) total += file.size;
            if (total > maxBytes) {
                let excess = total - maxBytes;
                for (const file of current) {
                    if (excess <= 0) break;
                    remove(file);
                    excess -= file.size;
                }
            }
        }

        if (deleted > 0) {
            this.logger.log(this.label, `Cleanup: ${deleted} Dateien gelöscht, ${freedBytes} Bytes freigegeben`);
        }
        return { deleted, freedBytes };
    }

    /** Listet alle Bilder (für Admin-UI / Stats). */
    list() {
        let names;
        try { names = readdirSync(this.imagesDir); } catch { return []; }
        return names
            .filter((f) => !f.endsWith('.tmp'))
            .map((f) => {
                const filePath = join(this.imagesDir, f);
                const stat = statSync(filePath);
                return {
                    id: f.replace(extname(f), ''),
                    mimeType: EXT_MIME[extname(f)] || 'application/octet-stream',
                    size: stat.size,
                    mtime: stat.mtimeMs,
                };
            })
            .sort((a, b) => b.mtime - a.mtime); // neueste zuerst
    }
}
```

**Design-Notizen:**

- **Atomares Write**: Temp-Datei → `renameSync` (verhindert korrupte Dateien bei Crash).
- **Path-Traversal-Guard**: UUID-Regex + `resolve()`-Check (doppelte Absicherung).
- **mtime-basiert**: mtime = Schreibzeit = Erstellungszeit (für unsere Zwecke). Kein Sidecar-Index nötig.
- **Cleanup-Reihenfolge**: TTL → maxImages → maxBytes (älteste zuerst).
- **`.tmp`-Filter**: Verwaiste Temp-Dateien werden nicht gelistet, aber beim nächsten Cleanup gelöscht (wenn sie älter als TTL sind).

---

## Schritt 3: Server — Router (Hook + Media-Route)

**Datei:** `server/src/Router/index.js`

### 3a. Constructor: `mediaStore` annehmen

```js
constructor(config, httpServer, logger, security, mcp, stats, mediaStore) {
    // ... bestehende Zuweisungen ...
    this.mediaStore = mediaStore;
}
```

### 3b. Streaming-Hook (`Router/index.js:312-313`)

**Vorher:**

```js
send('tool_result', { id: call.id, content, isError, images });
```

**Nachher:**

```js
// Bilder serverseitig persistieren → Client bekommt URL statt Base64.
// Fallback: save() schlägt fehl → inline Data (Legacy).
const clientImages = (images || []).map((img) => {
    try {
        return this.mediaStore.save(img.mimeType, img.data);
    } catch (err) {
        this.logger.warn('[Router] MediaStore.save fehlgeschlagen, Fallback auf Inline-Data', { error: err.message });
        return { mimeType: img.mimeType, data: img.data };
    }
});
send('tool_result', { id: call.id, content, isError, images: clientImages });
```

**Wichtig:** Der LLM-Pfad (Pfad B, `Router/index.js:856-872`) nutzt weiterhin `images` mit `data` (Base64) für `buildToolMessage()` — **unverändert**. Nur der SSE-Output an den Client ändert sich.

### 3c. Neue Route: `GET /api/media/:id`

```js
// In define() oder registerRoutes():
this.router.get('/api/media/:id', (req, res) => {
    const meta = this.mediaStore.get(req.params.id);
    if (!meta) {
        return res.status(404).json({ success: false, error: 'Media not found', code: 'media_not_found' });
    }
    res.setHeader('Content-Type', meta.mimeType);
    res.setHeader('Content-Length', meta.size);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    createReadStream(meta.filePath).pipe(res);
});
```

- `Cache-Control: immutable` — die Datei ändert sich nie (UUID-Name).
- `createReadStream` — streamt die Datei, kein Buffer im RAM.

---

## Schritt 4: Server — Server.js (Wiring + Cleanup-Interval)

**Datei:** `server/src/Server.js`

### 4a. Import

```js
import { MediaStore } from './MediaStore.js';
```

### 4b. `start()`: MediaStore instanziieren + Cleanup

**Nach** der `dataDir`-Erstellung (Zeile 60), **vor** dem Router (Zeile 78):

```js
// MediaStore: persistiert MCP-Tool-Bilder auf Disk (Variante B).
const mediaStore = new MediaStore({ config: this.config, logger: this.logger });
mediaStore.cleanup(); // einmalig beim Start (verwaiste Dateien aufräumen)
const cleanupTimer = setInterval(() => mediaStore.cleanup(), this.config.media.cleanupIntervalMs);
cleanupTimer.unref?.(); // nicht den Prozess am Beenden hindern
```

### 4c. Router: `mediaStore` übergeben

```js
this.router = new Router(this.config, this.httpServer, this.logger, security, mcp, stats, mediaStore);
```

### 4d. Shutdown: Interval stoppen

In der `shutdown`-Funktion (vor `httpServer.close()`):

```js
clearInterval(cleanupTimer);
```

---

## Schritt 5: Frontend — Rendering (ChatImage, Lightbox, useConversation)

### 5a. `ChatImage.jsx` — `url` ODER `data`

**Datei:** `frontend/src/components/ChatImage.jsx`

```jsx
export default function ChatImage({ mimeType, data, url, alt, onOpen, failed }) {
  const { t } = useTranslation();
  const [isFailed, setFailed] = useState(Boolean(failed));

  if (isFailed) {
    return <div className="msg__image msg__image--error">{t('chat.image.error')}</div>;
  }

  const src = url || (data ? buildDataUrl(mimeType, data) : null);
  if (!src) {
    return <div className="msg__image msg__image--error">{t('chat.image.error')}</div>;
  }

  return (
    <img
      className="msg__image"
      src={src}
      alt={alt || t('chat.image.alt')}
      loading="lazy"
      onError={() => setFailed(true)}
      onClick={() => onOpen && onOpen({ mimeType, data, url })}
    />
  );
}
```

### 5b. `ImageLightbox.jsx` — `url` ODER `data`

**Datei:** `frontend/src/components/ImageLightbox.jsx`

```jsx
// src-Berechnung:
const src = image.url || (image.data ? buildDataUrl(image.mimeType, image.data) : null);
if (!src) return null;

// <img src={src} ... />
```

### 5c. `useConversation.js` — `stripImages()` entfernen

**Datei:** `frontend/src/hooks/useConversation.js`

- `stripImages()` (Zeilen 60-68) **entfernen**.
- `persist()` (Zeile 72): `localStorage.setItem(STORAGE_KEY, JSON.stringify(state));` (ohne `stripImages`).
- Kommentar (Zeilen 57-59) aktualisieren: Bilder werden jetzt serverseitig persistiert; `url` ist klein, kein Quota-Problem.

**Begründung:** Das neue Format (`{ id, mimeType, url, size }`) ist klein (~100 Bytes pro Bild). localStorage-Quota ist kein Problem mehr. Fallback-Format (`{ mimeType, data }`) ist selten und wird vom `try/catch` in `persist()` abgefangen.

### 5d. `ChatView.jsx` — unverändert

`ChatView.jsx:102` rendert `itemImages` — die Props (`mimeType`, `data`, `url`) werden durchgereicht. `ChatImage.jsx` und `ImageLightbox.jsx` akzeptieren beide Formate.

### 5e. `ChatPage.jsx` — unverändert

`ChatPage.jsx:72-83` finalisiert den Turn mit `images` — das Format kommt vom Server (neu oder Fallback).

### 5f. `useChatStream.js` — unverändert

Sammelt `images` aus `tool_result` — das Format kommt vom Server.

---

## Schritt 6: Frontend — Settings-UI (AppSettings) + i18n

### 6a. `AppSettings.jsx` — Media-Panel

**Datei:** `frontend/src/components/settings/AppSettings.jsx`

Aktuell nur Platzhalter (`settings.app.placeholder`). Ausbauen mit:

- **Media-Pfad** (`media.dir`) — Textfeld, leer = Default.
- **Bild-TTL** (`media.imageTtlDays`) — Zahlenfeld, 0 = ewig.
- **Max. Bilder** (`media.maxImages`) — Zahlenfeld, 0 = unbegrenzt.
- **Max. Speicher** (`media.maxBytes`) — Zahlenfeld (Bytes), 0 = unbegrenzt.
- **Cleanup-Intervall** (`media.cleanupIntervalMs`) — Zahlenfeld (ms), min 60000.

**Save-Pattern:** "Immediate save" (analog `McpSettings.jsx`) — optimistic update + `updateSettings({ media: { ... } })` on change.

**Hinweis:** `media.dir` ist ein **restartKey** (Pfadänderung erfordert Neustart, weil `MediaStore` den Pfad beim Constructor auflöst). Die anderen `media.*` sind **runtimeKeys** (Cleanup liest die Config dynamisch).

### 6b. i18n — `settings.app.*` + `settings.fields.media*`

**Dateien:** `frontend/src/locales/en.json`, `de.json`, `it.json`

```json
{
  "settings": {
    "app": {
      "title": "App",
      "media": {
        "title": "Media",
        "dir": "Media-Pfad",
        "dirHint": "Leer = Default (server/data/media). Änderungen erfordern Neustart.",
        "imageTtlDays": "Bild-TTL (Tage)",
        "imageTtlDaysHint": "0 = Bilder bleiben ewig.",
        "maxImages": "Max. Bilder",
        "maxImagesHint": "0 = unbegrenzt.",
        "maxBytes": "Max. Speicher (Bytes)",
        "maxBytesHint": "0 = unbegrenzt. Default: 524288000 (500 MB).",
        "cleanupIntervalMs": "Cleanup-Intervall (ms)",
        "cleanupIntervalMsHint": "Min. 60000 (1 Minute)."
      }
    }
  }
}
```

### 6c. `SettingsPage.jsx` — unverändert

Die Kategorie `app` existiert bereits. `AppSettings.jsx` wird automatisch gerendert.

### 6d. `useSettings.js` — unverändert

Lädt/speichert Server-Settings. Der `media`-Block wird automatisch mitgeliefert.

---

## Schritt 7: Tests

### 7a. Server — `MediaStore` (Unit-Tests)

**Datei:** `server/test/MediaStore.test.js` (neu)

- `save()` → Datei existiert, `{ id, mimeType, url, size }` korrekt.
- `get()` → Metadaten korrekt, Path-Traversal-Guard (ungültige ID → null).
- `delete()` → Datei gelöscht.
- `cleanup()` → TTL, maxImages, maxBytes (älteste zuerst).
- `list()` → korrekte Liste.

### 7b. Server — Config (Unit-Tests)

**Datei:** `server/test/Config.test.js` (erweitern)

- `MEDIA_PARAMS` in `getSettings()` vorhanden.
- `validateSettings()` → `media`-Validierung.
- `updateSettings()` → `media`-Patch.
- `persist()` → `media` in config.json.

### 7c. Server — Router (Integration-Tests)

**Datei:** `server/test/Router.test.js` (erweitern)

- `GET /api/media/:id` → 200 + Bild-Bytes, 404 bei ungültiger ID.
- Streaming: `tool_result` → `images` mit `url` (nicht `data`).

### 7d. Frontend — `ChatImage` (Unit-Tests)

**Datei:** `frontend/src/components/__tests__/ChatImage.test.jsx` (erweitern)

- `url` → `<img src={url}>`.
- `data` → `<img src="data:...">`.
- `url` + `data` → `url` gewinnt.
- Fallback (kein `url`, kein `data`) → Fehler-Box.

### 7e. Frontend — `useConversation` (Unit-Tests)

**Datei:** `frontend/src/hooks/__tests__/useConversation.test.js` (erweitern)

- `persist()` → `images` werden persistiert (nicht gestrippt).

---

## Dateibaum (Ergebnis)

```
server/
├── src/
│   ├── Config.js              ← MEDIA_PARAMS, resolveMediaParams, validateMediaParams, media in getSettings/updateSettings/persist/saveDefaults/runtimeKeys
│   ├── MediaStore.js          ← NEU: save, get, delete, cleanup, list
│   ├── Server.js              ← MediaStore-Instanzierung, Cleanup-Interval, Router-Wiring, Shutdown
│   └── Router/index.js        ← mediaStore-Prop, Streaming-Hook, GET /api/media/:id
├── data/
│   └── media/                 ← NEU (git-ignored): images/<uuid>.<ext>
└── test/
    ├── MediaStore.test.js     ← NEU
    ├── Config.test.js         ← erweitert (media)
    └── Router.test.js         ← erweitert (media route)

frontend/
├── src/
│   ├── components/
│   │   ├── ChatImage.jsx      ← url ODER data
│   │   ├── ImageLightbox.jsx  ← url ODER data
│   │   └── settings/
│   │       └── AppSettings.jsx ← Media-Panel (dir, TTL, Caps)
│   ├── hooks/
│   │   └── useConversation.js ← stripImages() entfernen
│   └── locales/
│       ├── en.json            ← settings.app.media.*
│       ├── de.json            ← settings.app.media.*
│       └── it.json            ← settings.app.media.*
└── src/components/__tests__/
    └── ChatImage.test.jsx     ← erweitert (url)
```

---

## Sicherheits-Notizen

1. **Path-Traversal-Guard**: `GET /api/media/:id` — UUID-Regex + `resolve()`-Check (doppelte Absicherung).
2. **Git**: `server/data/` ist bereits in `.gitignore` — Media-Ordner unter `server/data/media/` → automatisch git-ignored.
3. **Keine Secrets**: Media-Dateien sind öffentliche Bilddaten, keine Secrets.
4. **Cache**: `Cache-Control: immutable` — UUID-Namen ändern sich nie, sichere Caching-Strategie.
5. **Quota**: Neues Format (`url`) ist klein (~100 Bytes/Bild) — localStorage-Quota kein Problem.
6. **Fallback**: `mediaStore.save()` schlägt fehl → inline Data (Legacy) — Bild bleibt sichtbar, aber nicht persistent.

---

## Offene Fragen

1. **Media-Pfad-Änderung**: Wenn der User den Media-Pfad ändert, sind die alten Dateien im alten Ordner verwaist. Option: `MediaStore.migrate()` (alte Dateien in neuen Ordner kopieren). **Entscheidung: Nicht implementieren** — User kann alten Ordner manuell löschen.
2. **Globale Caps**: `maxImages` / `maxBytes` gelten für ALLE Bilder (nicht pro Konversation). Älteste Bilder werden gelöscht, auch wenn sie in aktiven Konversationen referenziert werden. Frontend zeigt 404-Placeholder. **Entscheidung: Akzeptabel** — User will explizit ein Cleanup.
3. **mtime vs. createdAt**: mtime = Schreibzeit. Bei Backup/Restore bleibt mtime erhalten. Bei Systemuhr-Änderung könnte die TTL-Vergleich ungenau sein. **Entscheidung: Akzeptabel** — Edge-Case.
4. **Andere Mediatypen**: Struktur ist erweiterbar (`audio/`, `video/`, `docs/`). **Entscheidung: Nicht implementieren** — Bilder sind priorisiert, andere Typen später.

---

## Agent-Workflow (sequenzielle Sub-Agenten)

> **WICHTIG:** Phasen laufen **nacheinander**, nicht parallel. Jede Phase hat eine klare Abhängigkeit zur vorherigen.

### Phase 1: Config + MediaStore

**Scope:**
- `server/src/Config.js`: `MEDIA_PARAMS`, `resolveMediaParams`, `validateMediaParams`, `media` in `getSettings`/`updateSettings`/`persist`/`saveDefaults`/`runtimeKeys`.
- `server/src/MediaStore.js`: neue Klasse (`save`, `get`, `delete`, `cleanup`, `list`).
- `server/test/MediaStore.test.js`: Unit-Tests.
- `server/test/Config.test.js`: erweitern (media).

**Voraussetzung:** Keine.

**Ergebnis:** Config-Block `media` existiert; `MediaStore` ist testbar.

**Definition of Done:**
- [ ] `npm test` (server) grün.
- [ ] `getSettings()` liefert `media`-Block.
- [ ] `MediaStore.save()` → Datei auf Disk, `{ id, mimeType, url, size }`.
- [ ] `MediaStore.cleanup()` → TTL + Caps funktionieren.
- [ ] Path-Traversal-Guard getestet.

---

### Phase 2: Router + Server-Wiring

**Scope:**
- `server/src/Router/index.js`: `mediaStore`-Prop, Streaming-Hook (`clientImages`), `GET /api/media/:id`.
- `server/src/Server.js`: `MediaStore`-Instanzierung, Cleanup-Interval, Router-Wiring, Shutdown.
- `server/test/Router.test.js`: erweitern (media route, streaming).

**Voraussetzung:** Phase 1 (Config + MediaStore).

**Ergebnis:** Server persistiert Bilder, liefert `url` im SSE, `GET /api/media/:id` funktioniert.

**Definition of Done:**
- [ ] `npm test` (server) grün.
- [ ] Streaming: `tool_result` → `images` mit `url` (nicht `data`).
- [ ] `GET /api/media/:id` → 200 + Bild-Bytes.
- [ ] `GET /api/media/:id` (ungültig) → 404.
- [ ] Cleanup-Interval läuft (log output).
- [ ] Fallback: `save()` fehlschlägt → inline Data.

---

### Phase 3: Frontend-Rendering

**Scope:**
- `frontend/src/components/ChatImage.jsx`: `url` ODER `data`.
- `frontend/src/components/ImageLightbox.jsx`: `url` ODER `data`.
- `frontend/src/hooks/useConversation.js`: `stripImages()` entfernen.
- `frontend/src/components/__tests__/ChatImage.test.jsx`: erweitern (url).
- `frontend/src/hooks/__tests__/useConversation.test.js`: erweitern (persist images).

**Voraussetzung:** Phase 2 (Server liefert `url`).

**Ergebnis:** Frontend rendert Bilder aus `url` ODER `data`; Bilder bleiben nach Reload sichtbar.

**Definition of Done:**
- [ ] `npm test` (frontend) grün.
- [ ] `ChatImage` rendert `url` und `data`.
- [ ] `ImageLightbox` rendert `url` und `data`.
- [ ] `useConversation` persistiert `images` (nicht gestrippt).
- [ ] E2E: Bild nach Reload sichtbar.

---

### Phase 4: Settings-UI + i18n

**Scope:**
- `frontend/src/components/settings/AppSettings.jsx`: Media-Panel (dir, TTL, Caps).
- `frontend/src/locales/en.json`: `settings.app.media.*`.
- `frontend/src/locales/de.json`: `settings.app.media.*`.
- `frontend/src/locales/it.json`: `settings.app.media.*`.

**Voraussetzung:** Phase 1 (Config-Block `media`).

**Ergebnis:** User kann Media-Pfad, TTL, Caps in Settings > App konfigurieren.

**Definition of Done:**
- [ ] `npm test` (frontend) grün.
- [ ] Settings > App zeigt Media-Panel.
- [ ] Media-Pfad, TTL, Caps sind editierbar.
- [ ] i18n: en, de, it.
- [ ] Save → `PUT /api/settings` mit `media`-Patch.

---

### Phase 5: Doku + Polish

**Scope:**
- `.env.example`: `MEDIA_*` Variablen ergänzen.
- `README.md` (oder `.docs/`): Media-Persistierung dokumentieren.
- Code-Review: Konsistenz, Fehlerbehandlung, Logging.
- E2E-Test: Kompletter Flow (Bild → Persist → Reload → Sichtbar).

**Voraussetzung:** Phase 1-4.

**Ergebnis:** Feature ist vollständig, dokumentiert, getestet.

**Definition of Done:**
- [ ] `.env.example` hat `MEDIA_*` Variablen.
- [ ] Doku: Media-Persistierung erklärt.
- [ ] E2E-Test: Kompletter Flow grün.
- [ ] Code-Review: Keine offenen Issues.
