import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Mic, Send, Square } from 'lucide-react';

const EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Chat-Eingabe: Textarea + Aktionszeile (Aufnahme links, Effort mittig, Senden rechts).
 *
 * Props:
 * - onSubmit(text, reasoningEffort)  → gesendeter Text (getrimmt) + gewählter Effort
 * - onAbort()       → laufenden Stream abbrechen (wird bei `pending` als Stop-Button gezeigt)
 * - pending         → Stream läuft → Send-Button wird zum Stop-Button
 * - disabled        → Eingabe + Senden sperren
 * - readOnly        → Textarea nur lesen (z. B. während Voice-Aufnahme)
 * - value/onChange  → optionaler Controlled-Mode (z. B. Voice-Transkript setzen)
 * - isRecording     → Aufnahme aktiv (Aufnahme-Button zeigt Stop)
 * - onToggleRecording() → Aufnahme starten/stoppen
 *
 * Enter = senden, Shift+Enter = Zeilenumbruch.
 */
export default function ChatInput({
  onSubmit,
  onAbort,
  pending,
  disabled,
  value,
  onChange,
  readOnly,
  isRecording,
  onToggleRecording,
}) {
  const { t } = useTranslation();
  const [internal, setInternal] = useState('');
  const [effort, setEffort] = useState('none');

  const controlled = value !== undefined;
  const text = controlled ? value : internal;

  const setText = (v) => {
    if (controlled) {
      if (onChange) onChange(v);
    } else {
      setInternal(v);
    }
  };

  function submit() {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed, effort);
    setText('');
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form
      className="chat-input"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        className="chat-input__textarea"
        value={text}
        rows={3}
        placeholder={t('chat.placeholder')}
        aria-label={t('chat.placeholder')}
        disabled={disabled}
        readOnly={readOnly}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="chat-input__actions">
        <button
          type="button"
          className={`chat-input__record btn btn--secondary${isRecording ? ' chat-input__record--recording' : ''}`}
          onClick={onToggleRecording}
          aria-label={isRecording ? t('voice.stop') : t('voice.start')}
        >
          {isRecording ? <Square size={16} fill="currentColor" /> : <Mic size={16} />}
          <span>{isRecording ? t('voice.stop') : t('voice.start')}</span>
        </button>
        <select
          className="chat-input__effort"
          value={effort}
          onChange={(e) => setEffort(e.target.value)}
          aria-label={t('chat.reasoningEffort')}
          disabled={disabled}
        >
          {EFFORTS.map((e) => (
            <option key={e} value={e}>{t(`chat.effort.${e}`)}</option>
          ))}
        </select>
        {pending && onAbort ? (
          <button type="button" className="chat-input__send btn btn--stop" onClick={onAbort}>
            <Square size={16} fill="currentColor" />
            <span>{t('chat.stop')}</span>
          </button>
        ) : (
          <button type="submit" className="chat-input__send btn btn--primary" disabled={disabled || !text.trim()}>
            <Send size={16} />
            <span>{t('transcription.sendToChat')}</span>
          </button>
        )}
      </div>
    </form>
  );
}
