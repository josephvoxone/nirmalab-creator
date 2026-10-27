/**
 * Assistant markdown: lists, bold, code, tables (GFM). Raw HTML from the model is never rendered
 * as elements (no rehype-raw; `skipHtml` drops it); links open in a new tab without an opener.
 */
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-2 hover:text-foreground/80" />,
  p: ({ node: _node, ...props }) => <p {...props} className="my-1.5 first:mt-0 last:mb-0" />,
  ul: ({ node: _node, ...props }) => <ul {...props} className="my-1.5 list-disc space-y-0.5 pl-5" />,
  ol: ({ node: _node, ...props }) => <ol {...props} className="my-1.5 list-decimal space-y-0.5 pl-5" />,
  li: ({ node: _node, ...props }) => <li {...props} className="pl-0.5 marker:text-muted-foreground" />,
  strong: ({ node: _node, ...props }) => <strong {...props} className="font-semibold text-foreground" />,
  h1: ({ node: _node, ...props }) => <p {...props} className="mt-2 mb-1 text-[13.5px] font-semibold" />,
  h2: ({ node: _node, ...props }) => <p {...props} className="mt-2 mb-1 text-[13.5px] font-semibold" />,
  h3: ({ node: _node, ...props }) => <p {...props} className="mt-2 mb-1 text-[13px] font-semibold" />,
  blockquote: ({ node: _node, ...props }) => <blockquote {...props} className="my-1.5 border-l-2 border-border pl-2.5 text-muted-foreground" />,
  pre: ({ node: _node, ...props }) => <pre {...props} className="my-1.5 max-w-full overflow-x-auto rounded-md bg-muted/60 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed [&_code]:bg-transparent [&_code]:p-0" />,
  code: ({ node: _node, ...props }) => <code {...props} className="rounded-[4px] bg-muted/70 px-1 py-px font-mono text-[11.5px]" />,
  table: ({ node: _node, ...props }) => <div className="my-1.5 max-w-full overflow-x-auto"><table {...props} className="text-[12px] [&_td]:border-t [&_td]:border-border/60 [&_td]:px-2 [&_td]:py-1 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium" /></div>,
  img: () => null
};

export function AssistantMarkdown(props: { text: string }) {
  return (
    <div className="text-[13px] leading-relaxed break-words text-foreground">
      <Markdown remarkPlugins={[remarkGfm]} skipHtml components={components}>{props.text}</Markdown>
    </div>
  );
}
