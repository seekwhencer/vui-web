import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import SettingsField from './SettingsField.jsx';
import SaveFooter from './SaveFooter.jsx';

/**
 * ASR (Whisper) Feld-Definitionen, gruppiert in Sub-Views.
 * type: 'text' | 'number' | 'checkbox' | 'temperature' | 'textarea'
 * group: 'whisper' (Default) | 'root' → Draft-Gruppe, aus der gelesen/geschrieben wird.
 */
const SECTIONS = [
  {
    id: 'basic',
    fields: [
      { key: 'whisperHost', type: 'text', label: 'settings.fields.whisperHost', placeholder: 'vui-service', group: 'root' },
      { key: 'whisperPort', type: 'number', label: 'settings.fields.whisperPort', min: 1, max: 65535, step: 1, group: 'root' },
      { key: 'language', type: 'text', label: 'settings.fields.language', placeholder: 'de' },
      { key: 'temperature', type: 'temperature', label: 'settings.fields.temperature' },
      { key: 'prompt', type: 'textarea', label: 'settings.fields.prompt' },
      { key: 'translate', type: 'checkbox', label: 'settings.fields.translate' },
    ],
  },
  {
    id: 'decoding',
    fields: [
      { key: 'beamSize', type: 'number', label: 'settings.fields.beamSize', min: 0, step: 1 },
      { key: 'bestOf', type: 'number', label: 'settings.fields.bestOf', min: 1, step: 1 },
      { key: 'patience', type: 'number', label: 'settings.fields.patience', step: 0.1 },
      { key: 'lengthPenalty', type: 'number', label: 'settings.fields.lengthPenalty', step: 0.1 },
      { key: 'repetitionPenalty', type: 'number', label: 'settings.fields.repetitionPenalty', step: 0.1 },
    ],
  },
  {
    id: 'thresholds',
    fields: [
      { key: 'compressionRatioThreshold', type: 'number', label: 'settings.fields.compressionRatioThreshold', step: 0.1 },
      { key: 'logProbThreshold', type: 'number', label: 'settings.fields.logProbThreshold', step: 0.1 },
      { key: 'noSpeechThreshold', type: 'number', label: 'settings.fields.noSpeechThreshold', min: 0, max: 1, step: 0.05 },
      { key: 'conditionOnPreviousText', type: 'checkbox', label: 'settings.fields.conditionOnPreviousText' },
    ],
  },
  {
    id: 'context',
    fields: [
      { key: 'initialPrompt', type: 'textarea', label: 'settings.fields.initialPrompt' },
      { key: 'hotwords', type: 'text', label: 'settings.fields.hotwords', placeholder: 'settings.fields.hotwordsPlaceholder' },
    ],
  },
  {
    id: 'vad',
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

export default function AsrSettings({
  view = 'basic',
  draft,
  updateDraft,
  onSave,
  onReset,
  saving,
  error,
  saved,
  envLocked = {},
}) {
  const { t } = useTranslation();

  /** Liefert den Env-Namen für ein Feld (undefined = nicht gelockt). */
  const lockedFor = (field) => {
    const group = field.group || 'whisper';
    return envLocked?.[group]?.[field.key];
  };

  const vadParams = useMemo(
    () =>
      draft?.whisper?.vadParameters && typeof draft.whisper.vadParameters === 'object'
        ? draft.whisper.vadParameters
        : {},
    [draft]
  );

  if (!draft) return null;

  const fieldValue = (field) => {
    const group = field.group || 'whisper';
    return group === 'root' ? draft[field.key] : draft[group][field.key];
  };

  const setFieldValue = (field, v) => {
    const group = field.group || 'whisper';
    if (group === 'root') updateDraft((d) => ({ ...d, [field.key]: v }));
    else updateDraft((d) => ({ ...d, [group]: { ...d[group], [field.key]: v } }));
  };

  const setVadParam = (key, v) =>
    updateDraft((d) => ({
      ...d,
      whisper: {
        ...d.whisper,
        vadParameters: { ...d.whisper.vadParameters, [key]: v },
      },
    }));

  const footer = (
    <SaveFooter error={error} saved={saved} saving={saving} onReset={onReset} onSave={onSave} />
  );

  if (view === 'badwords') {
    return (
      <>
        <div className="settings__body">
          <div className="settings__panel">
            <div className="settings__panel-header">
              <div className="settings__panel-header-title">
                <h3>{t('settings.sections.badwords')}</h3>
              </div>
            </div>
            <SettingsField
              field={{ key: 'badwords', type: 'textarea', label: 'settings.fields.badwords', placeholder: 'settings.fields.badwordsPlaceholder' }}
              value={draft.badwords}
              onChange={(v) => updateDraft((d) => ({ ...d, badwords: v }))}
              locked={envLocked?.root?.badwords}
            />
          </div>
        </div>
        {footer}
      </>
    );
  }

  const section = SECTIONS.find((s) => s.id === view);
  if (!section) return null;

  return (
    <>
      <div className="settings__body">
        <div className="settings__panel">
          <div className="settings__panel-header">
            <div className="settings__panel-header-title">
              <h3>{t(`settings.sections.${view}`)}</h3>
            </div>
          </div>

          <div className="settings__grid">
            {section.fields.map((field) => (
              <SettingsField
                key={field.key}
                field={field}
                value={fieldValue(field)}
                onChange={(v) => setFieldValue(field, v)}
                locked={lockedFor(field)}
              />
            ))}
          </div>

          {section.subFields && draft.whisper.vadFilter && (
            <div className="settings__grid settings__grid--sub">
              {section.subFields.map((field) => (
                <SettingsField
                  key={field.key}
                  field={field}
                  value={vadParams[field.key]}
                  onChange={(v) => setVadParam(field.key, v)}
                  locked={envLocked?.whisper?.vadParameters}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {footer}
    </>
  );
}
