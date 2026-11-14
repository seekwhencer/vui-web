import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { buildDataUrl } from './ChatImage.jsx';

/**
 * Prüft, ob ein Tastatur-Event die Escape-Taste ist.
 * @param {KeyboardEvent|null|undefined} event - Das Tastatur-Event
 * @returns {boolean} true nur bei Escape
 */
export function isEscapeKey(event) {
  return Boolean(event) && event.key === 'Escape';
}

/**
 * Vollbild-Overlay zum Anzeigen eines Chat-Bildes in Originalgröße.
 * Schließen über: Close-Button, Klick auf den Hintergrund, Escape-Taste.
 *
 * Props:
 * - image   → { mimeType, data, url } oder null (null → rendert nichts)
 * - onClose → Callback zum Schließen
 */
export default function ImageLightbox({ image, onClose }) {
  const { t } = useTranslation();

  useEffect(() => {
    if (typeof window === 'undefined' || !onClose) return undefined;
    const onKeyDown = (event) => {
      if (isEscapeKey(event)) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (!image) return null;

  const src = image.url || (image.data ? buildDataUrl(image.mimeType, image.data) : null);
  if (!src) return null;

  return (
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      onClick={() => onClose && onClose()}
    >
      <img
        className="lightbox__image"
        src={src}
        alt={t('chat.image.alt')}
        onClick={(event) => event.stopPropagation()}
      />
      <button
        type="button"
        className="lightbox__close"
        aria-label={t('chat.image.close')}
        onClick={(event) => {
          event.stopPropagation();
          if (onClose) onClose();
        }}
      >
        ×
      </button>
    </div>
  );
}
