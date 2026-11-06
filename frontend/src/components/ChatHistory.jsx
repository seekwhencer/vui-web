import { useTranslation } from 'react-i18next';
import { X, Trash2, Plus } from 'lucide-react';

function formatTs(ts) {
  if (ts == null) return '';
  return new Date(ts).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Konversations-History: Liste der gespeicherten Konversationen
 * (localStorage via `useConversation`), neueste zuerst. Ein Klick zeigt die
 * komplette Konversation im Chatverlauf; der Mülleimer entfernt sie.
 *
 * Props:
 * - conversations → Array { id, title, ts, turns } (neueste zuerst)
 * - activeId      → id der aktuell angezeigten Konversation (oder null)
 * - onSelect      → (id) => void  (Konversation anzeigen)
 * - onRemove      → (id) => void  (Konversation löschen)
 * - onNew         → () => void    (neue Konversation starten)
 * - onClose       → () => void    (optional, schließt das Mobile-Drawer)
 */
export default function ChatHistory({ conversations, activeId, onSelect, onRemove, onNew, onClose }) {
  const { t } = useTranslation();

  return (
    <aside className="chat-history" aria-label={t('chat.history.title')}>
      <div className="chat-history__head">
        <h2 className="chat-history__title">{t('chat.history.title')}</h2>
        <div className="chat-history__head-actions">
          {onNew && (
            <button
              type="button"
              className="chat-history__new"
              aria-label={t('chat.new')}
              title={t('chat.new')}
              onClick={onNew}
            >
              <Plus size={16} />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              className="chat-history__close"
              aria-label={t('chat.history.close')}
              onClick={onClose}
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      {!conversations || conversations.length === 0 ? (
        <p className="chat-history__empty">{t('chat.history.empty')}</p>
      ) : (
        <ul className="chat-history__list">
          {conversations.map((conversation) => (
            <li
              key={conversation.id}
              className={`chat-history__item${conversation.id === activeId ? ' chat-history__item--active' : ''}`}
            >
              <button
                type="button"
                className="chat-history__select"
                onClick={() => onSelect && onSelect(conversation.id)}
              >
                <span className="chat-history__question">{conversation.title}</span>
                {conversation.ts != null && (
                  <time
                    className="chat-history__time"
                    dateTime={new Date(conversation.ts).toISOString()}
                  >
                    {formatTs(conversation.ts)}
                  </time>
                )}
              </button>
              {onRemove && (
                <button
                  type="button"
                  className="chat-history__delete"
                  aria-label={t('chat.history.delete')}
                  onClick={() => onRemove(conversation.id)}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
