import { Component, type ErrorInfo, type ReactNode } from "react";
import { cjk } from "@streamdown/cjk";
import { createMathPlugin } from "@streamdown/math";
import { defaultUrlTransform, Streamdown, type Components, type UrlTransform } from "streamdown";

import { normalizeMathDelimiters } from "./Markdown";

const MAX_RICH_MARKDOWN_CHARACTERS = 200_000;
const plugins = { cjk, math: createMathPlugin({ singleDollarTextMath: true }) };

const components: Components = {
  a({ node: _node, ...props }): ReactNode {
    return <a {...props} target="_blank" rel="noreferrer noopener"/>;
  },
  img({ node: _node, alt = "", src, ...props }): ReactNode {
    const safeSource = typeof src === "string" ? src : "";
    if (safeSource.startsWith("data:image/") || safeSource.startsWith("blob:")) {
      return <img {...props} src={safeSource} alt={alt} loading="lazy"/>;
    }
    return <span className="markdown-image-link">Image: {safeSource
      ? <a href={safeSource} target="_blank" rel="noreferrer noopener">{alt || "Open image"}</a>
      : alt || "Unavailable image"}</span>;
  },
  table({ node: _node, children, ...props }): ReactNode {
    return <div className="markdown-table-wrap" tabIndex={0}><table {...props}>{children}</table></div>;
  },
};

const safeUrlTransform: UrlTransform = (url, key, node) => {
  if (key === "src" && node.tagName === "img" && (url.startsWith("data:image/") || url.startsWith("blob:"))) return url;
  return defaultUrlTransform(url, key, node);
};

export function StreamdownPrototype({ text, streaming = false, simulateFailure = false }: {
  text: string;
  streaming?: boolean;
  simulateFailure?: boolean;
}): ReactNode {
  return <CandidateErrorBoundary fallbackText={text}>
    {simulateFailure
      ? <ForcedFailure/>
      : text.length >= MAX_RICH_MARKDOWN_CHARACTERS
        ? <pre className="rendering-oversize-fallback" data-rendering-fallback="oversized">{text}</pre>
        : <div className="markdown-body streamdown-prototype">{splitEmbeddedImages(normalizeMathDelimiters(text)).map((part, index) =>
            part.kind === "image"
              ? <img key={index} src={part.source} alt={part.alt} loading="lazy"/>
              : part.value
                ? <Streamdown
                    key={index}
                    animated={false}
                    {...(streaming ? { caret: "block" as const } : {})}
                    components={components}
                    controls
                    dir="auto"
                    isAnimating={false}
                    lineNumbers={false}
                    linkSafety={{ enabled: false }}
                    mode={streaming ? "streaming" : "static"}
                    parseIncompleteMarkdown
                    plugins={plugins}
                    skipHtml
                    urlTransform={safeUrlTransform}
                  >{part.value}</Streamdown>
                : null)}</div>}
  </CandidateErrorBoundary>;
}

type EmbeddedPart = { kind: "markdown"; value: string } | { kind: "image"; alt: string; source: string };

/** Streamdown's default sanitize schema removes data URLs before custom components run. Restore only explicit image data. */
function splitEmbeddedImages(markdown: string): EmbeddedPart[] {
  const parts: EmbeddedPart[] = [];
  const pattern = /!\[([^\]\n]*)\]\((data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+)\)/gi;
  let cursor = 0;
  for (const match of markdown.matchAll(pattern)) {
    const index = match.index ?? 0;
    parts.push({ kind: "markdown", value: markdown.slice(cursor, index) });
    parts.push({ kind: "image", alt: match[1] ?? "", source: match[2]! });
    cursor = index + match[0].length;
  }
  parts.push({ kind: "markdown", value: markdown.slice(cursor) });
  return parts;
}

class CandidateErrorBoundary extends Component<{
  children: ReactNode;
  fallbackText: string;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Streamdown prototype failed; falling back to plain text", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return <pre className="rendering-error-fallback" role="alert" data-rendering-fallback="error">{this.props.fallbackText}</pre>;
    }
    return this.props.children;
  }
}

function ForcedFailure(): ReactNode {
  throw new Error("Intentional rendering benchmark failure");
}
