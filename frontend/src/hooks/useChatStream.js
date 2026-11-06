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

/**
 * Startet einen Streaming-Turn. Läuft asynchron weiter, auch wenn die
 * ChatPage in der Zeit unmounted wird (Seitenwechsel). Liefert am Ende
 * `{ thinking, answer, error }`.
 */
async function run(question, history) {
  let serverThinking = '';
  let extractedThinking = '';
  let answerPrefix = '';
  let answerSuffix = '';
  let buffer = '';
  let inThink = false;
  let thinkClosed = false;
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
  });

  const controller = new AbortController();
  abortController = controller;

  try {
    for await (const { event, data } of chatStream(question, history, controller.signal)) {
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
      } else if (event === 'done') {
        setState({ done: true, pending: false });
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

  return { thinking: serverThinking + extractedThinking, answer: answerPrefix + answerSuffix, error: err };
}

function setResult({ thinking, answer, error, question }) {
  setState({
    thinking: thinking || '',
    answer: answer || '',
    error: error || null,
    question: question || '',
    pending: false,
    done: true,
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
  return { ...snapshot, run, setResult, abort };
}
