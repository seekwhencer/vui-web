import { useTranslation } from 'react-i18next';

export default function StatusBadge({ status }) {
  const { t } = useTranslation();

  return (
    <div className={`status-badge status-badge--${status}`}>
      <span className="status-badge__dot" />
      <span>{t(`status.${status}`)}</span>
    </div>
  );
}
