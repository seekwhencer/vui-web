/**
 * Settings-API-Client.
 *
 * Endpunkte (gleiche Origin, wie mcp.js/actions.js):
 *   GET  /api/settings → { success, data: { whisper, llm, security, ... } }
 *   PUT  /api/settings → { success, data, applied, restartRequired }
 *
 * `data.security.toolPolicies` ist die Map `${serverId}__${toolName}` →
 * 'read'|'write'|'execute'|'deny'. Der Server ersetzt `security.toolPolicies`
 * bei einem PUT vollständig (shallow-Merge auf `security`) → immer die
 * komplette Map senden.
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

/** Liefert die aktuellen Settings (inkl. `security.toolPolicies`). */
export const getSettings = () => request('/api/settings');

/** Speichert einen Settings-Patch (z. B. `{ security: { toolPolicies } }`). */
export const updateSettings = (patch) =>
  request('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
