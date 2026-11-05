import { useTranslation } from 'react-i18next';
import { Play, Square } from 'lucide-react';

/**
 * Voice-Steuerung für die ChatPage.
 *
 * Props:
 * - isRecording  → Aufnahme aktiv (Mic-Button zeigt Stop)
 * - micStatus    → 'ready' | 'recording' | 'disconnected' | 'error' (Badge, status.*-Keys)
 * - interimText  → Live-Transkript (während Aufnahme, kursiv)
 * - onToggle()   → Aufnahme starten/stoppen
 */
export default function VoiceControls({ isRecording, micStatus, interimText, onToggle }) {
  const { t } = useTranslation();

  return (
    <div className="voice-controls">
      <button
        type="button"
        className={`voice-controls__mic${isRecording ? ' voice-controls__mic--recording' : ''} btn btn--primary`}
        onClick={onToggle}
        aria-label={isRecording ? t('voice.stop') : t('voice.start')}
      >
        {isRecording ? <Square size={18} /> : <Play size={18} />}
        <span>{isRecording ? t('voice.stop') : t('voice.start')}</span>
      </button>

      <span className={`voice-controls__status voice-controls__status--${micStatus}`}>
        {t(`status.${micStatus}`)}
      </span>

      {interimText ? (
        <span className="voice-controls__interim" aria-label={t('voice.listening')}>
          {interimText}
        </span>
      ) : null}
    </div>
  );
}
