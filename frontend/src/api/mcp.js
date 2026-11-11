/**
 * MCP-API-Client.
 *
 * Endpunkte (gleiche Origin, wie chat.js):
 *   GET    /api/mcp/servers               → { servers: [...] }
 *   GET    /api/mcp/capability            → { toolSupport: boolean }
 *   POST   /api/mcp/servers               → { server, result }
 *   PUT    /api/mcp/servers/:id           → { server, result }
 *   DELETE /api/mcp/servers/:id           → { removed }
 *   POST   /api/mcp/servers/:id/reconnect → { server, result }
 *   GET    /api/mcp/servers/:id/tools     → { tools: [...] }
 *   POST   /api/mcp/call                  → { content, isError }
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

/** Liefert die Liste aller MCP-Server inkl. Status. */
export const listMcpServers = () => request('/api/mcp/servers').then((d) => d.servers);

/** Liefert den Tool-Support des LLM-Backends. */
export const getMcpCapability = () => request('/api/mcp/capability');

/** Legt einen MCP-Server an (ID wird serverseitig generiert) + verbindet. */
export const addMcpServer = (entry) =>
  request('/api/mcp/servers', { method: 'POST', body: JSON.stringify(entry) });

/** Aktualisiert einen MCP-Server (Partial) + (re)connectet bei Bedarf. */
export const updateMcpServer = (id, patch) =>
  request(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) });

/** Löscht einen MCP-Server + disconnectet. */
export const removeMcpServer = (id) =>
  request(`/api/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });

/** Verbindet einen MCP-Server neu. */
export const reconnectMcpServer = (id) =>
  request(`/api/mcp/servers/${encodeURIComponent(id)}/reconnect`, { method: 'POST' });

/** Liefert die Tool-Liste eines verbundenen Servers. */
export const listMcpTools = (id) =>
  request(`/api/mcp/servers/${encodeURIComponent(id)}/tools`).then((d) => d.tools);

/** Führt einen Tool-Call direkt aus (für Tests / Debug). */
export const callMcpTool = (serverId, name, arguments_) =>
  request('/api/mcp/call', { method: 'POST', body: JSON.stringify({ serverId, name, arguments: arguments_ }) });
