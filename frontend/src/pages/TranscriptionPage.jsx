import { useTranslation } from 'react-i18next';
import useTranscription from '../hooks/useTranscription.js';
import StatusBadge from '../components/StatusBadge.jsx';
import RecordingControls from '../components/RecordingControls.jsx';
import TranscriptView from '../components/TranscriptView.jsx';

export default function TranscriptionPage() {
  const { t } = useTranslation();
  const {
    status,
    isRecording,
    finalText,
    interimText,
    startRecording,
    stopRecording,
    clearTranscript,
  } = useTranscription();

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
      </div>
    </div>
  );
}
