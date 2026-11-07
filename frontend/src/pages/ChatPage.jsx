import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { History } from 'lucide-react';
import useChatStream from '../hooks/useChatStream.js';
import useConversation from '../hooks/useConversation.js';
import useTranscription from '../hooks/useTranscription.js';
import useTypewriter from '../hooks/useTypewriter.js';
import ChatInput from '../components/ChatInput.jsx';
import ChatView from '../components/ChatView.jsx';
import ChatHistory from '../components/ChatHistory.jsx';
import VoiceControls from '../components/VoiceControls.jsx';
import StatusBadge from '../components/StatusBadge.jsx';

export default function ChatPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { thinking, answer, pending, error, run, setResult, abort } = useChatStream();
  const {
    conversations,
    activeId,
    active,
    select,
    startNew,
    addTurn,
    updateTurn,
    removeConversation,
    finalizePending,
  } = useConversation();
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const consumedRef = useRef(false);

  // Turns der aktiven Konversation (älteste zuerst).
  const items = active ? active.turns : [];

  // Live-Transkript (final + interim) wird während der Aufnahme Wort-für-Wort
  // in die Textarea "geschrieben" — denselben Hook wie die Transkriptions-Seite.
  const liveTranscription = finalText + interimText;
  const displayedTranscription = useTypewriter(liveTranscription);
  const displayValue = isRecording
    ? (displayedTranscription
        ? (inputValue ? `${inputValue.trimEnd()} ${displayedTranscription}` : displayedTranscription)
        : inputValue)
    : inputValue;

  const handleSubmit = async (text, reasoningEffort) => {
    // Alle Nachrichten der aktiven Konversation mitschicken
    // (User + Assistant-Ausgaben), aber NICHT die Denk-Ausgabe.
    const history = items
      .filter((item) => !item.pending && item.answer)
      .flatMap((item) => [
        { role: 'user', content: item.question },
        { role: 'assistant', content: item.answer },
      ]);

    const id = addTurn({ question: text, pending: true });
    setInputValue('');

    const result = await run(text, history, reasoningEffort);

    updateTurn(id, {
      pending: false,
      answer: result.answer,
      thinking: result.thinking,
      error: result.error ? result.error.message || String(result.error) : null,
      tokens: result.tokens,
      model: result.model,
    });
  };

  // Verwaiste "pending"-Turns (z. B. nach Reload/Abbruch) beim Mount als
  // abgeschlossen markieren. Läuft gerade ein Stream, ist der pending-Turn
  // der Live-Turn → NICHT anfassen, sonst ginge die laufende Ausgabe verloren.
  useEffect(() => {
    if (pending) return;
    finalizePending();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Aktive Konversation löschen und neu anfangen.
  const handleClear = () => {
    if (activeId) removeConversation(activeId);
    setResult({ question: '', answer: '', thinking: '', error: null });
  };

  // Neue Konversation: keine aktive Konversation → die nächste Nachricht
  // legt eine neue an.
  const handleNew = () => {
    startNew();
    setResult({ question: '', answer: '', thinking: '', error: null });
    setHistoryOpen(false);
  };

  // History-Klick: die komplette Konversation anzeigen.
  const handleSelect = (id) => {
    select(id);
    setHistoryOpen(false);
  };

  const handleRemove = (id) => {
    removeConversation(id);
  };

  return (
    <div className={`chat-page${historyOpen ? ' chat-page--history-open' : ''}`}>
      {historyOpen && (
        <div
          className="chat-history__backdrop"
          onClick={() => setHistoryOpen(false)}
          aria-hidden="true"
        />
      )}

      <ChatHistory
        conversations={conversations}
        activeId={activeId}
        onSelect={handleSelect}
        onRemove={handleRemove}
        onNew={handleNew}
        onClose={() => setHistoryOpen(false)}
      />

      <div className="chat">
        <div className="chat__header">
          <StatusBadge status={micStatus} />
          <div className="chat__header-right">
            <button
              type="button"
              className="chat__history-toggle"
              aria-label={t('chat.history.title')}
              onClick={() => setHistoryOpen(true)}
            >
              <History size={16} />
            </button>
            <h2>{t('chat.title')}</h2>
            {items.length > 0 && (
              <button type="button" className="chat__clear" onClick={handleClear}>
                {t('chat.clear')}
              </button>
            )}
          </div>
        </div>

        <ChatView
          items={items}
          thinking={thinking}
          answer={answer}
          error={error}
          conversationId={activeId}
        />

        <VoiceControls
          isRecording={isRecording}
          interimText={interimText}
          onToggle={handleVoiceToggle}
        />

        <ChatInput
          onSubmit={handleSubmit}
          onAbort={abort}
          pending={pending}
          disabled={pending}
          value={displayValue}
          onChange={setInputValue}
          readOnly={isRecording}
        />
      </div>
    </div>
  );
}
