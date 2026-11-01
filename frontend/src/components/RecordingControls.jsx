import { useTranslation } from 'react-i18next';
import { Mic, Square, Trash2 } from 'lucide-react';

export default function RecordingControls({ isRecording, onStart, onStop, onClear }) {
  const { t } = useTranslation();

  return (
    <div className="transcription__controls">
      <button
        type="button"
        className={`btn btn--primary${isRecording ? ' is-recording' : ''}`}
        onClick={() => (isRecording ? onStop() : onStart())}
      >
        {isRecording ? <Square size={20} /> : <Mic size={20} />}
        <span>{isRecording ? t('transcription.stop') : t('transcription.start')}</span>
      </button>
      <button type="button" className="btn btn--secondary" onClick={onClear}>
        <Trash2 size={20} />
        <span>{t('transcription.clear')}</span>
      </button>
    </div>
  );
}
