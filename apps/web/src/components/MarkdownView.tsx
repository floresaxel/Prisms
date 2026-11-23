/**
 * Sanitized markdown renderer (journal D2), shared by the locked journal note and
 * the task card's Details. Its own module so a screen that only sometimes shows
 * markdown can `lazy()` it and keep react-markdown + remark-gfm out of its bundle.
 *
 * No raw-HTML path (no rehype-raw), link hrefs allowlisted to http/https/mailto
 * (anything else, e.g. `javascript:`, is dropped), task-list checkboxes disabled.
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** Allow only these link schemes; everything else (javascript:, data:, …) is dropped. */
const SAFE_URL = /^(https?:|mailto:)/i;
const urlTransform = (url: string): string => (SAFE_URL.test(url) ? url : '');

/** Links open in a new tab, so following one never leaves (or unsaves) the card. */
const NEW_TAB_LINKS = {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the AST node must not reach the DOM element
  a: ({ node: _node, ...props }: { node?: unknown } & React.ComponentProps<'a'>) => <a {...props} target="_blank" rel="noopener noreferrer" />,
};

export function MarkdownView({ markdown, testId = 'journal-preview', linksInNewTab = false }: { markdown: string; testId?: string; linksInNewTab?: boolean }) {
  return (
    <div className="px-md" data-testid={testId}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={urlTransform} components={linksInNewTab ? NEW_TAB_LINKS : undefined}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
