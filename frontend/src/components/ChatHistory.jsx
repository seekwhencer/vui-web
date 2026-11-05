import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

function formatTs(ts) {
  if (ts == null) return '';
  return new Date(ts).toLocaleString();
}

/**
 * Liste der gespeicherten Chat-Items (localStorage via `useConversation`).
 *
 * Props:
 * - items     → Array { id, question, answer, thinking, pending, error, ts }
 * - activeId  → id des aktuell angezeigten Items (optional)
 * - onSelect  → (item) => void
 * - onRemove  → (id) => void
 */
export default function ChatHistory({ items, activeId, onSelect, onRemove }) {
  const { t } = useTranslation();

  return (
    <aside className="chat-history">
      <h2 className="chat-history__title">{t('chat.history.title')}</h2>

      {!items || items.length === 0 ? (
        <p className="chat-history__empty">{t('chat.history.empty')}</p>
      ) : (
        <ul className="chat-history__list">
          {items.map((item) => (
            <li
              key={item.id}
              className={`chat-history__item${item.id === activeId ? ' chat-history__item--active' : ''}${item.pending ? ' chat-history__item--pending' : ''}`}
              onClick={() => {
                if (onSelect) onSelect(item);
              }}
            >
              <span className="chat-history__question">{item.question}</span>
              <span className="chat-history__trailing">
                {item.pending && (
                  <span className="chat-history__pending" aria-hidden="true">
                    …
                  </span>
                )}
                {item.ts != null && (
                  <time dateTime={new Date(item.ts).toISOString()}>{formatTs(item.ts)}</time>
                )}
                {onRemove && (
                  <button
                    type="button"
                    className="chat-history__delete"
                    aria-label={t('chat.history.delete')}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(item.id);
                    }}
                  >
                    <X size={14} />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
