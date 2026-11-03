import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Save, RotateCcw, X } from 'lucide-react';

/**
 * Feld-Definitionen, gruppiert in Sektionen.
 * type: 'text' | 'number' | 'checkbox' | 'temperature'
 */
const SECTIONS = [
  {
    id: 'basic',
    title: 'settings.sections.basic',
    fields: [
      { key: 'language', type: 'text', label: 'settings.fields.language', placeholder: 'de' },
      { key: 'temperature', type: 'temperature', label: 'settings.fields.temperature' },
      { key: 'prompt', type: 'text', label: 'settings.fields.prompt' },
      { key: 'translate', type: 'checkbox', label: 'settings.fields.translate' },
    ],
  },
  {
    id: 'decoding',
    title: 'settings.sections.decoding',
    fields: [
      { key: 'beamSize', type: 'number', label: 'settings.fields.beamSize', min: 1, step: 1 },
      { key: 'bestOf', type: 'number', label: 'settings.fields.bestOf', min: 1, step: 1 },
      { key: 'patience', type: 'number', label: 'settings.fields.patience', step: 0.1 },
      { key: 'lengthPenalty', type: 'number', label: 'settings.fields.lengthPenalty', step: 0.1 },
      { key: 'repetitionPenalty', type: 'number', label: 'settings.fields.repetitionPenalty', step: 0.1 },
    ],
  },
  {
    id: 'thresholds',
    title: 'settings.sections.thresholds',
    fields: [
      { key: 'compressionRatioThreshold', type: 'number', label: 'settings.fields.compressionRatioThreshold', step: 0.1 },
      { key: 'logProbThreshold', type: 'number', label: 'settings.fields.logProbThreshold', step: 0.1 },
      { key: 'noSpeechThreshold', type: 'number', label: 'settings.fields.noSpeechThreshold', min: 0, max: 1, step: 0.05 },
      { key: 'conditionOnPreviousText', type: 'checkbox', label: 'settings.fields.conditionOnPreviousText' },
    ],
  },
  {
    id: 'context',
    title: 'settings.sections.context',
    fields: [
      { key: 'initialPrompt', type: 'text', label: 'settings.fields.initialPrompt' },
      { key: 'hotwords', type: 'text', label: 'settings.fields.hotwords' },
    ],
  },
  {
    id: 'vad',
    title: 'settings.sections.vad',
    fields: [{ key: 'vadFilter', type: 'checkbox', label: 'settings.fields.vadFilter' }],
    subFields: [
      { key: 'threshold', type: 'number', label: 'settings.fields.vadThreshold', min: 0, max: 1, step: 0.05 },
      { key: 'min_speech_duration_ms', type: 'number', label: 'settings.fields.vadMinSpeech', min: 0, step: 50 },
      { key: 'min_silence_duration_ms', type: 'number', label: 'settings.fields.vadMinSilence', min: 0, step: 100 },
      { key: 'window_size_samples', type: 'number', label: 'settings.fields.vadWindow', min: 0, step: 64 },
      { key: 'speech_pad_ms', type: 'number', label: 'settings.fields.vadPad', min: 0, step: 50 },
    ],
  },
];

/** temperature-Array ↔ Komma-String für das Textfeld. */
function tempToString(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.join(', ');
}
function stringToTemp(str) {
  return String(str)
    .split(',')
    .map((s) => parseFloat(s.trim()))
    .filter((n) => Number.isFinite(n));
}

