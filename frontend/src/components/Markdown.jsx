import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function MarkdownRenderer({ text, className }) {
  if (!text) return null;

  return (
    <div className={`markdown${className ? ' ' + className : ''}`}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { children, className, node, ...rest } = props;
            const match = /language-(\w+)/.exec(className || '');
            return match ? (
              <pre {...rest} className={className}>
                <code {...rest} className={className}>
                  {children}
                </code>
              </pre>
            ) : (
              <code {...rest} className={className}>
                {children}
              </code>
            );
          },
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
