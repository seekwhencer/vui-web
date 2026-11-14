import { useTranslation } from 'react-i18next';
import SettingsField from './SettingsField.jsx';
import SaveFooter from './SaveFooter.jsx';
import SecuritySettings from './SecuritySettings.jsx';

const CONNECTION_FIELDS = [
  { key: 'host', type: 'text', label: 'settings.fields.llmHost', placeholder: 'vui-tts' },
  { key: 'port', type: 'number', label: 'settings.fields.llmPort', min: 1, max: 65535, step: 1 },
  { key: 'model', type: 'text', label: 'settings.fields.llmModel', placeholder: 'llama3.1' },
  { key: 'vision', type: 'select', label: 'settings.fields.llmVision', options: ['auto', 'true', 'false'] },
];

const PROMPT_FIELDS = [
  { key: 'systemPrompt', type: 'textarea', label: 'settings.fields.llmSystemPrompt' },
];

export default function LlmSettings({
  view = 'connection',
  draft,
  updateDraft,
  onSave,
  onReset,
  saving,
  error,
  saved,
}) {
  const { t } = useTranslation();

  if (view === 'security') {
    return (
      <>
        <div className="settings__body">
          <SecuritySettings />
        </div>
        <div className="settings__footer">
          <span className="settings__saved">{t('settings.securityHint')}</span>
        </div>
      </>
    );
  }

  if (!draft) return null;

  const fields = view === 'prompt' ? PROMPT_FIELDS : CONNECTION_FIELDS;

  const fieldValue = (field) => draft.llm[field.key];
  const setFieldValue = (field, v) =>
    updateDraft((d) => ({ ...d, llm: { ...d.llm, [field.key]: v } }));

  return (
    <>
      <div className="settings__body">
        <div className="settings__panel">
          <div className="settings__panel-header">
            <div className="settings__panel-header-title">
              <h3>{t(view === 'prompt' ? 'settings.sub.prompt' : 'settings.sub.connection')}</h3>
            </div>
          </div>

          <div className="settings__grid">
            {fields.map((field) => (
              <SettingsField
                key={field.key}
                field={field}
                value={fieldValue(field)}
                onChange={(v) => setFieldValue(field, v)}
              />
            ))}
          </div>
        </div>
      </div>
      <SaveFooter error={error} saved={saved} saving={saving} onReset={onReset} onSave={onSave} />
    </>
  );
}
