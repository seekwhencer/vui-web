import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import MarkdownRenderer from './Markdown';

export default function ThinkBlock({ content }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (!content) return null;

  return (
    <>
      <button
        type="button"
        className={`thinking ${expanded ? 'thinking--expanded' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          setExpanded((v) => !v);
        }}
        aria-expanded={expanded}
      >
        <span className="thinking__label">
          {expanded ? t('chat.hideThinking') : t('chat.thinking')}
        </span>
      </button>
      {expanded && (
        <div className="thinking__body" role="region">
          <MarkdownRenderer text={content} />
        </div>
      )}
    </>
  );
}
