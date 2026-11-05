import { useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ThinkBlock from './ThinkBlock';
import MarkdownRenderer from './Markdown';

function errorMessage(t, error) {
  if (error && (error.name === 'NetworkError' || error.status === 0)) {
    return t('chat.error.network');
  }
  return t('chat.error.server');
}

/**
 * Zeigt den aktuellen Chat-Stand: Thinking (ThinkBlock) + Antwort (Markdown).
 *
 * Props (State von `useChatStream`):
 * thinking, answer, question, pending, error, done
 */
export default function ChatView({ thinking, answer, question, pending, error, done }) {
  const { t } = useTranslation();
  const sectionRef = useRef(null);

  useLayoutEffect(() => {
    const el = sectionRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [thinking, answer]);

  if (error) {
    return (
      <section ref={sectionRef} className="chat-view chat-view__error" aria-live="polite">
        <p className="chat-view__error-text">{errorMessage(t, error)}</p>
      </section>
    );
  }

  const streaming = pending && !done;

  if (streaming && !thinking && !answer) {
    return (
      <section ref={sectionRef} className="chat-view chat-view__loading" aria-live="polite">
        {question && <p className="chat-view__question">{question}</p>}
        <div className="chat-view__loading-flex">
          <span className="spinner" role="status" aria-hidden="true" />
          <p className="chat-view__loading-text">{t('chat.loading')}</p>
        </div>
      </section>
    );
  }

  if (done && !thinking && !answer) {
    return (
      <section ref={sectionRef} className="chat-view chat-view__empty" aria-live="polite">
        <p className="chat-view__empty-text">{t('chat.empty')}</p>
      </section>
    );
  }

  if (answer || thinking) {
    return (
      <section ref={sectionRef} className="chat-view" aria-live="polite">
        {question && <p className="chat-view__question">{question}</p>}
        <div className="chat-view__answer">
          {thinking && <ThinkBlock content={thinking} />}
          {answer ? (
            <MarkdownRenderer text={answer} />
          ) : streaming ? (
            <span className="answer__cursor" aria-hidden="true" />
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section ref={sectionRef} className="chat-view chat-view__empty" aria-live="polite">
      <p className="chat-view__empty-text">{t('chat.empty')}</p>
    </section>
  );
}
