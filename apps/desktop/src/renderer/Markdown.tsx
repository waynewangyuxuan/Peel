import { Children, Fragment, isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { Icon } from "./icons";

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
  pre({ node: _node, children }): ReactNode {
    const child = Children.only(children);
    const childClass = isValidElement<{ className?: string }>(child) ? child.props.className ?? "" : "";
    const language = childClass.match(/(?:^|\s)language-([^\s]+)/)?.[1] ?? "plain text";
    return <CodeBlock code={reactText(child)} language={language}>{child}</CodeBlock>;
  },
  table({ node: _node, children, ...props }): ReactNode {
    return <div className="markdown-table-wrap" tabIndex={0}><table {...props}>{children}</table></div>;
  },
};

export function MarkdownContent({ text, streaming = false, className = "" }: {
  text: string;
  streaming?: boolean;
  className?: string;
}): ReactNode {
  if (!text) return streaming ? <span className="stream-caret" aria-label="Streaming response">▋</span> : null;
  const renderedText = streaming ? projectStreamingMarkdown(text) : text;
  return <div className={["markdown-body", className].filter(Boolean).join(" ")}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} skipHtml components={components} urlTransform={safeUrlTransform}>{renderedText}</ReactMarkdown>
    {streaming && <span className="stream-caret" aria-label="Streaming response">▋</span>}
  </div>;
}

const safeUrlTransform: UrlTransform = (url, key, node) => {
  if (key === "src" && node.tagName === "img" && (url.startsWith("data:image/") || url.startsWith("blob:"))) return url;
  return defaultUrlTransform(url);
};

export function projectStreamingMarkdown(text: string): string {
  const openFence = findOpenFence(text);
  if (openFence) return `${text}${text.endsWith("\n") ? "" : "\n"}${openFence.character.repeat(openFence.length)}`;

  let projected = projectIncompleteTable(text);
  projected = removeIncompleteLinkSyntax(projected);
  const withoutInlineCode = projected.replace(/(?<!\\)(`+)([^\n]*?)\1/g, "");
  const inlineRuns = [...withoutInlineCode.matchAll(/(?<!\\)(`+)/g)].map((match) => match[1]!);
  const unmatchedInline = inlineRuns.find((run) => inlineRuns.filter((candidate) => candidate.length === run.length).length % 2 === 1);
  if (unmatchedInline) projected += unmatchedInline;

  const prose = projected
    .replace(/(?<!\\)(`+)([^\n]*?)\1/g, "")
    .replace(/^ {0,3}\*\s+/gm, "")
    .replace(/^ {0,3}[-*_](?:\s*[-*_]){2,}\s*$/gm, "");
  for (const delimiter of ["**", "__", "~~"] as const) {
    if (countDelimiter(prose, delimiter) % 2 === 1) projected += delimiter;
  }
  const withoutPairs = prose.replace(/\*\*|__/g, "");
  if (countDelimiter(withoutPairs, "*") % 2 === 1) projected += "*";
  if (countEmphasisUnderscores(withoutPairs) % 2 === 1) projected += "_";
  return projected;
}

function CodeBlock({ code, language }: { code: string; language: string; children?: ReactNode }): ReactNode {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);
  useEffect(() => () => { if (resetTimer.current !== null) window.clearTimeout(resetTimer.current); }, []);
  const copy = async (): Promise<void> => {
    await window.peel.copyText(code.replace(/\n$/, ""));
    setCopied(true);
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopied(false), 1_600);
  };
  return <div className="markdown-code">
    <div className="markdown-code-header"><span>{language}</span><button className="copy-code" onClick={() => void copy()}><Icon name={copied ? "check" : "copy"} size={12}/>{copied ? "Copied" : "Copy code"}</button></div>
    <pre className="code-block"><code><HighlightedCode code={code} language={language}/></code></pre>
  </div>;
}

export function HighlightedCode({ code, language }: { code: string; language: string }): ReactNode {
  return highlightCode(code, language).map((token, index) => token.kind === "plain"
    ? <Fragment key={index}>{token.value}</Fragment>
    : <span className={`syntax-${token.kind}`} key={index}>{token.value}</span>);
}

export type SyntaxTokenKind = "plain" | "comment" | "keyword" | "literal" | "number" | "string" | "function" | "operator" | "punctuation" | "addition" | "deletion" | "meta";
export interface SyntaxToken { kind: SyntaxTokenKind; value: string }

const KEYWORDS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "delete", "do", "else", "enum", "export", "extends", "finally", "for", "from", "function", "if", "implements", "import", "in", "instanceof", "interface", "let", "new", "of", "package", "private", "protected", "public", "raise", "return", "static", "switch", "throw", "try", "type", "typeof", "var", "while", "with", "yield",
]);
const LITERALS = new Set(["false", "None", "null", "true", "undefined"]);
const SOURCE_LANGUAGES = /^(?:[cm]?[jt]sx?|javascript|typescript|jsonc?|python|py|bash|sh|shell|zsh|css|scss|sql|go|rust|java|swift|kotlin|c|cpp|csharp)$/i;

/** A compact, deterministic highlighter: enough hierarchy for reading without HTML injection or a large runtime grammar. */
export function highlightCode(code: string, language: string): SyntaxToken[] {
  const normalized = language.toLowerCase();
  if (normalized === "diff" || normalized === "patch") return tokenizeDiff(code);
  if (!SOURCE_LANGUAGES.test(normalized)) return [{ kind: "plain", value: code }];

  const tokens: SyntaxToken[] = [];
  const pattern = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b|\b[A-Za-z_$][\w$]*\b|===|!==|=>|==|!=|<=|>=|&&|\|\||\+\+|--|\?\?|\?\.|[+\-*\/%=&|!<>?:~^]+|[{}[\](),.;])/gim;
  let cursor = 0;
  for (const match of code.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) pushToken(tokens, "plain", code.slice(cursor, index));
    const value = match[0];
    pushToken(tokens, classifyToken(value, code, index), value);
    cursor = index + value.length;
  }
  if (cursor < code.length) pushToken(tokens, "plain", code.slice(cursor));
  return tokens;
}

function classifyToken(value: string, source: string, index: number): SyntaxTokenKind {
  if (value.startsWith("//") || value.startsWith("/*") || value.startsWith("#")) return "comment";
  if (/^[`"']/.test(value)) return "string";
  if (/^(?:0x[\da-f]+|\d)/i.test(value)) return "number";
  if (KEYWORDS.has(value)) return "keyword";
  if (LITERALS.has(value)) return "literal";
  if (/^[A-Za-z_$]/.test(value)) return /^\s*\(/.test(source.slice(index + value.length)) ? "function" : "plain";
  if (/^[{}[\](),.;]$/.test(value)) return "punctuation";
  return "operator";
}

function tokenizeDiff(code: string): SyntaxToken[] {
  const lines = code.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [];
  return lines.map((value) => ({
    kind: value.startsWith("+++") || value.startsWith("---") || value.startsWith("@@") ? "meta"
      : value.startsWith("+") ? "addition"
        : value.startsWith("-") ? "deletion"
          : "plain",
    value,
  }));
}

function pushToken(tokens: SyntaxToken[], kind: SyntaxTokenKind, value: string): void {
  const previous = tokens.at(-1);
  if (previous?.kind === kind) previous.value += value;
  else tokens.push({ kind, value });
}

function reactText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!isValidElement<{ children?: ReactNode }>(node)) return "";
  return Children.toArray(node.props.children).map(reactText).join("");
}

