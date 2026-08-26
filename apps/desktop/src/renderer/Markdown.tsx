import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

const components: Components = {
  a({ node: _node, ...props }): ReactNode {
    return <a {...props} target="_blank" rel="noreferrer noopener"/>;
  },
  pre({ node: _node, className, ...props }): ReactNode {
    return <pre {...props} className={["code-block", className].filter(Boolean).join(" ")}/>;
  },
  table({ node: _node, children, ...props }): ReactNode {
    return <div className="markdown-table-wrap"><table {...props}>{children}</table></div>;
  },
};

export function MarkdownContent({ text, streaming = false, className = "" }: {
  text: string;
  streaming?: boolean;
  className?: string;
}): ReactNode {
  if (!text) return streaming ? <span className="stream-caret" aria-label="Streaming response">▋</span> : null;
  return <div className={["markdown-body", className].filter(Boolean).join(" ")}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} skipHtml components={components}>{text}</ReactMarkdown>
    {streaming && <span className="stream-caret" aria-label="Streaming response">▋</span>}
  </div>;
}
