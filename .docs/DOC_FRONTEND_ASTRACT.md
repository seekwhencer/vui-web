# DOC_FRONTEND_ABSTRACT.md — Abstrakte Frontend-Dokumentation

> Generische React-SPA. Wird von einem Node-Server ausgeliefert und spricht
> mit einer Upstream-API (via Bridge) sowie lokalen Server-Endpunkten.
> Abstrahierte Version ohne Bezug zu einem konkreten Backend.

Stand: 2026-11-01 · Quelle: `frontend/` (React 19, Vite 8, JavaScript — kein TypeScript)

---

## 1. Überblick

| Aspekt | Wert |
|---|---|
| Framework | React 19 (`react`, `react-dom`) |
| Build-Tool | Vite 8 (`@vitejs/plugin-react`) |
| Sprache | JavaScript (ESM, JSX) — **kein TypeScript** |
| Routing | `react-router-dom` v7 (`BrowserRouter`) |
| Server-State | `@tanstack/react-query` v5 (Queries + Mutations) |
| HTTP | `axios` (eigener Client mit Interceptors) |
| Player | Player-Bibliothek (MSE) + nativer Fallback |
| i18n | `i18next` + `react-i18next` (EN/DE/IT) |
| Icons | `lucide-react` |
| Markdown | `react-markdown` + `remark-gfm` |
| Styling | Handgeschriebenes CSS (CSS-Variablen, BEM-artig) — **kein CSS-Framework** |
| State-Mgmt | `useState` + `useSyncExternalStore` + react-query — **keine schwere State-Lib** |

---

## 2. Architektur & Serving

Das Frontend ist **kein eigenständiger Webserver**. Es läuft als Vite in
`middlewareMode` und wird vom Node-Server eingebettet.

```
Browser
  │  HTTP  ────────────────────────────────►  Node-Server (Express)
  │                                              │
  │   /upstream/*  (Upstream-API)                ├─► Bridge  ──► Upstream-Service
  │   /api/* (lokale Endpunkte)                  ├─► Lokale Router
  │   /logs   (WebSocket)                        ├─► Log-WebSocket
  │   /*    (SPA)                                └─► FrontendRouter
  │                                                 ├─ Dev:  Vite-Dev-Server (HMR) + SPA-Fallback
  │                                                 └─ Prod: static dist/ + SPA-Fallback (index.html)
  └────────────────────────────────────────────────────────────────────
```

- **`vite.config.js`** — `appType: 'custom'`, `server.middlewareMode: true`,
  CSP-Header im Dev-Middleware, HMR-WS an `VITE_WS_HOST`/`VITE_WS_PORT`.
- **FrontendRouter** — Dev: Vite-Server als Middleware + SPA-Fallback
  (Deep-Links → `index.html`, Asset-Pfade → Vite). Prod:
  `express.static(frontend/dist)` + Catch-all → `index.html`.
- **Router-Index** — Routen-Reihenfolge: Health → lokale API → Upstream-Bridge →
  **Frontend (Catch-all, MUSS zuletzt)**.
  WebSocket-Upgrade: `/logs` → Log-WS, sonst → Vite-HMR.

### Zwei API-Kanäle (`src/api/client.js`)

| Export | Base-URL | Zweck |
|---|---|---|
| `api` | App-Settings-Override → Env → Default | Upstream-API **via Bridge** |
| `localApi` | `''` (relativ) | Server-eigene Endpunkte |

- Axios-Client: `timeout: 10000`, `Content-Type: application/json`.
- **Response-Interceptor**: liefert `res.data` direkt; Fehler → `Error` mit
  `.code` und `.status` (HTTP).
- Base-URL wird **pro Request** aufgelöst (Override aus App-Settings gewinnt).

---

## 3. Verzeichnisstruktur

