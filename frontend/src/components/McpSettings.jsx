import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2, RefreshCw, Power } from 'lucide-react';
import {
  listMcpServers, addMcpServer, updateMcpServer,
  removeMcpServer, reconnectMcpServer, listMcpTools, getMcpCapability,
} from '../api/mcp.js';

const EMPTY_FORM = { name: '', url: '', headers: '', enabled: true };

/**
 * MCP-Tab in der Settings-Seite.
 *
 * Eigene CRUD-UI (Add / Edit / Delete, Enable/Disable, Reconnect, Tool-Liste).
 * Änderungen wirken sofort (dedizierte /api/mcp/*-Endpunkte) — kein globaler
 * Save-Button. Nutzt die MCP-API direkt (api/mcp.js).
 */
export default function McpSettings() {
  const { t } = useTranslation();
  const [servers, setServers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null); // null = geschlossen, sonst { id?, ...EMPTY_FORM }
  const [expandedTools, setExpandedTools] = useState({}); // id → tools[]
  const [toolSupport, setToolSupport] = useState(null); // null = unbekannt, true/false = erkannt

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setServers(await listMcpServers());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Tool-Support des LLM-Backends (für Hinweis).
  useEffect(() => {
    getMcpCapability()
      .then((cap) => setToolSupport(cap.toolSupport))
      .catch(() => setToolSupport(null));
  }, []);

  const openAdd = () => setForm({ ...EMPTY_FORM });
  const openEdit = (s) => setForm({
    id: s.id, name: s.name, url: s.url,
    headers: headersToLines(s.headers), enabled: s.enabled,
  });
  const closeForm = () => setForm(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const entry = {
      name: form.name.trim(),
      url: form.url.trim(),
      headers: linesToHeaders(form.headers),
      enabled: form.enabled,
    };
    setError(null);
    try {
      if (form.id) await updateMcpServer(form.id, entry);
      else await addMcpServer(entry);
      closeForm();
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm(t('mcp.confirmDelete'))) return;
    try {
      await removeMcpServer(id);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleToggle = async (s) => {
    try {
      await updateMcpServer(s.id, { enabled: !s.enabled });
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleReconnect = async (id) => {
    try {
      await reconnectMcpServer(id);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const toggleTools = async (id) => {
    if (expandedTools[id]) {
      setExpandedTools((m) => ({ ...m, [id]: null }));
      return;
    }
    try {
      const tools = await listMcpTools(id);
      setExpandedTools((m) => ({ ...m, [id]: tools }));
    } catch { /* Server nicht verbunden */ }
  };

  const statusClass = (status) =>
    status === 'connected' ? 'mcp__status--ok'
      : status === 'error' ? 'mcp__status--error'
        : status === 'disabled' ? 'mcp__status--disabled'
          : 'mcp__status--off';

  return (
    <div className="mcp">
      <div className="mcp__header">
        <h3>{t('mcp.title')}</h3>
        <button type="button" className="btn btn--primary" onClick={openAdd}>
          <Plus size={16} /><span>{t('mcp.add')}</span>
        </button>
      </div>

      {error && <p className="mcp__error">{error}</p>}
      {loading && <p className="mcp__loading">{t('mcp.loading')}</p>}

      {!loading && servers.length === 0 && (
        <p className="mcp__empty">{t('mcp.empty')}</p>
      )}

      {!loading && servers.length > 0 && toolSupport === false && (
        <p className="mcp__warning">{t('mcp.noToolSupport')}</p>
      )}

      <ul className="mcp__list">
        {servers.map((s) => (
          <li key={s.id} className="mcp__item">
            <div className="mcp__item-head">
              <span className={`mcp__status ${statusClass(s.status)}`}>
                {t(`mcp.status.${s.status}`)}
              </span>
              <strong>{s.name}</strong>
              <code className="mcp__cmd">{s.url}</code>
              <span className="mcp__tools-count">{s.toolCount} {t('mcp.tools')}</span>
            </div>
            {s.error && <p className="mcp__item-error">{s.error}</p>}

            {expandedTools[s.id] && (
              <ul className="mcp__tools">
                {expandedTools[s.id].map((tool) => (
                  <li key={tool.name}>
                    <code>{tool.name}</code>
                    {tool.description && <span> — {tool.description}</span>}
                  </li>
                ))}
              </ul>
            )}

            <div className="mcp__item-actions">
              <button type="button" className="btn btn--secondary" onClick={() => toggleTools(s.id)}>
                <span>{t('mcp.showTools')}</span>
              </button>
              <button type="button" className="btn btn--secondary" onClick={() => handleToggle(s)}>
                <Power size={16} /><span>{s.enabled ? t('mcp.disable') : t('mcp.enable')}</span>
              </button>
              <button type="button" className="btn btn--secondary" onClick={() => handleReconnect(s.id)}>
                <RefreshCw size={16} /><span>{t('mcp.reconnect')}</span>
              </button>
              <button type="button" className="btn btn--secondary" onClick={() => openEdit(s)}>
                <Pencil size={16} /><span>{t('mcp.edit')}</span>
              </button>
              <button type="button" className="btn btn--stop" onClick={() => handleDelete(s.id)}>
                <Trash2 size={16} /><span>{t('mcp.delete')}</span>
              </button>
            </div>
          </li>
        ))}
      </ul>

      {form && (
        <form className="mcp__form" onSubmit={handleSubmit}>
          <h4>{form.id ? t('mcp.editTitle') : t('mcp.addTitle')}</h4>
          <label className="settings__field">
            <span>{t('mcp.fields.name')}</span>
            <input
              type="text"
              value={form.name}
              required
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </label>
          <label className="settings__field">
            <span>{t('mcp.fields.url')}</span>
            <input
              type="url"
              value={form.url}
              required
              placeholder="http://localhost:8080/mcp"
              onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
            />
          </label>
          <label className="settings__field settings__field--full">
            <span>{t('mcp.fields.headers')}</span>
            <textarea
              className="settings__textarea"
              rows={3}
              value={form.headers}
              placeholder={'Authorization=Bearer ...\nX-Custom=value'}
              onChange={(e) => setForm((f) => ({ ...f, headers: e.target.value }))}
            />
          </label>
          <label className="settings__field settings__field--check">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            />
            <span>{t('mcp.fields.enabled')}</span>
          </label>
          <div className="mcp__form-actions">
            <button type="button" className="btn btn--secondary" onClick={closeForm}>
              <span>{t('settings.reset')}</span>
            </button>
            <button type="submit" className="btn btn--primary">
              <span>{form.id ? t('mcp.save') : t('mcp.add')}</span>
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/** headers-Objekt → Zeilen (KEY=VALUE). */
function headersToLines(headers) {
  if (!headers || typeof headers !== 'object') return '';
  return Object.entries(headers).map(([k, v]) => `${k}=${v}`).join('\n');
}

/** Zeilen (KEY=VALUE) → headers-Objekt. */
function linesToHeaders(lines) {
  const out = {};
  for (const line of String(lines).split('\n')) {
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}
