import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';

// Wie lange das "Fertig"-Signal sichtbar bleibt (ms).
const DONE_FLASH_MS = 4000;

/**
 * Stream-Status in der Chat-Kopfzeile:
 * - `pending`  → pulsierender "Arbeitet…"-Indikator (solange der Stream läuft)
 * - `completedAt` frisch gesetzt (und kein Fehler) → kurzes "Fertig"-Signal,
 *   das nach DONE_FLASH_MS wieder verschwindet.
 *
 * Props:
 * - pending      → Stream läuft
 * - completedAt  → Zeitstempel (ms) des `done`-Events, sonst null
 * - error        → Fehler des laufenden Turns (unterdrückt das "Fertig"-Signal)
 */
export default function StreamStatus({ pending, completedAt, error }) {
  const { t } = useTranslation();
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (!completedAt || error) {
      setFlash(false);
      return undefined;
    }
    setFlash(true);
    const id = setTimeout(() => setFlash(false), DONE_FLASH_MS);
    return () => clearTimeout(id);
  }, [completedAt, error]);

  if (pending) {
    return (
      <div className="stream-status stream-status--working" role="status">
        <span className="stream-status__dot" aria-hidden="true" />
        <span>{t('chat.status.working')}</span>
      </div>
    );
  }

  if (flash) {
    return (
      <div className="stream-status stream-status--done" role="status">
        <Check size={14} aria-hidden="true" />
        <span>{t('chat.status.done')}</span>
      </div>
    );
  }

  return null;
}
