import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getSettings, updateSettings } from '../../api/settings.js';

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
 * Extrahiert die `media.*`-Werte aus einer Settings-Antwort.
 * @param {Record<string, unknown> | null | undefined} data
 * @returns {Record<string, unknown>}
 */
export function extractMedia(data) {
  return { ...((data && data.media) || {}) };
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
 * App-Tab in der Settings-Seite.
 *
 * Zeigt die `media.*`-Parameter (Pfad, Bild-TTL, Caps, Cleanup-Intervall).
 * Änderungen wirken sofort: optimistischer Update + PUT /api/settings
 * (nur das geänderte Feld). `media.dir` ist ein restartKey (Pfadänderung
 * erfordert Neustart), die anderen `media.*` sind runtimeKeys.
 *
 * Props (optional, für Tests — überspringen das Fetchen):
 * - media → { dir, imageTtlDays, maxImages, maxBytes, cleanupIntervalMs }
 */
export default function AppSettings({ media: mediaProp } = {}) {
  const { t } = useTranslation();
  // `media`-Prop ist das media-Objekt selbst (Test); sonst aus der
  // vollen Settings-Antwort extrahieren (extractMedia).
  const initial = mediaProp !== undefined ? { ...mediaProp } : {};
  const [values, setValues] = useState(initial);
  const [committed, setCommitted] = useState(initial);
  const [loading, setLoading] = useState(mediaProp === undefined);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const m = extractMedia(await getSettings());
      setValues(m);
      setCommitted(m);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mediaProp !== undefined) return undefined;
    load();
    return undefined;
  }, [load, mediaProp]);

  /**
   * Feld commit (on blur / Enter) → optimistischer Update + sofortiger Save.
   * Der Server shallow-mergt auf `media` → nur das geänderte Feld senden.
   * Bei Fehler: Draft auf den letzten gespeicherten Wert zurücksetzen.
   */
  const commit = async (field) => {
    const value = values[field];
    const prev = committed[field];
    if (JSON.stringify(value) === JSON.stringify(prev)) return; // keine Änderung
    setSaved(false);
    setError(null);
    try {
      await saveMediaField(field, value);
      setCommitted((c) => ({ ...c, [field]: value }));
      setSaved(true);
    } catch (err) {
      setValues((v) => ({ ...v, [field]: prev })); // Rollback
      setError(err.message);
    }
  };

  return (
    <>
      <div className="settings__body">
        <div className="settings__panel">
          <div className="settings__panel-header">
            <div className="settings__panel-header-title">
              <h3>{t('settings.app.media.title')}</h3>
            </div>
          </div>

          {loading && <p className="settings__loading">{t('settings.loading')}</p>}
          {error && <p className="settings__error" role="alert">{error}</p>}

          {!loading && (
            <div className="settings__grid">
              {MEDIA_FIELDS.map((field) => {
                const raw = values[field.key];
                if (field.type === 'text') {
                  return (
                    <label className="settings__field settings__field--full" key={field.key}>
                      <span>{t(field.label)}</span>
                      <input
                        type="text"
                        value={typeof raw === 'string' ? raw : ''}
                        onChange={(e) => {
                          setSaved(false);
                          setValues((v) => ({ ...v, [field.key]: e.target.value }));
                        }}
                        onBlur={() => commit(field.key)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commit(field.key);
                        }}
                      />
                      <span className="settings__hint">{t(field.hint)}</span>
                    </label>
                  );
                }
                return (
                  <label className="settings__field" key={field.key}>
                    <span>{t(field.label)}</span>
                    <input
                      type="number"
                      min={field.min}
                      step={field.step}
                      value={typeof raw === 'number' ? raw : ''}
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
                    <span className="settings__hint">{t(field.hint)}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
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