```
frontend/
├── index.html                 # SPA-Root (<div id="root">), data-theme="auto"
├── vite.config.js             # Vite (middlewareMode, CSP, HMR-WS)
├── package.json               # Deps + Scripts (dev/build/preview)
├── dist/                      # Build-Ausgabe (Prod)
├── tests/                     # SSR-Smoke-Tests
└── src/
    ├── main.jsx               # Bootstrap: QueryClient + Router + i18n + Styles
    ├── App.jsx                # Theme/Hue/Radius-Effects + <Routes>
    ├── i18n.js                # i18next-Init (EN/DE/IT) + Persistenz
    ├── api/
    │   └── client.js          # axios-Client: api (Upstream) + localApi (Server)
    ├── services/
    │   ├── appSettings.js     # Lokale App-Settings (localStorage) + useAppSettings
    │   └── queryKeys.js       # Zentrale react-query Query-Keys
    ├── hooks/                 # Hooks (s. §6)
    ├── utils/                 # Reine Hilfsfunktionen (s. §14)
    ├── locales/               # en.json / de.json / it.json
    ├── images/                # Logo
    ├── style/                 # CSS (s. §13)
    └── components/
        ├── layout/            # Layout, Sidebar, TopBar, navItems
        ├── dashboard/         # Dashboard-Karten
        ├── forms/             # FormBuilder, FormField, ListEditor, fieldCatalog, *Form
        ├── tables/            # DataTable, Pagination
        ├── player/            # Player-Komponenten (Fullscreen-View)
        ├── logs/              # LogViewer
        ├── metrics/           # MetricCard
        ├── ui/                # UI-Bausteine (Button, Modal, Input, …)
        └── pages/             # Seiten (s. §8)
```

---

## 4. Bootstrap

### `src/main.jsx`
```
createRoot(#root).render(
  <QueryClientProvider client={queryClient}>   // react-query (ein Client)
    <BrowserRouter>                            // react-router v7
      <App />
    </BrowserRouter>
  </QueryClientProvider>
)
```
- Importiert `./i18n` (Nebenwirkung: i18next init) und `./style/index.css`.
- `@vitejs/plugin-react/preamble` für HMR.

### `src/App.jsx`
- `useAppSettings()` → `theme`, `primaryHue`, `radiusFactor`.
- Drei `useEffect`s setzen live (ohne Reload):
  - `document.documentElement.dataset.theme = theme` (dark/light).
  - `applyPrimaryHue(primaryHue)` → `:root --color-primary`.
  - `applyRadiusFactor(radiusFactor)` → `:root --radius-factor`.
- `<Routes>`:
  - Fullscreen-Routen **außerhalb** des Layouts (kein Sidebar/TopBar).
  - `<Route element={<Layout />}>` — alle übrigen Seiten (Sidebar + TopBar + `<Outlet/>`).
  - `*` → `NotFound`.

---

## 5. Routing

| Pfad | Seite | Zweck |
|---|---|---|
| `/` | `Dashboard` | Übersicht: Instance-Info, Kern-Metriken, Quick-Links |
| `/fullscreen` | Fullscreen-View | Vollbild-Modus (s. §12) |
| `/list` | Listen-Seite | Datenliste mit Pagination, Row-Aktionen |
| `/list/:id` | Detail-Seite | Detail-Ansicht mit Sub-Ressourcen |
| `/settings` | `Settings` | Server-Settings (API) + App-Settings (lokal) |
| `/logs` | `Logs` | Live-Log-Monitor (WebSocket) |
| `*` | `NotFound` | 404 |

Navigation: `layout/navItems.js` → `NAV_SECTIONS` (Sektionen) +
`titleKeyForPath()` für den TopBar-Titel.

---

## 6. Datenlayer

### react-query-Patterns (`hooks/useApi.js`)
- **`useListQuery(queryKey, queryFn, { page, itemsPerPage, … })`** —
  Listen-Query mit `[...key, page, itemsPerPage]`, `placeholderData: prev`
  (bleibt sichtbar bei Refetch), `staleTime: 5000`, `refetchOnWindowFocus: false`.
- **`useMutationWithInvalidate(mutationFn, invalidateKeys)`** — Mutation, die
  nach Erfolg die übergebenen Query-Keys invalidiert.

### Query-Keys (`services/queryKeys.js`)
Zentrale, stabile Keys (Listen + Detail-Funktionen).

### Auto-Refresh (`hooks/useAutoRefresh.js`)
- Liefert `autoRefreshMs` aus den App-Settings (`0` → `false` = aus).
- Wird als `refetchInterval` an die Polling-Queries übergeben. Reagiert live auf Änderungen.

### Feature-Gating (`hooks/useFeatureState.js`)
- **`useFeatureState(flag)`** → `{ enabled, loading }` aus der Global-Config.
- **Wichtig**: Solange `loading` true ist, wird `enabled=false` geliefert und
  **keine** Anfrage an das Feature gestellt (deaktivierte Features würden 404).

