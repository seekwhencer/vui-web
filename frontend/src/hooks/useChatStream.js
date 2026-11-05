import { useCallback, useRef, useState } from 'react';
import { chatStream } from '../api/chat.js';

// Manche Modelle emittieren das Thinking inline im Content als Think-Tags
// statt als separates `thinking`-Event. Die Tags werden hier aus Teilen
// zusammengesetzt, damit sie nicht als Markup interpretiert werden.
const OPEN_TAG = '<think' + '>';
const CLOSE_TAG = '<think' + '/' + 'think' + '>';

/**
 * Streaming-Chat-Hook.
 *
 * Iteriert über `chatStream(question, history)` und sammelt die
 * `thinking`- und `answer`-Tokens. Manche Modelle emittieren das Thinking
 * inline im Content als Think-Tags statt als separates `thinking`-Event —
 * die OPEN_TAG/CLOSE_TAG-Logik extrahiert diese und leitet sie korrekt zu
 * `thinking` bzw. `answer` weiter.
 */
export default function useChatStream() {
  const [thinking, setThinking] = useState('');
  const [answer, setAnswer] = useState('');
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const abortRef = useRef(null);

  const abort = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const run = useCallback(async (question, history) => {
    setQuestion(question);
    let serverThinking = '';
    let extractedThinking = '';
    let answerPrefix = '';
    let answerSuffix = '';
    let buffer = '';
    let inThink = false;
    let thinkClosed = false;
    let err = null;

    const flush = () => {
      setThinking(serverThinking + extractedThinking);
      setAnswer(answerPrefix + answerSuffix);
    };

    setThinking('');
    setAnswer('');
    setError(null);
    setPending(true);
    setDone(false);

    const controller = new AbortController();
    abortRef.current = controller;

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
          setDone(true);
          setPending(false);
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
        setPending(false);
        setDone(true);
      } else {
        err = e;
        setError(e);
        setPending(false);
        setDone(true);
      }
    } finally {
      abortRef.current = null;
    }

    return { thinking: serverThinking + extractedThinking, answer: answerPrefix + answerSuffix, error: err };
  }, []);

  const setResult = useCallback(({ thinking: t, answer: a, error: e, question: q }) => {
    setThinking(t || '');
    setAnswer(a || '');
    setError(e || null);
    setQuestion(q || '');
    setPending(false);
    setDone(true);
  }, []);

  return { thinking, answer, question, pending, error, done, run, setResult, abort };
}
