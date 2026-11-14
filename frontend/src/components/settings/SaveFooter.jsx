import { useTranslation } from 'react-i18next';
import { Save, RotateCcw } from 'lucide-react';

export default function SaveFooter({ error, saved, saving, onReset, onSave }) {
  const { t } = useTranslation();
  return (
    <div className="settings__footer">
      {error && <span className="settings__error">{error}</span>}
      {saved && !error && <span className="settings__saved">{t('settings.saved')}</span>}
      <div className="settings__actions">
        <button type="button" className="btn btn--secondary" onClick={onReset}>
          <RotateCcw size={16} />
          <span>{t('settings.reset')}</span>
        </button>
        <button type="button" className="btn btn--primary" onClick={onSave} disabled={saving}>
          <Save size={16} />
          <span>{saving ? t('settings.saving') : t('settings.save')}</span>
        </button>
      </div>
    </div>
  );
}