### Weitere Hooks
| Hook | Zweck |
|---|---|
| `usePagination(defaultItemsPerPage)` | `page`/`itemsPerPage` State (Default aus App-Settings) |
| `useAction(actionPath, invalidateKeys)` | `POST <actionPath>/<id>` + Invalidate |
| `useMetrics()` | `GET /api/metrics` (localApi) + Auto-Refresh, `placeholderData` |
| `useLogStream({ enabled })` | WebSocket `/logs` (History + Line + Update), Reconnect 2 s, Max 2000 Zeilen |
| `usePlayer(videoRef, url)` | Kompletter Player-Lebenszyklus (s. §11) |
| `useAutoHide(delayMs)` | Auto-hide (3 s ohne Aktivität) für TopBar/Tile-Strip |

---

## 7. App-Settings (lokal, `services/appSettings.js`)

Persistiert in `localStorage`. Reagiert live über `useSyncExternalStore`
(`useAppSettings()`).

| Key | Default | Bedeutung |
|---|---|---|
| `apiBaseUrl` | `''` | Override für Upstream-API (sonst Env/Default) |
| `mediaBaseUrl` | `''` | Override für Media-Base (sonst Env/`window.location.origin`) |
| `theme` | `'dark'` | `'dark'` \| `'light'` |
| `primaryHue` | `~207` | Farbton 0–360 (Sättigung/Helligkeit fix) |
| `radiusFactor` | `0.7` | Roundness 0–1 (skaliert `--radius-*`) |
| `autoRefreshMs` | `10000` | Polling-Intervall (`0` = aus) |
| `itemsPerPage` | `100` | Seitenweite für Tabellen |

API: `getAppSettings()`, `setAppSettings(patch)`, `subscribeAppSettings(listener)`,
`useAppSettings()`.

---

## 8. Seiten (Pages)

Alle Seiten folgen dem Muster: `<div class="page">` → `<header class="page__header">`
(Titel + Subtitle) → Inhalt. Daten via react-query, UI via `ui/*`-Komponenten.

| Seite | Datenquelle | Besonderheiten |
|---|---|---|
| `Dashboard` | Info + Config + Listen | InfoCard, Metrik-Karten, Listen-Karte, QuickLinks |
| Listen-Seite | Listen-Endpunkt | Row-Aktionen, Row-Click → Detail |
| Detail-Seite | Detail-Endpunkt | Sub-Ressourcen, Player, Aktionen |
| `Settings` | `/api/settings` + App-Settings | Server-Settings (API) + App-Settings (lokal) |
| `Logs` | WebSocket `/logs` | Level-Filter, Suche, Pause/Resume, Auto-Scroll |
| `NotFound` | — | 404 + Link zum Dashboard |

---

## 9. Komponenten

### `layout/`
- **`Layout.jsx`** — `<Sidebar/>` + `<TopBar/>` + `<main><Outlet/></main>`.
- **`Sidebar.jsx`** — Brand + `NAV_SECTIONS` (NavLinks, `is-active`).
- **`TopBar.jsx`** — Titel (`titleKeyForPath`), Status-Badge (online/offline/
  connecting), Refresh-Button (refetch active Queries), Sprach-Umschalter (EN/DE/IT).
- **`navItems.js`** — `NAV_SECTIONS` + `titleKeyForPath()`.

### `tables/`
- **`DataTable`** — Generische Tabelle: Spalten (`key`, `label`, `render?`,
  `sortable?`), Client-Sort (asc/desc), Empty-State, Error, Loading, Pagination,
  `onRowClick`. Nested-Keys via `getVal` (`a.b.c`).
- **`Pagination`** — Prev/Next, `itemsPerPage` (10/25/50/100), Zähler.

### `ui/` (Bausteine)
`Badge`, `Button`, `Card`, `DualSlider`, `DurationInput`, `ErrorAlert`, `Input`,
`JsonBlock`, `Markdown`, `Modal`, `MultiSelect`, `RangeSlider`, `Select`,
`Slider`, `Spinner`, `Tabs`, `TagInput`, `Toggle`, `Tooltip`.

- **`Button`** — `variant` (primary/secondary/ghost/danger), `size`, `loading`, `icon`.
- **`Modal`** — Overlay, Escape/Outside-Klick schließt, `footer`-Slot.
- **`Badge`** — Status-Farben via `STATUS_COLORS` (constants.js) oder explizit `color`.
- **`DurationInput`** — Dropdown mit Einheiten (ms…y), +1/-1/+10/-10, Long-Press-Repeat.
- **`TagInput`** — Komma/Enter getrennte Tags, `type` string|number.
- **`RangeSlider`/`DualSlider`** — Zwei-Thumb- bzw. Zwei-Zeilen-Slider.
- **`Tooltip`** — Info-Icon + Tooltip (hover/focus), `aria-describedby`.
- **`JsonBlock`** — Formatiertes JSON in `<pre>`.
- **`Markdown`** — `react-markdown` + `remark-gfm`.

