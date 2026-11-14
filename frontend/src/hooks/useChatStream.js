import { useSyncExternalStore } from 'react';
import { chatStream } from '../api/chat.js';

// Manche Modelle emittieren das Thinking inline im Content als Think-Tags
// statt als separates `thinking`-Event. Die Tags werden hier aus Teilen
// zusammengesetzt, damit sie nicht als Markup interpretiert werden.
const OPEN_TAG = '<think' + '>';
const CLOSE_TAG = '<think' + '/' + 'think' + '>';

// Zustand + laufender Stream leben auf Modulebene, NICHT im Component-State.
// So überleben sie das Unmounten der ChatPage (Seitenwechsel): Der
// `for await`-Loop läuft weiter, und beim Zurückkehren liest die Seite den
// aktuellen Zustand (inkl. laufender Ausgabe) aus dem Store.
let state = {
  question: '',
  thinking: '',
  answer: '',
  pending: false,
  error: null,
  done: false,
  // Zeitstempel (ms) des `done`-Events — nur bei erfolgreichem Abschluss,
  // NICHT bei Abbruch/Fehler. Dient dem visuellen "Fertig"-Signal.
  completedAt: null,
  pendingApprovals: [],
  images: [],
};

const listeners = new Set();

function emit() {
  for (const listener of listeners) listener();
}

function setState(patch) {
  state = { ...state, ...patch };
  emit();
}

let abortController = null;

function abort() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}

// Pending Approval-Aktionen (Zero-Trust): leben wie der Stream-Zustand auf
// Modulebene, damit sie Seitenwechsel überleben. `approval_required`-Events
// legen sie hier ab; der ApprovalDialog liest sie und entfernt sie nach
// Auflösung. Die Parameter kommen serverseitig (vollständig, hash-gebunden)
// — nicht aus dem LLM-Text.
function addPendingApproval(action) {
  const index = state.pendingApprovals.findIndex((a) => a.id === action.id);
  if (index === -1) {
    setState({ pendingApprovals: [...state.pendingApprovals, action] });
    return;
  }
  // Bereits bekannt → Daten aktualisieren, Position (FIFO) behalten.
  const next = state.pendingApprovals.slice();
  next[index] = { ...next[index], ...action };
  setState({ pendingApprovals: next });
}

function clearPendingApproval(id) {
  setState({ pendingApprovals: state.pendingApprovals.filter((a) => a.id !== id) });
}

function getPendingApprovals() {
  return state.pendingApprovals;
}

/**
 * Startet einen Streaming-Turn. Läuft asynchron weiter, auch wenn die
 * ChatPage in der Zeit unmounted wird (Seitenwechsel). Liefert am Ende
 * `{ thinking, answer, error, images, tokens, model }`.
 */
