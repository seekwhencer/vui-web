import { useTranslation } from 'react-i18next';
import { Mic, Square } from 'lucide-react';
import useTypewriter from '../hooks/useTypewriter.js';

/**
 * Voice-Steuerung für die ChatPage.
 *
 * Props:
 * - isRecording  → Aufnahme aktiv (Mic-Button zeigt Stop)
 * - interimText  → Live-Transkript (während Aufnahme, kursiv)
 * - onToggle()   → Aufnahme starten/stoppen
 */
export default function VoiceControls({ isRecording, interimText, onToggle }) {
  const { t } = useTranslation();
  const displayedInterim = useTypewriter(interimText);
  const typing = displayedInterim !== interimText;

  return (
    <div className="voice-controls">
      <button
        type="button"
        className={`voice-controls__mic${isRecording ? ' voice-controls__mic--recording' : ''} btn btn--primary`}
        onClick={onToggle}
        aria-label={isRecording ? t('voice.stop') : t('voice.start')}
      >
        {isRecording ? <Square size={18} /> : <Mic size={18} />}
        <span>{isRecording ? t('voice.stop') : t('voice.start')}</span>
      </button>

      {interimText ? (
        <span className="voice-controls__interim" aria-label={t('voice.listening')}>
          {displayedInterim}
          {typing && <span className="transcript__caret" aria-hidden="true" />}
        </span>
      ) : null}
    </div>
  );
}
