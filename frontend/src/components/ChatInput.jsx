import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send } from 'lucide-react';

/**
 * Chat-Eingabe: Textarea + Send-Button.
 *
 * Props:
 * - onSubmit(text)  → gesendeter Text (getrimmt)
 * - disabled        → Eingabe + Senden sperren
 * - readOnly        → Textarea nur lesen (z. B. während Voice-Aufnahme)
 * - value/onChange  → optionaler Controlled-Mode (z. B. Voice-Transkript setzen)
 *
 * Enter = senden, Shift+Enter = Zeilenumbruch.
 */
export default function ChatInput({ onSubmit, disabled, value, onChange, readOnly }) {
  const { t } = useTranslation();
  const [internal, setInternal] = useState('');

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
    onSubmit(trimmed);
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
      <button type="submit" className="btn btn--primary" disabled={disabled || !text.trim()}>
        <Send size={16} />
        <span>{t('transcription.sendToChat')}</span>
      </button>
    </form>
  );
}
