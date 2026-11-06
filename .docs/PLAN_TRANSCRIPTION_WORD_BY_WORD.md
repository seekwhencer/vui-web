# PLAN: Transkription Wort-für-Wort ("Typewriter") — nur Frontend

## Ziel

Eingehender Transkriptions-Text wird im Feld **Wort für Wort "geschrieben"** statt in einem Stück angehängt/ersetzt.
Reines Frontend-Feature: kein Server-Change, keine neuen Dependencies, keine i18n-Strings.

## Ausgangslage

| Aspekt | Aktuell |
|---|---|
| Datenquelle | `useTranscription.js` — WS `/transcribe`, Messages `{ text, isFinal }` |
| Final-Text | `setFinalText(prev => prev + data.text + ' ')` — **komplett in einem Rutsch** angehängt |
| Interim-Text | `setInterimText(data.text)` — **komplett ersetzt** pro Message |
| Anzeige | `TranscriptView.jsx` rendert `<span>{finalText}</span><span class="transcript__interim">{interimText}</span>` + Auto-Scroll |
| Konsumenten | `TranscriptionPage` (Send-to-Chat nutzt `finalText`), `ChatPage` (`VoiceControls` zeigt `interimText`, Stop hängt `finalText` an Input) |
| CSS | `style/components/transcription.css`, BEM, CSS-Variablen |
| Tests | `vitest` in devDependencies |

**Problem:** Final-Chunks (z. B. 5–15 Wörter) erscheinen sofort als Block. Soll sich wie Tippen anfühlen.

## Architektur-Entscheidung

- **`useTranscription.js` bleibt unverändert.** `finalText`/`interimText` bleiben die **Volltexte** (Single Source of Truth).
  - Send-to-Chat und ChatPage-Voice-Input senden den **Volltext**, auch wenn die Anzeige noch "tippt". Bewusst so: Logik ≠ Animation.
- **Neuer generischer Hook `useTypewriter(target)`** trennt "empfangener Text" von "angezeigtem Text".
  - `TranscriptView` wendet ihn auf `finalText` und `interimText` an.
  - `VoiceControls` (ChatPage) bleibt unverändert (kleiner Interim-Hinweis, kein Tipp-Effekt nötig).
- **Wort-Granularität, nicht Zeichen-Granularität.** Split via `target.match(/\S+\s*/g)` (erhält Leerzeichen/Ende).
- **Catch-up statt fester 1-Wort-Takt:** Bei schnellem Sprech wächst der Backlog; der Takt holt proportional auf (siehe Formel unten). Kein unendliches Nachtippen.
- **Append vs. Replace erkennen:** `target.startsWith(prevTarget)` → Fortsetzen (Final-Append, wachsendes Interim). Sonst → Reset auf 0 (Interim-Hypothese geändert).

### Typewriter-Regeln

```
tokens      = target.match(/\S+\s*/g) || []
backlog     = tokens.length - revealedCount
step        = max(1, ceil(backlog / CATCH_UP))     // CATCH_UP = 8
revealed    = min(tokens.length, revealedCount + step)
displayed   = tokens.slice(0, revealed).join('')
```

- `TYPING_INTERVAL_MS = 80` (≈ 12 Wörter/s bei leerem Backlog — fühlt sich wie Tippen an)
- `CATCH_UP = 8` (Backlog 80 Wörter → 10 Wörter/Tick → in ~8 Ticks / 0,6 s aufgeholt)
- Timer läuft nur, solange `revealed < tokens.length`; bei Erreichen stoppen, bei neuem Target neu starten.

## Schritt 1: Hook `useTypewriter`

**Datei:** `frontend/src/hooks/useTypewriter.js` (neu)

```js
import { useEffect, useRef, useState } from 'react';

const TYPING_INTERVAL_MS = 80;
const CATCH_UP = 8;

export function tokenize(text) {
  return text.match(/\S+\s*/g) || [];
}

export function nextRevealedCount(target, prevTarget, revealedCount, catchUp = CATCH_UP) {
  const tokens = tokenize(target);
  if (target && !target.startsWith(prevTarget)) return 0; // Replace → Reset
  const backlog = tokens.length - revealedCount;
  if (backlog <= 0) return revealedCount;
  return Math.min(tokens.length, revealedCount + Math.max(1, Math.ceil(backlog / catchUp)));
}

export default function useTypewriter(target) {
  const [displayed, setDisplayed] = useState('');
  const prevTargetRef = useRef('');
  const revealedRef = useRef(0);
  const timerRef = useRef(null);

  useEffect(() => {
    const tick = () => {
      revealedRef.current = nextRevealedCount(target, prevTargetRef.current, revealedRef.current);
      prevTargetRef.current = target;
      const tokens = tokenize(target);
      setDisplayed(tokens.slice(0, revealedRef.current).join(''));
      if (revealedRef.current >= tokens.length) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
    if (!timerRef.current) timerRef.current = setInterval(tick, TYPING_INTERVAL_MS);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [target]);

  return displayed;
}
```

