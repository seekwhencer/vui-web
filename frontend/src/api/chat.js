/**
 * Chat-API-Client.
 *
 * Endpunkte (gleiche Origin, wie useSettings/useTranscription):
 *   POST /api/chat        → { success, data: { answer } }
 *   POST /api/chat/stream → SSE-Stream (Events: thinking, answer, done, error)
 *
 * `history` ist ein optionales Array `{ role, content }` (frühere Nachrichten).
 * `signal` ist ein optionales AbortSignal zum Abbrechen der Anfrage.
 */

const CHAT_PATH = '/api/chat';
const CHAT_STREAM_PATH = '/api/chat/stream';

/**
 * Liest den JSON-Body einer Fehlerantwort und liefert die Fehlermeldung.
 * @param {Response} res - Die HTTP-Antwort
 * @returns {Promise<string>}
 */
async function errorMessage(res) {
  let message = `Request failed with status ${res.status}`;
  try {
    const body = await res.json();
    if (body && typeof body.error === 'string') message = body.error;
  } catch (_) { /* kein JSON-Body → Standardmeldung behalten */ }
  return message;
}

/**
 * Non-streaming Chat.
 * @param {string} question - Die aktuelle Frage
 * @param {Array<{role: string, content: string}>} [history] - Optionale frühere Nachrichten
 * @param {AbortSignal} [signal] - Optionales AbortSignal
 * @returns {Promise<string>} Die Antwort des LLM
 */
export async function chat(question, history, signal) {
  let res;
  try {
    res = await fetch(CHAT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ question, history }),
      signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw Object.assign(new Error('Connection to server failed.'), { name: 'NetworkError', status: 0 });
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) {
    throw new Error(body.error || `Request failed with status ${res.status}`);
  }
  return body.data?.answer;
}

/**
 * Streaming-Chat als Async-Generator.
 *
 * Liest den SSE-Stream und liefert pro Event `{ event, data }` aus,
 * wobei `event` ∈ { thinking, answer, done, error } und `data` der
 * (JSON-dekodierte) Token-String bzw. Payload ist.
 *
 * @param {string} question - Die aktuelle Frage
 * @param {Array<{role: string, content: string}>} [history] - Optionale frühere Nachrichten
 * @param {AbortSignal} [signal] - Optionales AbortSignal
 * @yields {{ event: string, data: * }}
 */
export async function* chatStream(question, history, signal) {
  let res;
  try {
    res = await fetch(CHAT_STREAM_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ question, history }),
      signal,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw Object.assign(new Error('Connection to server failed.'), { name: 'NetworkError', status: 0 });
  }

  if (!res.ok) {
    const message = await errorMessage(res);
    const err = new Error(message);
    err.status = res.status;
    err.response = res;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE-Blöcke sind durch eine Leerzeile (\n\n) getrennt.
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        let event = '';
        const dataLines = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^\s*/, ''));
        }
        if (!event) continue;

        const dataStr = dataLines.join('\n');
        let data;
        try { data = JSON.parse(dataStr); } catch { data = dataStr; }
        yield { event, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