export default function SettingsPanel({ settings, saving, error, onSave, onClose }) {
  const { t } = useTranslation();

  const [draft, setDraft] = useState(null); // { whisper: {...}, badwords: string }
  const [saved, setSaved] = useState(false);
  // true → die nächste Settings-Änderung stammt von unserem eigenen Save
  // (Draft NICHT zurücksetzen, sonst verschwindet der "Gespeichert"-Hinweis).
  const skipInitRef = useRef(false);

  // Draft aus den Server-Settings initialisieren (bei jedem Öffnen/Reload).
  useEffect(() => {
    if (!settings) return;
    if (skipInitRef.current) {
      skipInitRef.current = false;
      return;
    }
    setDraft({
      whisper: { ...settings.whisper },
      badwords: (settings.badwords || []).join('\n'),
    });
    setSaved(false);
  }, [settings]);

  const vadParams = useMemo(
    () => (draft?.whisper?.vadParameters && typeof draft.whisper.vadParameters === 'object'
      ? draft.whisper.vadParameters
      : {}),
    [draft]
  );

  if (!draft) return null;

  const setWhisper = (key, value) => {
    setSaved(false);
    setDraft((d) => ({ ...d, whisper: { ...d.whisper, [key]: value } }));
  };

  const setVadParam = (key, value) => {
    setSaved(false);
    setDraft((d) => ({
      ...d,
      whisper: {
        ...d.whisper,
        vadParameters: { ...d.whisper.vadParameters, [key]: value },
      },
    }));
  };

  const setBadwords = (value) => {
    setSaved(false);
    setDraft((d) => ({ ...d, badwords: value }));
  };

  const handleSave = async () => {
    const patch = {
      whisper: { ...draft.whisper },
      badwords: draft.badwords
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    try {
      skipInitRef.current = true; // eigenes Save → Draft-Init überspringen
      await onSave(patch);
      setSaved(true);
    } catch {
      // Fehler wird über `error` angezeigt
    }
  };

  const renderField = (field) => {
    const value = draft.whisper[field.key];

    if (field.type === 'checkbox') {
      return (
        <label className="settings__field settings__field--check">
          <input
            type="checkbox"
            checked={Boolean(value)}
            onChange={(e) => setWhisper(field.key, e.target.checked)}
          />
          <span>{t(field.label)}</span>
        </label>
      );
    }

    if (field.type === 'temperature') {
      return (
        <label className="settings__field">
          <span>{t(field.label)}</span>
          <input
            type="text"
            value={tempToString(value)}
            placeholder="0.0, 0.5, 1.0"
            onChange={(e) => setWhisper(field.key, stringToTemp(e.target.value))}
          />
        </label>
      );
    }

    if (field.type === 'number') {
      return (
        <label className="settings__field">
          <span>{t(field.label)}</span>
          <input
            type="number"
            value={typeof value === 'number' ? value : ''}
            min={field.min}
            max={field.max}
            step={field.step}
            onChange={(e) => {
              const n = e.target.value === '' ? '' : Number(e.target.value);
              setWhisper(field.key, n);
            }}
          />
        </label>
      );
    }

    // text
    return (
      <label className="settings__field">
        <span>{t(field.label)}</span>
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder}
          onChange={(e) => setWhisper(field.key, e.target.value)}
        />
      </label>
    );
  };

  return (
    <div className="settings">
      <div className="settings__header">
        <h2>{t('settings.title')}</h2>
        <button type="button" className="settings__close" onClick={onClose} aria-label={t('settings.close')}>
          <X size={18} />
        </button>
      </div>

      <div className="settings__body">
        {SECTIONS.map((section) => (
          <fieldset key={section.id} className="settings__section">
            <legend>{t(section.title)}</legend>
            <div className="settings__grid">
              {section.fields.map((field) => (
                <div key={field.key}>{renderField(field)}</div>
              ))}
            </div>

            {/* VAD-Parameter nur sichtbar, wenn VAD aktiviert ist */}
            {section.subFields && draft.whisper.vadFilter && (
              <div className="settings__grid settings__grid--sub">
                {section.subFields.map((field) => (
                  <label key={field.key} className="settings__field">
                    <span>{t(field.label)}</span>
                    <input
                      type="number"
                      value={typeof vadParams[field.key] === 'number' ? vadParams[field.key] : ''}
                      min={field.min}
                      max={field.max}
                      step={field.step}
                      onChange={(e) => {
                        const n = e.target.value === '' ? '' : Number(e.target.value);
                        setVadParam(field.key, n);
                      }}
                    />
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        ))}

        <fieldset className="settings__section">
          <legend>{t('settings.sections.badwords')}</legend>
          <label className="settings__field settings__field--full">
            <span>{t('settings.fields.badwords')}</span>
            <textarea
              className="settings__textarea"
              rows={4}
              value={draft.badwords}
              placeholder={t('settings.fields.badwordsPlaceholder')}
              onChange={(e) => setBadwords(e.target.value)}
            />
          </label>
        </fieldset>
      </div>

      <div className="settings__footer">
        {error && <span className="settings__error">{error}</span>}
        {saved && !error && <span className="settings__saved">{t('settings.saved')}</span>}
        <div className="settings__actions">
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => {
              setSaved(false);
              setDraft({ whisper: { ...settings.whisper }, badwords: (settings.badwords || []).join('\n') });
            }}
          >
            <RotateCcw size={16} />
            <span>{t('settings.reset')}</span>
          </button>
          <button type="button" className="btn btn--primary" onClick={handleSave} disabled={saving}>
            <Save size={16} />
            <span>{saving ? t('settings.saving') : t('settings.save')}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
