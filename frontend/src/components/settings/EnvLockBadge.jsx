import { useTranslation } from 'react-i18next';
import { Lock } from 'lucide-react';

/**
 * Badge für Env-gelockte Settings-Felder: Lock-Icon hinter dem Feldnamen.
 * Tooltip (Hover/Fokus) zeigt, dass der Wert per Umgebungsvariable gesetzt
 * ist und in der UI nicht änderbar ist.
 *
 * @param {object} props
 * @param {string} props.envName - Name der Umgebungsvariable (z. B. 'WHISPER_LANG')
 */
export default function EnvLockBadge({ envName }) {
  const { t } = useTranslation();
  const label = t('settings.envLocked', { env: envName });
  return (
    <span className="env-lock" tabIndex={0} aria-label={label}>
      <Lock size={13} aria-hidden="true" />
      <span className="env-lock__tooltip" role="tooltip">
        {label}
      </span>
    </span>
  );
}
