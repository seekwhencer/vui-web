import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil, Trash2, RefreshCw, Power } from 'lucide-react';
import {
  listMcpServers, addMcpServer, updateMcpServer,
  removeMcpServer, reconnectMcpServer, listMcpTools, getMcpCapability,
} from '../api/mcp.js';
import { getSettings, updateSettings } from '../api/settings.js';

const EMPTY_FORM = { name: '', url: '', headers: '', enabled: true };

/** Erlaubte Policy-Werte (serverseitig validiert). */
export const POLICY_OPTIONS = ['read', 'write', 'execute', 'deny'];

/**
 * Namespaced Policy-Key, identisch zum Server (McpManager-Namespace):
 * `${serverId}__${toolName}` (doppelter Unterstrich).
 * @param {string} serverId
 * @param {string} toolName
 * @returns {string}
 */
export function policyKey(serverId, toolName) {
  return `${serverId}__${toolName}`;
}

/**
 * Zerlegt eine Komma-Liste in Hostnamen (trim, leere Einträge filtern).
 * @param {string} input
 * @returns {string[]}
 */
export function parseHosts(input) {
  return String(input || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
}

/**
 * MCP-Tab in der Settings-Seite.
 *
 * CRUD-UI (Add / Edit / Delete, Enable/Disable, Reconnect) + Tool-Policies
 * (deny-by-default) pro Tool + SSRF-Allowlist. Änderungen wirken sofort:
 * Server-CRUD über die dedizierten /api/mcp/*-Endpunkte, Policies +
 * SSRF-Allowlist über PUT /api/settings (security.toolPolicies /
 * security.allowedHosts).
 *
 * Props (optional, für Tests — überspringen das Fetchen):
 * - servers      → [{ id, name, ... }]
 * - tools        → { [serverId]: [{ name, description? }] }
 * - policies     → { [serverId__toolName]: 'read'|'write'|'execute'|'deny' }
 * - allowedHosts → string[] (SSRF-Whitelist)
 */
export default function McpSettings({
  servers: serversProp,
  tools: toolsProp,
  policies: policiesProp,
  allowedHosts: hostsProp,
} = {}) {
  const { t } = useTranslation();
  const [servers, setServers] = useState(serversProp ?? []);
  const [loading, setLoading] = useState(serversProp === undefined);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null); // null = geschlossen, sonst { id?, ...EMPTY_FORM }
  const [expandedTools, setExpandedTools] = useState(() => {
    // Test-Props: alle Server vor-expandiert (Tools sofort sichtbar).
    if (toolsProp && serversProp) {
      const m = {};
      for (const s of serversProp) m[s.id] = toolsProp[s.id] || [];
      return m;
    }
    return {};
  });
  const [toolSupport, setToolSupport] = useState(null); // null = unbekannt, true/false = erkannt

  // Security-State: Tool-Policies (deny-by-default) + SSRF-Allowlist.
  const [policies, setPolicies] = useState(() => ({ ...(policiesProp || {}) }));
  const [hostsDraft, setHostsDraft] = useState(
    () => (Array.isArray(hostsProp) ? hostsProp.join(', ') : '')
  );
  const [hostsCommitted, setHostsCommitted] = useState(
    () => (Array.isArray(hostsProp) ? [...hostsProp] : null)
  );
  const [secLoading, setSecLoading] = useState(policiesProp === undefined);
  const [secError, setSecError] = useState(null);
  const [secSaved, setSecSaved] = useState(false);

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

  useEffect(() => {
    if (serversProp !== undefined) return undefined;
    load();
    return undefined;
  }, [load, serversProp]);

  // Tool-Support des LLM-Backends (für Hinweis).
  useEffect(() => {
    getMcpCapability()
      .then((cap) => setToolSupport(cap.toolSupport))
      .catch(() => setToolSupport(null));
  }, []);

  // Security-Settings laden (Policies + SSRF-Allowlist), nur ohne Test-Props.
  useEffect(() => {
    if (policiesProp !== undefined) return undefined;
    let cancelled = false;
    getSettings()
      .then((data) => {
        if (cancelled) return;
        setPolicies({ ...(data?.security?.toolPolicies || {}) });
        const hosts = data?.security?.allowedHosts;
        if (Array.isArray(hosts)) {
          setHostsDraft(hosts.join(', '));
          setHostsCommitted([...hosts]);
        }
      })
      .catch((err) => {
        if (!cancelled) setSecError(err.message);
      })
      .finally(() => {
        if (!cancelled) setSecLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [policiesProp]);

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

  // --- Security: sofort anwenden (PUT /api/settings) ---

  /**
   * Policy-Dropdown-Wechsel → optimistischer Update + sofortiger Save.
   * Der Server ersetzt `security.toolPolicies` vollständig → komplette Map senden.
   */
  const handlePolicyChange = async (serverId, toolName, value) => {
    const key = policyKey(serverId, toolName);
    const prev = policies;
    const next = { ...policies, [key]: value };
    setPolicies(next);
    setSecSaved(false);
    setSecError(null);
    try {
      await updateSettings({ security: { toolPolicies: next } });
      setSecSaved(true);
    } catch (err) {
      setPolicies(prev); // Rollback: Änderung hat nicht gewirkt
      setSecError(err.message);
    }
  };

  /** SSRF-Allowlist commit (on blur / Enter). Nur bei tatsächlicher Änderung. */
  const commitHosts = async (value) => {
    const next = parseHosts(value);
    if (hostsCommitted && JSON.stringify(next) === JSON.stringify(hostsCommitted)) return;
    const prevDraft = hostsDraft;
    const prevCommitted = hostsCommitted;
    setSecSaved(false);
    setSecError(null);
    try {
      await updateSettings({ security: { allowedHosts: next } });
      setHostsCommitted(next);
      setSecSaved(true);
    } catch (err) {
      setHostsDraft(prevDraft); // Rollback
      setHostsCommitted(prevCommitted);
      setSecError(err.message);
    }
  };

  const statusClass = (status) =>
    status === 'connected' ? 'mcp__status--ok'
      : status === 'error' ? 'mcp__status--error'
        : status === 'disabled' ? 'mcp__status--disabled'
          : 'mcp__status--off';

  return (
    <div className="mcp">
      <div className="mcp__header">
        <div className="mcp__header-title">
          <h3>{t('mcp.title')}</h3>
          {secSaved && !secError && (
            <p className="mcp__saved" role="status">{t('mcp.policy.saved')}</p>
          )}
        </div>
        <button type="button" className="btn btn--primary" onClick={openAdd}>
          <Plus size={16} /><span>{t('mcp.add')}</span>
        </button>
      </div>

      <p className="mcp__policy-hint">{t('mcp.policy.hint')}</p>

      {error && <p className="mcp__error">{error}</p>}
      {secError && <p className="mcp__error" role="alert">{secError}</p>}
      {loading && <p className="mcp__loading">{t('mcp.loading')}</p>}
      {secLoading && <p className="mcp__loading">{t('mcp.policy.loading')}</p>}

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
                {expandedTools[s.id].map((tool) => {
                  const key = policyKey(s.id, tool.name);
                  const value = policies[key] ?? 'deny';
                  const isDefault = policies[key] === undefined;
                  return (
                    <li key={tool.name} className="mcp__tool">
                      <div className="mcp__tool-head">
                        <code>{tool.name}</code>
                        <label className="mcp__policy">
                          <span>{t('mcp.policy.label')}</span>
                          <select
                            value={value}
                            onChange={(e) => handlePolicyChange(s.id, tool.name, e.target.value)}
                          >
                            {POLICY_OPTIONS.map((opt) => (
                              <option key={opt} value={opt}>
                                {t(`mcp.policy.options.${opt}`)}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      {tool.description && (
                        <span className="mcp__tool-desc">{tool.description}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="mcp__item-actions">
              <button type="button" className="btn btn--xs btn--secondary" onClick={() => toggleTools(s.id)}>
                <span>{t('mcp.showTools')}</span>
              </button>
              <button type="button" className="btn btn--xs btn--secondary" onClick={() => handleToggle(s)}>
                <Power size={16} /><span>{s.enabled ? t('mcp.disable') : t('mcp.enable')}</span>
              </button>
              <button type="button" className="btn btn--xs btn--secondary" onClick={() => handleReconnect(s.id)}>
                <RefreshCw size={16} /><span>{t('mcp.reconnect')}</span>
              </button>
              <button type="button" className="btn btn--xs btn--secondary" onClick={() => openEdit(s)}>
                <Pencil size={16} /><span>{t('mcp.edit')}</span>
              </button>
              <button type="button" className="btn btn--sm btn--stop" onClick={() => handleDelete(s.id)}>
                <Trash2 size={16} /><span>{t('mcp.delete')}</span>
              </button>
            </div>
          </li>
        ))}
      </ul>

      <section className="mcp__ssrf">
        <h4>{t('mcp.ssrf.title')}</h4>
        <p className="mcp__ssrf-hint">{t('mcp.ssrf.hint')}</p>
        <label className="settings__field">
          <span>{t('mcp.ssrf.label')}</span>
          <input
            type="text"
            value={hostsDraft}
            placeholder="sync.gitea.home, chrome.mcp.ai.home"
            onChange={(e) => {
              setSecSaved(false);
              setHostsDraft(e.target.value);
            }}
            onBlur={(e) => commitHosts(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitHosts(e.target.value);
            }}
          />
        </label>
      </section>

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
