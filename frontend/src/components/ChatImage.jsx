import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Baut eine data:-URL aus MIME-Type und Base64-Daten.
 * @param {string} mimeType - z. B. "image/png"
 * @param {string} data - Base64-kodierte Bilddaten
 * @returns {string} data-URL
 */
export function buildDataUrl(mimeType, data) {
  return `data:${mimeType};base64,${data}`;
}

/**
 * Zeigt ein Tool-Ergebnis-Bild (ImageContent) als Thumbnail im Chat.
 * Klick öffnet die Lightbox (onOpen). Bei Lade-Fehler (onError) wird
 * stattdessen ein Fallback-Box mit Fehlermeldung gerendert.
 *
 * Props:
 * - mimeType → MIME-Type des Bildes (z. B. "image/png")
 * - data     → Base64-kodierte Bilddaten
 * - alt      → optionales Alt-Text (Default: i18n chat.image.alt)
 * - onOpen   → Callback mit { mimeType, data } beim Klick
 * - failed   → optional, initialisiert den Fehler-Zustand (nur für Tests)
 */
export default function ChatImage({ mimeType, data, alt, onOpen, failed }) {
  const { t } = useTranslation();
  const [isFailed, setFailed] = useState(Boolean(failed));

  if (isFailed) {
    return <div className="msg__image msg__image--error">{t('chat.image.error')}</div>;
  }

  return (
    <img
      className="msg__image"
      src={buildDataUrl(mimeType, data)}
      alt={alt || t('chat.image.alt')}
      loading="lazy"
      onError={() => setFailed(true)}
      onClick={() => onOpen && onOpen({ mimeType, data })}
    />
  );
}
