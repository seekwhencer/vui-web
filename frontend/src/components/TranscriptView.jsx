import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

export default function TranscriptView({ finalText, interimText }) {
  const { t } = useTranslation();
  const boxRef = useRef(null);

  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [finalText, interimText]);

  const showPlaceholder = !finalText && !interimText;

  return (
    <div className="transcript" ref={boxRef}>
      {showPlaceholder && (
        <p className="transcript__placeholder">{t('transcription.placeholder')}</p>
      )}
      <span>{finalText}</span>
      <span className="transcript__interim">{interimText}</span>
    </div>
  );
}