**Anforderungen:**
- `tokenize` + `nextRevealedCount` sind **pure Funktionen** (exportiert) → unit-testbar ohne React.
- Cleanup: `clearInterval` bei Target-Wechsel und Unmount.
- Kein `useRef`-Race: `revealedRef`/`prevTargetRef` sind die einzige mutable Quelle, `displayed` ist abgeleiteter State.

## Schritt 2: `TranscriptView` nutzt den Hook

**Datei:** `frontend/src/components/TranscriptView.jsx`

```jsx
import useTypewriter from '../hooks/useTypewriter.js';

export default function TranscriptView({ finalText, interimText }) {
  const displayedFinal = useTypewriter(finalText);
  const displayedInterim = useTypewriter(interimText);
  // ...
  // Auto-Scroll-Effect: Abhängigkeiten auf [displayedFinal, displayedInterim]
  // Rendering:
  //   <span>{displayedFinal}</span>
  //   <span className="transcript__interim">{displayedInterim}</span>
  // Placeholder: !finalText && !interimText (Volltexte, nicht displayed)
}
```

**Wichtig:**
- Props-Signatur bleibt identisch → `TranscriptionPage`/`ChatPage` brauchen **keine** Änderung.
- Auto-Scroll feuert pro Tick (80 ms) statt pro WS-Message — flüssiger, kein Sprung.
- Placeholder-Logik prüft die **Volltexte** (sonst bliebe der Placeholder sichtbar, solange getippt wird).

## Schritt 3 (optional): Caret

**Datei:** `frontend/src/style/components/transcription.css`

Blinkender Block-Caret am Ende des Interim-Span, nur während `displayedInterim` hinter `interimText` herhinkt:

```css
.transcript__caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  background-color: var(--color-primary);
  vertical-align: text-bottom;
  animation: caret-blink 0.9s step-end infinite;
}

@keyframes caret-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}
```

Nur bei Bedarf — Kernfeature funktioniert ohne.

## Edge Cases

| Fall | Verhalten |
|---|---|
| Schnelles Sprechen (Backlog) | Catch-up-Formel holt auf, max. `ceil(backlog/8)` Wörter/Tick |
| Interim-Hypothese ändert sich (z. B. "hallo" → "hallo welt") | `startsWith`-Check: wächst → Fortsetzen, ändert sich → Reset auf 0 |
| Final-Chunk trifft ein | Immer Append (`prev + text + ' '`) → Fortsetzen, nie Reset |
| Clear-Button | `finalText`/`interimText` → `''` → `displayed` → `''` (Reset via `startsWith`-Zweig) |
| Send-to-Chat während des Tippens | Sendet den **Volltext** `finalText` — korrekt, Animation ist nur Kosmetik |
| Unmount während Tippens | `clearInterval` im Effect-Cleanup |
| Leere WS-Message / `data.text` leer | `useTranscription` filtert bereits (`if (!data.text) return`) |
| Doppeltes `useTypewriter` (final + interim) | Zwei unabhängige Instanzen, keine gemeinsame State — bewusst einfach |

## Tests

**Datei:** `frontend/src/hooks/useTypewriter.test.js` (neu, vitest)

Nur die puren Funktionen testen (kein React-Rendering nötig):

1. `tokenize('')` → `[]`; `tokenize('hallo welt ')` → `['hallo ', 'welt ']`
2. `nextRevealedCount` Append: `('hallo welt', 'hallo', 1)` → `2` (1 Wort/Tick)
3. `nextRevealedCount` Catch-up: Backlog 16, `catchUp=8` → `+2`
4. `nextRevealedCount` Replace: `('ganz neu', 'hallo', 1)` → `0`
5. `nextRevealedCount` Cap: nie > `tokens.length`

## Ausdrücklich NICHT

- Kein Server-/WS-Change (Server sendet weiter `{ text, isFinal }`)
- Keine neue Dependency (kein `react-typewriter` o. ä.)
- Keine i18n-Änderung (keine neuen Strings)
- Kein Zeichen-für-Zeichen-Typing (Wörter sind die Granularität — robuster bei Umlauten/Whitespace)
- `VoiceControls` in ChatPage bleibt unverändert