function findOpenFence(text: string): { character: "`" | "~"; length: number } | null {
  let open: { character: "`" | "~"; length: number } | null = null;
  for (const line of text.split("\n")) {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(?:[^`]*)$/);
    if (!match) continue;
    const run = match[1]!;
    const character = run[0] as "`" | "~";
    if (!open) open = { character, length: run.length };
    else if (open.character === character && run.length >= open.length) open = null;
  }
  return open;
}

function projectIncompleteTable(text: string): string {
  const lines = text.split("\n");
  const last = lines.length - 1;
  const headerIndex = /^\s*\|.+\|\s*$/.test(lines[last] ?? "") ? last
    : last > 0 && /^\s*\|.+\|\s*$/.test(lines[last - 1] ?? "") && /^\s*\|?\s*:?-{0,2}/.test(lines[last] ?? "") ? last - 1
      : -1;
  if (headerIndex < 0 || isTableDelimiter(lines[headerIndex + 1] ?? "")) return text;
  lines[headerIndex] = (lines[headerIndex] ?? "").split("|").map((cell) => cell.trim()).filter(Boolean).join(" · ");
  if (headerIndex < last) lines[last] = "";
  return lines.join("\n");
}

function isTableDelimiter(line: string): boolean {
  const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function removeIncompleteLinkSyntax(text: string): string {
  return text
    .replace(/!\[([^\]\n]*)$/, "$1")
    .replace(/\[([^\]\n]+)\]\([^\)\n]*$/, "$1")
    .replace(/\[([^\]\n]*)$/, "$1");
}

function countDelimiter(text: string, delimiter: string): number {
  const escaped = delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...text.matchAll(new RegExp(`(?<!\\\\)${escaped}`, "g"))].length;
}

function countEmphasisUnderscores(text: string): number {
  return [...text.matchAll(/(?<![\\\p{L}\p{N}])_(?=\S)|(?<=\S)_(?![\p{L}\p{N}])/gu)].length;
}
