import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getSettings, updateSettings } from '../../api/settings.js';
import EnvLockBadge from './EnvLockBadge.jsx';

/**
 * Server-Felder (Root-Level), Reihenfolge = Anzeigereihenfolge.
 * type: 'number' | 'checkbox'.
 * `serverPort` ist ein restartKey (Neustart nötig), `verbose` ein runtimeKey.
 */
export const SERVER_FIELDS = [
  { key: 'serverPort', type: 'number', label: 'settings.app.server.port', hint: 'settings.app.server.portHint', min: 1, max: 65535, step: 1 },
  { key: 'verbose', type: 'checkbox', label: 'settings.app.server.verbose', hint: 'settings.app.server.verboseHint' },
];

/**
 * Media-Felder (alle `media.*`), Reihenfolge = Anzeigereihenfolge.
 * type: 'text' | 'number'.
 */
export const MEDIA_FIELDS = [
  { key: 'dir', type: 'text', label: 'settings.app.media.dir', hint: 'settings.app.media.dirHint' },
  { key: 'imageTtlDays', type: 'number', label: 'settings.app.media.imageTtlDays', hint: 'settings.app.media.imageTtlDaysHint', min: 0, step: 1 },
  { key: 'maxImages', type: 'number', label: 'settings.app.media.maxImages', hint: 'settings.app.media.maxImagesHint', min: 0, step: 1 },
  { key: 'maxBytes', type: 'number', label: 'settings.app.media.maxBytes', hint: 'settings.app.media.maxBytesHint', min: 0, step: 1 },
  { key: 'cleanupIntervalMs', type: 'number', label: 'settings.app.media.cleanupIntervalMs', hint: 'settings.app.media.cleanupIntervalMsHint', min: 60000, step: 60000 },
];

/**
 * Baut den Settings-Patch für ein einzelnes Media-Feld.
 * Der Server shallow-mergt auf `media` → nur das geänderte Feld senden.
 * @param {string} field
 * @param {unknown} value
 * @returns {{ media: Record<string, unknown> }}
 */
export function buildMediaPatch(field, value) {
  return { media: { [field]: value } };
}

/**
 * Baut den Settings-Patch für ein einzelnes Root-Feld (serverPort, verbose).
 * @param {string} field
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function buildRootPatch(field, value) {
  return { [field]: value };
}

/**
 * Extrahiert die `media.*`-Werte aus einer Settings-Antwort.
 * @param {Record<string, unknown> | null | undefined} data
 * @returns {Record<string, unknown>}
 */
export function extractMedia(data) {
  return { ...((data && data.media) || {}) };
}

/**
 * Extrahiert die Root-Werte (serverPort, verbose) aus einer Settings-Antwort.
 * @param {Record<string, unknown> | null | undefined} data
 * @returns {{ serverPort: unknown, verbose: unknown }}
 */
export function extractRoot(data) {
  const d = data || {};
  return { serverPort: d.serverPort, verbose: d.verbose };
}

/**
 * Speichert ein einzelnes Media-Feld (optimistisch + sofortiger Save).
 * @param {string} field
 * @param {unknown} value
 * @param {(patch: object) => Promise<unknown>} [save]
 * @returns {Promise<unknown>}
 */
export async function saveMediaField(field, value, save = updateSettings) {
  return save(buildMediaPatch(field, value));
}

/**
 * Speichert ein einzelnes Root-Feld (optimistisch + sofortiger Save).
 * @param {string} field
 * @param {unknown} value
 * @param {(patch: object) => Promise<unknown>} [save]
 * @returns {Promise<unknown>}
 */
export async function saveRootField(field, value, save = updateSettings) {
  return save(buildRootPatch(field, value));
}

/**
 * App-Tab in der Settings-Seite.
 *
 * Zwei Sub-Views (über `view`, gesteuert durch die Sub-Navigation):
 * - 'server' → Server (Root): `serverPort` (restartKey), `verbose` (runtimeKey).
 * - 'media'  → Media: `media.*` (Pfad, Bild-TTL, Caps, Cleanup-Intervall).
 *
 * Änderungen wirken sofort: optimistischer Update + PUT /api/settings
 * (nur das geänderte Feld). `serverPort` und `media.dir` sind restartKeys
 * (Pfad-/Port-Änderung erfordert Neustart), die anderen sind runtimeKeys.
 *
 * Props (optional, für Tests — überspringen das Fetchen):
 * - view   → 'server' | 'media' (Default: 'server')
 * - media  → { dir, imageTtlDays, maxImages, maxBytes, cleanupIntervalMs }
 * - server → { serverPort, verbose }
 */