async function run(question, history, reasoningEffort) {
  let serverThinking = '';
  let extractedThinking = '';
  let answerPrefix = '';
  let answerSuffix = '';
  let buffer = '';
  let inThink = false;
  let thinkClosed = false;
  let images = [];
  // Dedup: Gleiche Bilder (identischer base64-Data) werden nur einmal
  // gesammelt — auch wenn das LLM ein Tool mehrfach aufruft (Loop ohne Vision).
  let seenImageHashes = new Set();
  let err = null;

  const flush = () => {
    setState({
      thinking: serverThinking + extractedThinking,
      answer: answerPrefix + answerSuffix,
    });
  };

  setState({
    question,
    thinking: '',
    answer: '',
    error: null,
    pending: true,
    done: false,
    completedAt: null,
    images: [],
  });

  const controller = new AbortController();
  abortController = controller;

  try {
    for await (const { event, data } of chatStream(question, history, controller.signal, reasoningEffort)) {
      if (event === 'thinking') {
        serverThinking += data;
        flush();
      } else if (event === 'answer') {
        buffer += data;

        if (!thinkClosed) {
          if (!inThink) {
            const openIdx = buffer.indexOf(OPEN_TAG);
            if (openIdx !== -1) {
              answerPrefix += buffer.slice(0, openIdx);
              buffer = buffer.slice(openIdx + OPEN_TAG.length);
              inThink = true;
            } else {
              const keep = OPEN_TAG.length - 1;
              if (buffer.length > keep) {
                answerPrefix += buffer.slice(0, buffer.length - keep);
                buffer = buffer.slice(buffer.length - keep);
              }
            }
          } else {
            const closeIdx = buffer.indexOf(CLOSE_TAG);
            if (closeIdx !== -1) {
              extractedThinking += buffer.slice(0, closeIdx);
              buffer = buffer.slice(closeIdx + CLOSE_TAG.length);
              inThink = false;
              thinkClosed = true;
              answerSuffix += buffer;
              buffer = '';
            } else {
              const keep = CLOSE_TAG.length - 1;
              if (buffer.length > keep) {
                extractedThinking += buffer.slice(0, buffer.length - keep);
                buffer = buffer.slice(buffer.length - keep);
              }
            }
          }
        } else {
          answerSuffix += buffer;
          buffer = '';
        }

        flush();
      } else if (event === 'approval_required') {
        // Zero-Trust: write/execute-Tools werden NICHT ausgeführt, sondern
        // als Freigabe vorgeschlagen → Aktion in den Store legen.
        addPendingApproval({
          id: data.actionId,
          toolName: data.toolName,
          arguments: data.arguments,
          reason: data.reason,
          expiresAt: data.expiresAt,
          status: 'PENDING_APPROVAL',
        });
      } else if (event === 'approval_resolved') {
        // Aktion wurde (ggf. woanders) aufgelöst → aus dem Store entfernen.
        if (data && data.actionId) clearPendingApproval(data.actionId);
      } else if (event === 'tool_result') {
        // MCP-Tool-Ergebnis mit Bild (ImageContent): Bilder für den
        // Live-Turn sammeln. Ohne `images` (oder bei altem Server) bleibt
        // die Liste leer. Dedup per base64-Data: Ein Tool-Loop (z. B.
        // take_screenshot ohne Vision) liefert dasselbe Bild mehrfach —
        // nur das erste wird behalten.
        if (data && Array.isArray(data.images)) {
          let added = false;
          for (const img of data.images) {
            if (img && typeof img.data === 'string' && !seenImageHashes.has(img.data)) {
              seenImageHashes.add(img.data);
              images.push(img);
              added = true;
            }
          }
          if (added) setState({ images: [...images] });
        }
      } else if (event === 'done') {
        setState({
          done: true,
          pending: false,
          completedAt: Date.now(),
          tokens: data?.tokens || null,
          model: data?.model || null,
        });
        flush();
      } else if (event === 'error') {
        const message =
          (data && typeof data === 'object' && data.message) ||
          (typeof data === 'string' && data) ||
          'Streaming failed.';
        throw new Error(message);
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') {
      // Intentionaler Abbruch → kein Fehler, nur pending/done aktualisieren
      setState({ pending: false, done: true });
    } else {
      err = e;
      setState({ error: e, pending: false, done: true });
    }
  } finally {
    abortController = null;
  }

  // Die "keep last N chars"-Logik hält ein Tail im Buffer zurück, um ein
  // über Events geteiltes Think-Tag zu erkennen. Am Ende des Streams kommt
  // keine weitere Daten mehr — dieses Tail wird hier in den richtigen
  // Bucket entlassen, sonst gingen die letzten Zeichen der Antwort verloren.
  if (buffer) {
    if (thinkClosed) {
      answerSuffix += buffer;
    } else if (inThink) {
      extractedThinking += buffer;
    } else {
      answerPrefix += buffer;
    }
    buffer = '';
    flush();
  }

  return {
    thinking: serverThinking + extractedThinking,
    answer: answerPrefix + answerSuffix,
    error: err,
    images,
    tokens: state.tokens || null,
    model: state.model || null,
  };
}

function setResult({ thinking, answer, error, question, tokens, model, images }) {
  setState({
    thinking: thinking || '',
    answer: answer || '',
    error: error || null,
    question: question || '',
    tokens: tokens || null,
    model: model || null,
    images: images || [],
    pending: false,
    done: true,
    completedAt: null,
  });
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return state;
}

/**
 * Streaming-Chat-Hook.
 *
 * Liest den (modulebenen) Stream-Zustand und stellt `run`, `setResult` und
 * `abort` bereit. Der Zustand überlebt Seitenwechsel, weil er nicht im
 * Component-State, sondern im Store lebt.
 */
export default function useChatStream() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  return { ...snapshot, run, setResult, abort, addPendingApproval, clearPendingApproval };
}

// Named-Exports (für Tests + direkte Nutzung ohne Hook).
export { run, setResult, abort, addPendingApproval, clearPendingApproval, getPendingApprovals };
