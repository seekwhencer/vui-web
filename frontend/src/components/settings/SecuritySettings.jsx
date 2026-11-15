import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getSettings, updateSettings } from '../../api/settings.js';
import EnvLockBadge from './EnvLockBadge.jsx';

/**
 * Security-Felder (alle `security.*`), Reihenfolge = Anzeigereihenfolge.
 * type: 'number' | 'textarea'.
 */
export const SECURITY_FIELDS = [
  { key: 'maxToolTurns', type: 'number', label: 'settings.fields.maxToolTurns', min: 1, step: 1 },
  { key: 'maxToolCallsPerTool', type: 'number', label: 'settings.fields.maxToolCallsPerTool', min: 1, step: 1 },
  { key: 'maxToolResultBytes', type: 'number', label: 'settings.fields.maxToolResultBytes', min: 1, step: 1 },
  { key: 'maxToolImageBytes', type: 'number', label: 'settings.fields.maxToolImageBytes', min: 1, step: 1 },
  { key: 'toolTimeoutMs', type: 'number', label: 'settings.fields.toolTimeoutMs', min: 1, step: 1 },
  { key: 'maxPendingActions', type: 'number', label: 'settings.fields.maxPendingActions', min: 1, step: 1 },
  { key: 'approvalTtlMs', type: 'number', label: 'settings.fields.approvalTtlMs', min: 1, step: 1 },
  { key: 'systemPrompt', type: 'textarea', label: 'settings.fields.securitySystemPrompt' },
];

/**
 * Baut den Settings-Patch für ein einzelnes Security-Feld.
 * Der Server shallow-mergt auf `security` → nur das geänderte Feld senden.
 * @param {string} field
 * @param {unknown} value
 * @returns {{ security: Record<string, unknown> }}
 */
export function buildSecurityPatch(field, value) {
  return { security: { [field]: value } };
}

/**
 * Extrahiert die `security.*`-Werte aus einer Settings-Antwort.
 * @param {Record<string, unknown> | null | undefined} data
 * @returns {Record<string, unknown>}
 */
export function extractSecurity(data) {
  return { ...((data && data.security) || {}) };
}

/**
 * Speichert ein einzelnes Security-Feld (optimistisch + sofortiger Save).
 * @param {string} field
 * @param {unknown} value
 * @param {(patch: object) => Promise<unknown>} [save]
 * @returns {Promise<unknown>}
 */
export async function saveSecurityField(field, value, save = updateSettings) {
  return save(buildSecurityPatch(field, value));
}

/**
 * Security-Tab in der Settings-Seite.
 *
 * Zeigt die `security.*`-Parameter (Tool-Runden, Größenlimits, Timeouts,
 * Approval-TTL, Security-System-Prompt). Änderungen wirken sofort:
 * optimistischer Update + PUT /api/settings (nur das geänderte Feld).
 *
 * Props (optional, für Tests — überspringen das Fetchen):
 * - security → { maxToolTurns, maxToolResultBytes, ... }
 */
export default function SecuritySettings({ security: securityProp } = {}) {
  const { t } = useTranslation();
  // `security`-Prop ist das security-Objekt selbst (Test); sonst aus der
  // vollen Settings-Antwort extrahieren (extractSecurity).
  const initial = securityProp !== undefined ? { ...securityProp } : {};
  const [values, setValues] = useState(initial);
  const [committed, setCommitted] = useState(initial);
  const [envLocked, setEnvLocked] = useState({});
  const [loading, setLoading] = useState(securityProp === undefined);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getSettings();
      const sec = extractSecurity(data);
      setValues(sec);
      setCommitted(sec);
      setEnvLocked(data.envLocked || {});
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (securityProp !== undefined) return undefined;
    load();
    return undefined;
  }, [load, securityProp]);

  /**
   * Feld commit (on blur / Enter) → optimistischer Update + sofortiger Save.
   * Der Server shallow-mergt auf `security` → nur das geänderte Feld senden.
   * Bei Fehler: Draft auf den letzten gespeicherten Wert zurücksetzen.
   */
  const commit = async (field) => {
    const value = values[field];
    const prev = committed[field];
    if (JSON.stringify(value) === JSON.stringify(prev)) return; // keine Änderung
    setSaved(false);
    setError(null);
    try {
      await saveSecurityField(field, value);
      setCommitted((c) => ({ ...c, [field]: value }));
      setSaved(true);
    } catch (err) {
      setValues((v) => ({ ...v, [field]: prev })); // Rollback
      setError(err.message);
    }
  };

  if (loading) {
    return <p className="settings__loading">{t('settings.loading')}</p>;
  }

  return (
    <div className="settings__panel">
      <div className="settings__panel-header">
        <div className="settings__panel-header-title">
          <h3>{t('settings.sections.security')}</h3>
          {saved && !error && (
            <p className="settings__saved" role="status">{t('settings.saved')}</p>
          )}
        </div>
      </div>

      <p className="settings__hint">{t('settings.securityHint')}</p>

      {error && <p className="settings__error" role="alert">{error}</p>}

      <div className="settings__grid">
        {SECURITY_FIELDS.map((field) => {
          const raw = values[field.key];
          const locked = envLocked?.security?.[field.key];
          const isLocked = typeof locked === 'string' && locked !== '';
          const lockBadge = isLocked ? <EnvLockBadge envName={locked} /> : null;
          const baseClass = isLocked ? 'settings__field settings__field--locked' : 'settings__field';
          if (field.type === 'textarea') {
            return (
              <label className={`${baseClass} settings__field--full`} key={field.key}>
                <span>{t(field.label)} {lockBadge}</span>
                <textarea
                  className="settings__textarea"
                  rows={4}
                  value={typeof raw === 'string' ? raw : ''}
                  disabled={isLocked}
                  onChange={(e) => {
                    setSaved(false);
                    setValues((v) => ({ ...v, [field.key]: e.target.value }));
                  }}
                  onBlur={() => commit(field.key)}
                />
              </label>
            );
          }
          return (
            <label className={baseClass} key={field.key}>
              <span>{t(field.label)} {lockBadge}</span>
              <input
                type="number"
                min={field.min}
                step={field.step}
                value={typeof raw === 'number' ? raw : ''}
                disabled={isLocked}
                onChange={(e) => {
                  setSaved(false);
                  const n = e.target.value === '' ? '' : Number(e.target.value);
                  setValues((v) => ({ ...v, [field.key]: n }));
                }}
                onBlur={() => {
                  if (typeof values[field.key] === 'number') commit(field.key);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && typeof values[field.key] === 'number') commit(field.key);
                }}
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}
