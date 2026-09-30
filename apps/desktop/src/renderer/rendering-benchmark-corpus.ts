export interface RenderingCorpusCase {
  id: string;
  label: string;
  markdown: string;
  streaming?: boolean;
}

const TECHNICAL_OUTPUT = Array.from({ length: 80 }, (_, index) =>
  `${String(index + 1).padStart(3, "0")}. \`src/module-${index + 1}.ts\` — ${index % 3 === 0 ? "changed" : "checked"} with result \`${index % 7 === 0 ? "warning" : "ok"}\`.`
).join("\n");

const LONG_CODE_OUTPUT = Array.from({ length: 160 }, (_, index) =>
  `const value${index + 1} = transform(input[${index}], { safe: true });`
).join("\n");

export const expectedCopiedCode = [
  "export function greeting(name: string): string {",
  "  return `Hello, ${name}`;",
  "}",
].join("\n");

export const renderingCorpus: RenderingCorpusCase[] = [
  {
    id: "complete-markdown",
    label: "Complete Markdown",
    markdown: [
      "# Rendering contract",
      "",
      "Paragraph with **strong**, *emphasis*, ~~deleted~~, `inline code`, and [a safe link](https://example.com/docs?q=peel).",
      "",
      "- First item",
      "  - Nested item",
      "- [x] Finished task",
      "",
      "> A quoted result",
      "> with a second line.",
      "",
      "| Surface | Status |",
      "|:--|--:|",
      "| Markdown | Ready |",
      "| Streaming | Active |",
      "",
      "Footnote-style citation [1] and an autolink <https://example.com/reference>.",
    ].join("\n"),
  },
  {
    id: "math-cjk",
    label: "Math and CJK scripts",
    markdown: [
      "Inline math: \\(E = mc^2\\).",
      "",
      "\\[Q_h = XW_h^Q,\\]",
      "",
      "\\[q_{水果}^{(1)} \\cdot k_{外卖}^{(1)}\\]",
      "",
      "\\[q_{外卖}^{(2)} \\cdot k_{公司}^{(2)}\\]",
    ].join("\n"),
  },
  {
    id: "code",
    label: "Code and diff",
    markdown: [
      "```typescript",
      expectedCopiedCode,
      "```",
      "",
      "```diff",
      "-const stale = true;",
      "+const streaming = true;",
      "```",
      "",
      "A deliberately long fenced block:",
      "",
      "```typescript",
      LONG_CODE_OUTPUT,
      "```",
    ].join("\n"),
  },
  {
    id: "partial-markdown",
    label: "Partial streaming Markdown",
    streaming: true,
    markdown: "A streaming answer with **unfinished emphasis and a [partial link](https://example.com",
  },
  {
    id: "unsafe-html-media",
    label: "Unsafe HTML and remote media",
    markdown: [
      "<script>window.__peelUnsafeHtmlExecuted = true</script>",
      "<img src=\"https://example.com/tracker.png\" onerror=\"window.__peelUnsafeImageExecuted=true\">",
      "",
      "![Remote diagram](https://example.com/remote.png)",
      "",
      "![Embedded pixel](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==)",
    ].join("\n"),
  },
  {
    id: "bidi-cjk",
    label: "Bidirectional and CJK prose",
    markdown: "中文标点（应该紧凑），English text, العربية: مرحبًا بالعالم، Hebrew: שלום עולם. 文件路径 `src/渲染/render.tsx`。",
  },
  {
    id: "malformed",
    label: "Malformed input",
    streaming: true,
    markdown: "```json\n{\"open\": true,\n\n| incomplete | table |\n| --\n\n\\[x_{未完成}^{(3)}",
  },
  {
    id: "large-technical-output",
    label: "Large technical output",
    markdown: `## Repository scan\n\n${TECHNICAL_OUTPUT}\n\nDone.`,
  },
];

export const oversizedMarkdown = `# Oversized response\n\n${"safe-text-内容 ".repeat(16_000)}`;

const transcriptSamples = [
  "Short answer with **useful emphasis** and `inline code`.",
  "## Result\n\n- Parsed input\n- Applied change\n- Verified output",
  "The relation is \\(Q_h = XW_h^Q\\), with 中文上下文。",
  "```typescript\nconst ready: boolean = true;\n```",
  "| Metric | Value |\n|---|---:|\n| latency | 18 ms |\n| frames | 60 fps |",
  "> Keep the renderer safe, deterministic, and readable.",
];

export interface BenchmarkTurn {
  id: string;
  text: string;
}

export function buildBenchmarkTurns(count: number): BenchmarkTurn[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `turn-${index}`,
    text: `${transcriptSamples[index % transcriptSamples.length]}\n\nTurn ${index + 1} of ${count}.`,
  }));
}

export const streamingBenchmarkText = [
  renderingCorpus[0]!.markdown,
  renderingCorpus[1]!.markdown,
  renderingCorpus[2]!.markdown,
  renderingCorpus[7]!.markdown,
].join("\n\n");
