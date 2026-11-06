import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import useTypewriter from '../hooks/useTypewriter.js';

export default function TranscriptView({ finalText, interimText }) {
  const { t } = useTranslation();
  const boxRef = useRef(null);

  const displayedFinal = useTypewriter(finalText);
  const displayedInterim = useTypewriter(interimText);

  const typing = displayedFinal !== finalText || displayedInterim !== interimText;

  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [displayedFinal, displayedInterim]);

  const showPlaceholder = !finalText && !interimText;

  return (
    <div className="transcript" ref={boxRef}>
      {showPlaceholder && (
        <p className="transcript__placeholder">{t('transcription.placeholder')}</p>
      )}
      <span>{displayedFinal}</span>
      <span className="transcript__interim">{displayedInterim}</span>
      {typing && <span className="transcript__caret" aria-hidden="true" />}
    </div>
  );
}
