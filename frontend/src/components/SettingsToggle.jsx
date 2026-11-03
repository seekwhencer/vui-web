import { useTranslation } from 'react-i18next';
import { Settings } from 'lucide-react';

export default function SettingsToggle({ onClick, active }) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      className={`topbar__btn${active ? ' is-active' : ''}`}
      onClick={onClick}
      aria-label={t('settings.toggle')}
      title={t('settings.toggle')}
      aria-pressed={active}
    >
      <Settings size={18} />
    </button>
  );
}