### `logs/`
- **`LogViewer`** — Scroll-Container, Auto-Scroll (wenn am Boden), Zeilen
  (ts/level/message), „Jump to latest"-Button.

### `metrics/`
- **`MetricCard`** — KPI-Karte (Label, Wert, optional Sub, children-Slot).

---

## 10. Formular-System

Schema-getrieben: **reine Daten** (`fieldCatalog.js`) + **Renderer**
(`FormBuilder`/`FormField`/`ListEditor`).

### `fieldCatalog.js` (Daten + Logik)
Feld-Schema:
```js
{ name, label, type, group,
  descriptionKey?, placeholder?, options?, min?, max?, step?,
  itemSchema?, nullable?, deprecated?, required?, multiline?,
  labelKey?, placeholderKey?, restartRequired?, colorPreview?, radiusPreview?, labels? }
```

Kataloge: je einer pro Formular (Global-Config, Entity-Config, User,
Server-Settings, App-Settings) — inkl. **deprecated-Felder** (werden ausgeblendet).

Hilfsfunktionen:
- **`getGroups(catalog)`** — Gruppiert nach `field.group` (Katalog-Reihenfolge),
  überspringt `deprecated`.
- **`validateValues(catalog, values, t)`** — Validierung pro Typ (number/slider
  min/max, duration/size-Regex, select/multi-select options, range/dual-slider,
  list rekursiv, required). Übersetzte Fehlermeldungen.
