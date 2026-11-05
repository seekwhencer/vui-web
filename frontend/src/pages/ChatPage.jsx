import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import useChatStream from '../hooks/useChatStream.js';
import useConversation from '../hooks/useConversation.js';
import useTranscription from '../hooks/useTranscription.js';
import ChatInput from '../components/ChatInput.jsx';
import ChatView from '../components/ChatView.jsx';
import ChatHistory from '../components/ChatHistory.jsx';
import VoiceControls from '../components/VoiceControls.jsx';

export default function ChatPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { thinking, answer, question, pending, error, done, run, setResult } = useChatStream();
  const { items, add, update, remove } = useConversation();
  const {
    status: micStatus,
    isRecording,
    finalText,
    interimText,
    startRecording,
    stopRecording,
    clearTranscript,
  } = useTranscription();
  const [inputValue, setInputValue] = useState('');
  const [activeId, setActiveId] = useState(null);
  const consumedRef = useRef(false);

  const handleSubmit = async (text) => {
    const history = items
      .slice()
      .reverse()
      .filter((item) => !item.pending && item.answer)
      .flatMap((item) => [
        { role: 'user', content: item.question },
        { role: 'assistant', content: item.answer },
      ]);

    const id = add({ question: text, pending: true });
    setActiveId(id);
    setInputValue('');

    const result = await run(text, history);

    update(id, {
      pending: false,
      answer: result.answer,
      thinking: result.thinking,
      error: result.error ? result.error.message || String(result.error) : null,
    });
  };

  useEffect(() => {
    if (consumedRef.current) return;
    const incoming = location.state?.question;
    if (!incoming) return;
    consumedRef.current = true;
    navigate(location.pathname, { replace: true, state: null });
    setInputValue(incoming);
    handleSubmit(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleVoiceToggle = () => {
    if (!isRecording) {
      startRecording();
      return;
    }
    stopRecording();
    setInputValue((prev) => {
      const trimmed = finalText.trim();
      if (!trimmed) return prev;
      return prev ? `${prev.trimEnd()} ${trimmed}` : trimmed;
    });
    clearTranscript();
  };

  const handleSelect = (item) => {
    setActiveId(item.id);
    setResult({
      question: item.question,
      answer: item.answer,
      thinking: item.thinking,
      error: item.error || null,
    });
  };

  const handleRemove = (id) => {
    remove(id);
    if (activeId === id) {
      setActiveId(null);
    }
  };

  return (
    <div className="chat-page">
      <ChatHistory items={items} activeId={activeId} onSelect={handleSelect} onRemove={handleRemove} />

      <div className="chat">
        <div className="chat__header">
          <h2>{t('chat.title')}</h2>
        </div>

        <ChatView
          thinking={thinking}
          answer={answer}
          question={question}
          pending={pending}
          error={error}
          done={done}
        />

        <VoiceControls
          isRecording={isRecording}
          micStatus={micStatus}
          interimText={interimText}
          onToggle={handleVoiceToggle}
        />

        <ChatInput
          onSubmit={handleSubmit}
          disabled={pending}
          value={inputValue}
          onChange={setInputValue}
        />
      </div>
    </div>
  );
}
