/**
 * Approval-API-Client (Zero-Trust).
 *
 * Endpunkte (gleiche Origin, wie chat.js/mcp.js):
 *   GET  /api/actions/pending          → { success, data: [action] }
 *   GET  /api/actions/:id              → { success, data: action }
 *   POST /api/actions/:id/approve      → { success, data: action }
 *   POST /api/actions/:id/reject       → { success, data: action }
 *   POST /api/actions/:id/cancel       → { success, data: action }
 *
 * Eine `action` hat: id, toolName, serverId, arguments, reason,
 * expiresAt (ISO), status, ...
 *
 * Die Freigabe bindet sich serverseitig an den Hash der GESPEICHERTEN
 * Parameter — das Frontend zeigt daher immer die serverseitigen Daten
 * (GET /api/actions/:id), nicht eine LLM-Darstellung.
 */

/**
 * Führt einen JSON-Request aus und liefert `body.data`.
 * @param {string} path - Der API-Pfad
 * @param {object} [options={}] - Fetch-Optionen (method, body, signal)
 * @returns {Promise<object>} Der `data`-Teil der Antwort
 */
async function request(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      ...options,
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw Object.assign(new Error('Connection to server failed.'), { name: 'NetworkError', status: 0 });
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) {
    const err = new Error(body.error || `Request failed with status ${res.status}`);
    err.status = res.status;
    err.response = res;
    throw err;
  }
  return body.data;
}

/** Liefert alle offenen (pending) Freigabe-Aktionen. */
export const getPendingActions = () => request('/api/actions/pending');

/** Liefert die serverseitig gespeicherte Aktion (kanonische Parameter + Status). */
export const getAction = (id) => request(`/api/actions/${encodeURIComponent(id)}`);

/** Genehmigt eine Aktion (einmalig, hash-gebunden, ablaufend). */
export const approveAction = (id) =>
  request(`/api/actions/${encodeURIComponent(id)}/approve`, { method: 'POST' });

/** Lehnt eine Aktion ab (optional mit Begründung). */
export const rejectAction = (id, reason) =>
  request(`/api/actions/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
    body: JSON.stringify(reason ? { reason } : {}),
  });

/** Bricht eine offene Aktion ab. */
export const cancelAction = (id) =>
  request(`/api/actions/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