export default function AppSettings({ view = 'server', media: mediaProp, server: serverProp } = {}) {
  const { t } = useTranslation();
  const mediaInitial = mediaProp !== undefined ? { ...mediaProp } : {};
  const serverInitial = serverProp !== undefined ? { ...serverProp } : {};
  const [mediaValues, setMediaValues] = useState(mediaInitial);
  const [mediaCommitted, setMediaCommitted] = useState(mediaInitial);
  const [serverValues, setServerValues] = useState(serverInitial);
  const [serverCommitted, setServerCommitted] = useState(serverInitial);
  const [envLocked, setEnvLocked] = useState({});
  const [loading, setLoading] = useState(mediaProp === undefined && serverProp === undefined);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getSettings();
      const m = extractMedia(data);
      const s = extractRoot(data);
      setMediaValues(m);
      setMediaCommitted(m);
      setServerValues(s);
      setServerCommitted(s);
      setEnvLocked(data.envLocked || {});
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mediaProp !== undefined || serverProp !== undefined) return undefined;
    load();
    return undefined;
  }, [load, mediaProp, serverProp]);

  /**
   * Media-Feld commit (on blur / Enter) → optimistischer Update + sofortiger Save.
   * Bei Fehler: Draft auf den letzten gespeicherten Wert zurücksetzen.
   */
  const commitMedia = async (field) => {
    const value = mediaValues[field];
    const prev = mediaCommitted[field];
    if (JSON.stringify(value) === JSON.stringify(prev)) return; // keine Änderung
    setSaved(false);
    setError(null);
    try {
      await saveMediaField(field, value);
      setMediaCommitted((c) => ({ ...c, [field]: value }));
      setSaved(true);
    } catch (err) {
      setMediaValues((v) => ({ ...v, [field]: prev })); // Rollback
      setError(err.message);
    }
  };

  /**
   * Server-Feld commit (on blur / Enter / Change) → optimistischer Update + Save.
   * `valueOverride` für Checkboxen (State-Update ist asynchron).
   * Bei Fehler: Draft auf den letzten gespeicherten Wert zurücksetzen.
   */
  const commitServer = async (field, valueOverride) => {
    const value = valueOverride !== undefined ? valueOverride : serverValues[field];
    const prev = serverCommitted[field];
    if (JSON.stringify(value) === JSON.stringify(prev)) return; // keine Änderung
    setSaved(false);
    setError(null);
    try {
      await saveRootField(field, value);
      setServerCommitted((c) => ({ ...c, [field]: value }));
      setSaved(true);
    } catch (err) {
      setServerValues((v) => ({ ...v, [field]: prev })); // Rollback
      setError(err.message);
    }
  };

  /**
   * Rendert ein einzelnes Feld (text/number/checkbox) aus einer Feldgruppe.
   * @param {object} field
   * @param {Record<string, unknown>} values
   * @param {(updater: Function) => void} setValues
   * @param {(field: string, value?: unknown) => Promise<void>} commit
   * @param {string} [locked] - Env-Name, wenn das Feld per Env gesetzt ist
   */
  const renderField = (field, values, setValues, commit, locked) => {
    const raw = values[field.key];
    const isLocked = typeof locked === 'string' && locked !== '';
    const lockBadge = isLocked ? <EnvLockBadge envName={locked} /> : null;
    const baseClass = isLocked ? 'settings__field settings__field--locked' : 'settings__field';
    if (field.type === 'checkbox') {
      return (
        <label className={`${baseClass} settings__field--check`} key={field.key}>
          <input
            type="checkbox"
            checked={Boolean(raw)}
            disabled={isLocked}
            onChange={(e) => {
              const v = e.target.checked;
              setValues((prev) => ({ ...prev, [field.key]: v }));
              commit(field.key, v);
            }}
          />
          <span>{t(field.label)}</span>
          {lockBadge}
          {field.hint && <span className="settings__hint">{t(field.hint)}</span>}
        </label>
      );
    }
    if (field.type === 'number') {
      return (
        <label className={baseClass} key={field.key}>
          <span>{t(field.label)} {lockBadge}</span>
          <input
            type="number"
            min={field.min}
            max={field.max}
            step={field.step}
            value={typeof raw === 'number' ? raw : ''}
            disabled={isLocked}
            onChange={(e) => {
              setSaved(false);
              setValues((v) => ({ ...v, [field.key]: e.target.value === '' ? '' : Number(e.target.value) }));
            }}
            onBlur={() => {
              if (typeof values[field.key] === 'number') commit(field.key);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && typeof values[field.key] === 'number') commit(field.key);
            }}
          />
          {field.hint && <span className="settings__hint">{t(field.hint)}</span>}
        </label>
      );
    }
    // text
    return (
      <label className={`${baseClass} settings__field--full`} key={field.key}>
        <span>{t(field.label)} {lockBadge}</span>
        <input
          type="text"
          value={typeof raw === 'string' ? raw : ''}
          disabled={isLocked}
          onChange={(e) => {
            setSaved(false);
            setValues((v) => ({ ...v, [field.key]: e.target.value }));
          }}
          onBlur={() => commit(field.key)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(field.key);
          }}
        />
        {field.hint && <span className="settings__hint">{t(field.hint)}</span>}
      </label>
    );
  };

  return (
    <>
      <div className="settings__body">
        {loading && <p className="settings__loading">{t('settings.loading')}</p>}
        {error && <p className="settings__error" role="alert">{error}</p>}

        {!loading && view === 'server' && (
          /* Server-Panel (Root) */
          <div className="settings__panel">
            <div className="settings__panel-header">
              <div className="settings__panel-header-title">
                <h3>{t('settings.app.server.title')}</h3>
              </div>
            </div>
            <div className="settings__grid">
              {SERVER_FIELDS.map((field) => renderField(field, serverValues, setServerValues, commitServer, envLocked?.root?.[field.key]))}
            </div>
          </div>
        )}

        {!loading && view === 'media' && (
          /* Media-Panel */
          <div className="settings__panel">
            <div className="settings__panel-header">
              <div className="settings__panel-header-title">
                <h3>{t('settings.app.media.title')}</h3>
              </div>
            </div>
            <div className="settings__grid">
              {MEDIA_FIELDS.map((field) => renderField(field, mediaValues, setMediaValues, commitMedia, envLocked?.media?.[field.key]))}
            </div>
          </div>
        )}
      </div>

      <div className="settings__footer">
        <span className="settings__saved">{t('settings.securityHint')}</span>
        {saved && !error && (
          <span className="settings__saved" role="status">{t('settings.saved')}</span>
        )}
      </div>
    </>
  );
}