- **`normalizeForSubmit(catalog, values)`** — Normalisiert für den Submit:
  toggle→bool, text→trim, number→Number, list→rekursiv, tags→Array.
  **Wichtig**: leerer Text → `""` (nicht `null`), damit das Backend den Wert
  wirklich löscht (`null` = „no change"). Unbekannte Keys bleiben erhalten.

### `FormBuilder.jsx` (Renderer)
- Props: `catalog`, `initialValues`, `onSubmit`, `submitLabel`, `loading`,
  `loadError`, `disabled`, `collapsible`, `initialOpen`.
- Initialisiert `values` (lazy bei Mount, sonst via Effect bei asynchronem Laden).
- **1 Gruppe** → einfache Karte (optional collapsible). **Mehrere Gruppen** →
  Subnav + `<details>`-Gruppen (aufklappbar, Scroll-to-Group).
- `handleSubmit`: `validateValues` → bei Fehlern abbrechen, sonst
  `onSubmit(normalizeForSubmit(...))`; `saved`-Feedback (3 s), `submitError`.
- `restartRequired`-Badge pro Feld.

### `FormField.jsx` (Typ-Renderer)
Mappt `field.type` auf UI-Komponenten:
`toggle`, `number`, `slider` (mit `colorPreview`/`radiusPreview`), `range`,
`dual-slider`, `select`, `composite` (Select + optionales Input), `multi-select`,
`tags`, `tags-number`, `list` (`ListEditor`), `password`, `duration`,
`text`/`size`/`command`/`path` (mono, optional `multiline`→textarea).

### `ListEditor.jsx`
- Zeilen-Editor für `type: 'list'`. `defaultItem(schema)` erzeugt leere Items; add/remove/update.

### `*Form` (dünne Wrapper)
Dünne Wrapper um `FormBuilder` mit einem konkreten Katalog und Submit-Logik
(z. B. Restart-Erkennung nach dem Speichern).

---

## 11. Player (`hooks/usePlayer.js`)

Kapselt den kompletten Player-Bibliotheks-Lebenszyklus für ein `<video>`-Element.

- **`url=null`** → kein Load (idle). **`url` gesetzt** → Player-Bibliothek (MSE) oder
  nativer Fallback.
- **Stream-Wechsel** über `loadSource` auf derselben Instanz (nie 2 Instanzen).
- **Unmount** → `destroy()`, keine offenen Requests.
- **Support-Check**: Bibliothek-Unterstützung ODER native Unterstützung.
- **Fehler-Handling**:
  - Media-Error → Recovery (Throttle gegen Recovery-Loops).
  - Network-Error → **kein Retry-Loop**, Fehlerart klassifizieren:
    - HTTP 404 → `offline`
    - keine Response → `cors` (Browser blockiert / Host unerreichbar)
    - sonst → `network`
  - andere fatal → Instanz verwerfen.
- **Rückgabe**: `{ status: 'idle'|'loading'|'playing'|'error', supported, errorKind }`.

**`utils/buildMediaUrl.js`** — `buildMediaUrl(path)` → `{base}/{encodeURIComponent(path)}/…`.
Base-Auflösung: App-Settings `mediaBaseUrl` → Env → `window.location.origin`.

---

## 12. Fullscreen-View

Fullscreen-View mit 3 View-Modes (außerhalb des Layouts, echter Fullscreen):

| Mode | Verhalten |
|---|---|
| `single` | Ein Element groß + Tile-Strip. Klick: inaktiv→start, aktiv→stop, andere→wechsel. |
| `grid` | Alle Elemente gleichzeitig, Grid-Abmessungen = `ceil(sqrt(n))` Spalten. |
| `pip` | Ein Element groß (focused), andere klein (Klick → promote). |

- **Keyboard** (Single): `Esc` (Fullscreen→exit, sonst→stop), `←`/`→`
  (Tile-Navigation, Wrap-around).
- **Auto-hide** (`useAutoHide`): TopBar + Tile-Strip nach 3 s ohne
  Mausbewegung (opacity 0 + pointer-events none).
- **Mute**: Grid/PiP starten muted (Browser-Autoplay-Policy).
- **Empty-States** (Reihenfolge): Player nicht unterstützt → nicht konfiguriert
  → List-Error → Loading → keine Elemente.
- **Exit**: `navigate(-1)` → Unmount → Stream stoppt.

---

## 13. Styling (`src/style/`)

Handgeschriebenes CSS, **kein Framework**. Struktur:

```
style/
├── index.css        # @import variables, typo, global, components
├── variables.css    # Design-Tokens (Farben, Radien, Schatten, Space, Type)
├── typo.css         # Typografie
├── global.css       # Globale Styles
└── components/      # CSS-Dateien (pro Komponente/Bereich)
```

### Design-Tokens (`variables.css`)
- **Brand**: `--color-primary` + Hover/Active/Subtle (via `color-mix`).
- **Neutrals**: `--color-bg`, `--color-surface`, `--color-text`, `--color-border`, …
- **Status**: `--color-success`, `--color-validation`, `--color-error`, `--color-connection`.
- **Shape**: `--radius-factor` (0.7) skaliert `--radius-sm/-/-lg/-xl/-pill`.
- **Depth**: `--shadow-sm/-md/-lg`.
- **Space**: 4px-Basis (`--space-1` … `--space-12`).
- **Type**: `--font-sans`, `--font-mono`, `--fs-*`.

### Themes
- **Light** (Default) + **Dark** via `:root[data-theme="dark"]` und
  `@media (prefers-color-scheme: dark)` (System-Präferenz, außer explizit light).
- `data-theme` wird live von `App.jsx` gesetzt (kein Reload).

### Dynamische Tokens
- **Primary-Hue**: `applyPrimaryHue(hue)` setzt `--color-primary` auf
  `hsl(hue, fixS%, fixL%)` (Sättigung/Helligkeit fix).
  `utils/primaryColor.js` (muss mit `--color-primary` synchron bleiben).
- **Roundness**: `applyRadiusFactor(factor)` setzt `--radius-factor`; alle
  `--radius-*` folgen. `utils/radius.js` (muss mit `--radius-factor` synchron bleiben).

---

## 14. Utilities (`src/utils/`)

| Datei | Funktion |
|---|---|
| `buildMediaUrl.js` | Media-URL bauen (Base-Auflösung + Pfad) |
| `constants.js` | `STATUS_COLORS` (Badge-Töne) + `enumLabel()` (übersetzte Enum-Labels) |
| `formatBytes.js` | Bytes → `B/KB/MB/GB/TB/PB` (1024-Basis) |
| `formatDate.js` | ISO → `toLocaleString()` |
| `primaryColor.js` | Hue → `hsl()` (fixe S/L), `applyPrimaryHue()` |
| `radius.js` | Faktor → Radius, `applyRadiusFactor()` |
| `splitUrlAuth.js` | Basic-Auth aus URL trennen (`{ url, auth }`) |

---

## 15. i18n (`src/i18n.js` + `src/locales/`)

- **Sprachen**: `en` (Fallback), `de`, `it`.
- **Top-Level-Keys**: `common`, `nav`, `topbar`, `pages`, `form`, `fields`,
  `settings`, `groups`, `validation`, `enums`.
- **Detektion**: `localStorage` → `navigator.language` (de/it) → `en`.
- **Persistenz**: `languageChanged` → `localStorage`.
- **Konfiguration**: `escapeValue: false` (React escaped bereits),
  `useSuspense: false` (Ressourcen synchron im Bundle).
- **Nutzung**: `useTranslation()` → `t(key, values)`; `<Trans>` für
  Interpolation mit JSX; `defaultValue` als Fallback.
- **Enum-Labels**: `enums.<name>.<value>` (via `enumLabel()` in `constants.js`).

---

## 16. Umgebungsvariablen

| Variable | Default | Zweck |
|---|---|---|
| `UPSTREAM_API_URL` | — | Base-URL der Upstream-API (Bridge) |
| `UPSTREAM_MEDIA_URL` | — | Media-Base-URL (Player) |
| `VITE_WS_HOST` | `localhost` | HMR-WebSocket-Host (Dev) |
| `VITE_WS_PORT` | `3000` | HMR-WebSocket-Port (Dev) |

> Base-URLs können zur Laufzeit per **App-Settings**
> (`apiBaseUrl`/`mediaBaseUrl`) überschrieben werden — Override gewinnt über Env.

---

## 17. Tests (`frontend/tests/`)

SSR-Smoke-Tests (Node, `.mjs`) — rendern Seiten/Komponenten und prüfen
Struktur/Abwesenheit von Fehlern.

> **Hinweis**: `npm run lint` existiert **nicht** im Projekt. Tests + Build
> sind das Gate.

---

## 18. Konventionen & Muster

1. **Zwei API-Kanäle**: `api` (Upstream via Bridge) vs. `localApi` (Server).
   Nicht vermischen.
2. **Query-Keys zentral** in `services/queryKeys.js` — nicht inline erfinden.
3. **Listen** via `useListQuery` (Pagination + `placeholderData`).
4. **Mutations** via `useMutationWithInvalidate` (Invalidate nach Erfolg).
5. **Feature-Gating**: `useFeatureState` — keine Anfrage an deaktivierte Features (sonst 404).
6. **Auto-Refresh**: `useAutoRefresh()` als `refetchInterval` (0 = aus).
7. **Formulare**: Schema in `fieldCatalog.js` + `FormBuilder`/`FormField` —
   keine ad-hoc-Formulare.
8. **Deprecated-Felder**: `deprecated: true` → werden ausgeblendet, aber
   beim Submit erhalten (nicht gelöscht).
9. **Leerer Text → `""`** (nicht `null`) beim Submit, damit das Backend den Wert
   löscht (`null` = „no change").
10. **i18n**: Alle UI-Texte über `t(key)`; `defaultValue` als Fallback.
11. **Styling**: CSS-Variablen aus `variables.css`; neue Komponenten-CSS in
    `style/components/`.
12. **Keine schweren State-Libs** — `useState` + react-query +
    `useSyncExternalStore`.
13. **Player**: Immer `usePlayer` (Lebenszyklus + Fehler-Klassifizierung),
    nie die Player-Bibliothek direkt.
14. **Fullscreen-View**: Außerhalb des Layouts (Fullscreen), Auto-hide, Muted-Autoplay.

---

## 19. Wichtige Dateien (Schnellreferenz)

| Datei | Zweck |
|---|---|
| `src/main.jsx` | Bootstrap |
| `src/App.jsx` | Theme/Hue/Radius + Routen |
| `src/api/client.js` | axios-Client (api + localApi) |
| `src/services/appSettings.js` | Lokale App-Settings |
| `src/services/queryKeys.js` | Query-Keys |
| `src/i18n.js` | i18next-Init |
| `src/hooks/usePlayer.js` | Player-Lebenszyklus |
| `src/hooks/useLogStream.js` | Log-WebSocket |
| `src/components/forms/fieldCatalog.js` | Formular-Schemata + Validierung |
| `src/components/forms/FormBuilder.jsx` | Formular-Renderer |
| `src/components/tables/DataTable.jsx` | Generische Tabelle |
| `src/style/variables.css` | Design-Tokens |
| `vite.config.js` | Vite (middlewareMode) |
