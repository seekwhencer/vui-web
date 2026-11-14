import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ThinkBlock from './ThinkBlock';
import MarkdownRenderer from './Markdown';
import ApprovalDialog from './ApprovalDialog.jsx';
import ChatImage from './ChatImage.jsx';
import ImageLightbox from './ImageLightbox.jsx';
import useChatStream from '../hooks/useChatStream.js';

function errorMessage(t, error) {
  if (error && (error.name === 'NetworkError' || error.status === 0)) {
    return t('chat.error.network');
  }
  return t('chat.error.server');
}

// Manche Server (z. B. LM Studio) melden den vollen Modell-Pfad. Für die
// Anzeige nur das letzte Segment zeigen (der echte Modell-Name).
function modelLabel(model) {
  if (!model) return '—';
  const parts = String(model).split(/[\\/]+/);
  return parts[parts.length - 1] || String(model);
}

/**
 * Zeigt den kompletten Chatverlauf: alle Turns (User + Assistant) in
 * zeitlicher Reihenfolge. Der laufende Turn (pending) zeigt den Live-Stream
 * (thinking/answer) aus `useChatStream`.
 *
 * Props:
 * - items          → Array { id, question, answer, thinking, error, pending } (älteste zuerst)
 * - thinking       → Live-Thinking des laufenden Turns
 * - answer         → Live-Antwort des laufenden Turns
 * - error          → Live-Fehler des laufenden Turns (Error-Objekt)
 * - conversationId → id der angezeigten Konversation (Wechsel → ans Ende scrollen)
 */
export default function ChatView({ items, thinking, answer, error, conversationId }) {
  const { t } = useTranslation();
  const listRef = useRef(null);
  const prevCountRef = useRef(0);

  // Zero-Trust: offene Freigabe-Aktionen aus dem (modulebenen) Store —
  // sie überleben Seitenwechsel. Der Dialog zeigt die erste offene Aktion.
  // `images` = Tool-Ergebnis-Bilder des laufenden Turns (Live-Stream).
  const { pendingApprovals, clearPendingApproval, images } = useChatStream();
  const pendingApproval = pendingApprovals[0] || null;

  // Lightbox: aktuelles Bild oder null (geschlossen).
  const [lightbox, setLightbox] = useState(null);

  const turns = items || [];

  // Konversations-Wechsel: ans Ende springen (neueste Nachricht).
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversationId]);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;

    // Neuer Turn → immer ans Ende springen.
    if (turns.length !== prevCountRef.current) {
      prevCountRef.current = turns.length;
      el.scrollTop = el.scrollHeight;
      return;
    }

    // Streaming: nur folgen, wenn der Nutzer bereits unten ist.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [turns.length, thinking, answer, images]);

  if (turns.length === 0) {
    return (
      <>
        <section className="chat-view chat-view__empty" aria-live="polite">
          <p className="chat-view__empty-text">{t('chat.empty')}</p>
        </section>
        {pendingApproval && (
          <ApprovalDialog action={pendingApproval} onClose={clearPendingApproval} />
        )}
        {lightbox && <ImageLightbox image={lightbox} onClose={() => setLightbox(null)} />}
      </>
    );
  }

  return (
    <>
      <section ref={listRef} className="chat-view" aria-live="polite">
        {turns.map((item) => {
          const isLive = Boolean(item.pending);
          const itemThinking = isLive ? thinking : item.thinking || '';
          const itemAnswer = isLive ? answer : item.answer || '';
          const itemError = isLive
            ? (error ? errorMessage(t, error) : null)
            : (item.error || null);
          // Bilder: Live-Turn aus dem Stream-Store, sonst aus dem gespeicherten Turn.
          const itemImages = isLive ? (images || []) : (item.images || []);

          return (
            <div className="turn" key={item.id} data-turn-id={item.id}>
              <div className="msg msg--user">
                <div className="msg__bubble">{item.question}</div>
              </div>

              <div className="msg msg--assistant">
                {itemThinking && <ThinkBlock content={itemThinking} />}
                {itemError ? (
                  <p className="chat-view__error-text">{itemError}</p>
                ) : itemAnswer || itemImages.length > 0 ? (
                  <>
                    {itemAnswer && (
                      <div className="msg__bubble">
                        <MarkdownRenderer text={itemAnswer} />
                      </div>
                    )}
                    {itemImages.length > 0 && (
                      <div className="msg__images">
                        {itemImages.map((img, i) => (
                          <ChatImage key={i} {...img} onOpen={setLightbox} />
                        ))}
                      </div>
                    )}
                    {item.tokens != null && (
                      <div
                        className="turn__meta"
                        title={`${t('chat.tokensPrompt')}: ${item.tokens.prompt} · ${t('chat.tokensCompletion')}: ${item.tokens.completion}`}
                      >
                        <span className="turn__model" title={item.model}>{modelLabel(item.model)}</span>
                        <span className="turn__tokens">
                          {item.tokens.total} {t('chat.tokens')}
                        </span>
                      </div>
                    )}
                  </>
                ) : isLive && !itemThinking ? (
                  <div className="chat-view__loading-flex">
                    <span className="spinner" role="status" aria-hidden="true" />
                    <p className="chat-view__loading-text">{t('chat.loading')}</p>
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </section>
      {pendingApproval && (
        <ApprovalDialog action={pendingApproval} onClose={clearPendingApproval} />
      )}
      {lightbox && <ImageLightbox image={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}
