import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import useTranscription from '../hooks/useTranscription.js';
import StatusBadge from '../components/StatusBadge.jsx';
import RecordingControls from '../components/RecordingControls.jsx';
import TranscriptView from '../components/TranscriptView.jsx';

export default function TranscriptionPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    status,
    isRecording,
    finalText,
    interimText,
    startRecording,
    stopRecording,
    clearTranscript,
  } = useTranscription();

  const canSend = finalText.trim().length > 0;

  const handleSendToChat = () => {
    if (!canSend) return;
    navigate('/chat', { state: { question: finalText } });
  };

  return (
    <div className="transcription-page">
      <div className="transcription">
        <div className="transcription__header">
          <StatusBadge status={status} />
          <h2>{t('transcription.title')}</h2>
        </div>

        <RecordingControls
          isRecording={isRecording}
          onStart={startRecording}
          onStop={stopRecording}
          onClear={clearTranscript}
        />

        <TranscriptView finalText={finalText} interimText={interimText} />

        <div className="transcription__actions">
          <button
            type="button"
            className="btn btn--secondary"
            disabled={!canSend}
            onClick={handleSendToChat}
          >
            {t('transcription.sendToChat')}
          </button>
        </div>
      </div>
    </div>
  );
}
