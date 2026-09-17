import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ThreadItem } from "@peel/codex-app-server";

import { highlightCode, MarkdownContent, normalizeMathDelimiters } from "../src/renderer/Markdown";
import { ItemView, TurnActions } from "../src/renderer/Transcript";
import { plainTextPreview } from "../src/renderer/lib";

const LIVE_REDACTED_EXCERPT = `我们先把命题压实。

> **我们的护城河不是 AI 会写，而是你的 taste 能够通过一套可观测的生产系统被放大。**

> 人负责高杠杆决策和抽样验收；系统负责实现、检查、修复和定位风险。

| 软件工程 | 内容工程 |
| --- | --- |
| Product Spec | 故事命题、读者承诺、审美边界 |
| Tests | 连续性、时间线、人物动机 |`;

describe("MarkdownContent", () => {
  it("renders one persistent native Branch action only for completed turns", () => {
    const completed = renderToStaticMarkup(<TurnActions status="completed" onBranch={() => undefined}/>);
    expect(completed.match(/<button/g)).toHaveLength(1);
    expect(completed).toContain("Branch from here");
    expect(completed).not.toContain("peel-handle");
    expect(renderToStaticMarkup(<TurnActions status="inProgress" onBranch={() => undefined}/>)).not.toContain("<button");
  });
  it("turns Markdown into calm plain-text previews for spatial cards", () => {
    expect(plainTextPreview(`## Direction

> **A streamed result** for [this direction](https://example.com).

- Preserve \`Focus\`
- ~~Remove chrome~~`)).toBe("Direction A streamed result for this direction. Preserve Focus Remove chrome");
  });

  it("falls through empty text fields to authoritative summary and output fields", () => {
    expect(plainTextPreview("**ready**")).toBe("ready");
    const reasoning = {
      type: "reasoning",
      text: "",
      content: ["raw content must stay secondary"],
      summary: ["First", "Second"],
    } as unknown as ThreadItem;
    const command = { type: "commandExecution", text: "", aggregatedOutput: "exact output" } as unknown as ThreadItem;
    const reasoningHtml = renderToStaticMarkup(<ItemView item={reasoning} streamedText="" streaming={false} onOpenCodex={() => undefined}/>);
    expect(reasoningHtml).toContain("First");
    expect(reasoningHtml).toContain("Second");
    expect(reasoningHtml).not.toContain("raw content must stay secondary");
    expect(renderToStaticMarkup(<ItemView item={command} streamedText="" streaming={false} onOpenCodex={() => undefined}/>)).toContain("exact output");
  });

  it("renders CommonMark and GFM structures without executing raw HTML", () => {
    const html = renderToStaticMarkup(<MarkdownContent text={`# Plan

> Keep the conversation readable.

| Surface | Contract |
| --- | --- |
| Focus | **Full fidelity** |

1. Parse ordered lists
2. Preserve \`inline code\`

- [x] Render task lists
- [ ] Keep working

~~Legacy syntax~~ and [safe link](https://example.com).

<script>window.__peelUnsafe = true</script>

[unsafe link](javascript:alert(1))

\`\`\`ts
const safe = true;
\`\`\`
`}/>);

    expect(html).toContain("<table>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<ol>");
    expect(html).toContain("type=\"checkbox\"");
    expect(html).toContain("<del>Legacy syntax</del>");
    expect(html).toContain("<strong>Full fidelity</strong>");
    expect(html).toContain("class=\"markdown-code\"");
    expect(html).toContain("Copy code");
    expect(html).toContain(">ts</span>");
    expect(html).toContain("class=\"code-block\"");
    expect(html).toContain("class=\"syntax-keyword\">const</span>");
    expect(html).toContain("class=\"syntax-literal\">true</span>");
    expect(html).toContain("target=\"_blank\"");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
  });

  it("typesets Codex inline and display math as semantic accessible KaTeX", () => {
    const source = String.raw`Inline \(x^2 + \sqrt{y}\).

\[
\mathrm{Attention}(Q,K,V)=\mathrm{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}\right)V
\]`;
    const html = renderToStaticMarkup(<MarkdownContent text={source}/>);
    expect(html).toContain("class=\"katex\"");
    expect(html).toContain("class=\"katex-display\"");
    expect(html).toContain("<math");
    expect(html).toContain("<annotation encoding=\"application/x-tex\"");
    expect(html).toContain("aria-hidden=\"true\"");
    expect(html).toContain("Attention");
  });

  it("keeps incomplete streamed math readable and never parses code or trusted HTML commands as math markup", () => {
    const incomplete = String.raw`Before \[ \frac{QK^\top}{\sqrt{d_k}}`;
    expect(normalizeMathDelimiters(incomplete)).toBe(incomplete);
    const streamingHtml = renderToStaticMarkup(<MarkdownContent text={incomplete} streaming/>);
    expect(streamingHtml).toContain("frac");
    expect(streamingHtml).not.toContain("katex-display");

    const fenced = renderToStaticMarkup(<MarkdownContent text={"```text\n$x^2$ and \\[y\\]\n```"}/>);
    expect(fenced).toContain("markdown-code");
    expect(fenced).not.toContain("class=\"katex\"");

    const unsafe = renderToStaticMarkup(<MarkdownContent text={String.raw`$\htmlClass{evil}{x}$ <script>unsafe()</script>`}/>);
    expect(unsafe).not.toContain("class=\"evil\"");
    expect(unsafe).not.toContain("<script");

    const malformed = renderToStaticMarkup(<MarkdownContent text={String.raw`Malformed $\frac{$ remains readable.`}/>);
    expect(malformed).toContain("Malformed");
    expect(malformed).toContain("frac");
  });

  it("parses the exact quote and table shapes found in a real Codex Thread", () => {
    const html = renderToStaticMarkup(<MarkdownContent text={LIVE_REDACTED_EXCERPT}/>);
    expect(html.match(/<blockquote>/g)).toHaveLength(2);
    expect(html).toContain("<strong>我们的护城河不是 AI 会写");
    expect(html).toContain("<table>");
    expect(html).not.toContain("&gt; **");
    expect(html).not.toContain("| --- |");
  });

  it("renders nested prose structures, autolinks, and images with a safe policy", () => {
    const html = renderToStaticMarkup(<MarkdownContent text={`> Parent
>
> - Child
>   1. Nested

<https://example.com/path>

![remote diagram](https://example.com/diagram.png)

![inline image](data:image/png;base64,iVBORw0KGgo=)`}/>);
    expect(html.match(/<blockquote>/g)).toHaveLength(1);
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain("href=\"https://example.com/path\"");
    expect(html).toContain("class=\"markdown-image-link\"");
    expect(html).toContain("src=\"data:image/png;base64,iVBORw0KGgo=\"");
    expect(html).not.toContain("src=\"https://example.com/diagram.png\"");
  });

  it.each([
    ["unfinished emphasis", "**Planning a direction", "<strong>Planning a direction</strong>"],
    ["unfinished inline code", "Use `npm test", "<code>npm test</code>"],
    ["unfinished fenced code", "```ts\nconst ready = true;", "class=\"markdown-code\""],
    ["quote", "> Keep the control surface readable", "<blockquote>"],
    ["list", "- First direction\n- Second direction", "<ul>"],
    ["unfinished link", "Read [the spec](https://example.com/spec", "Read the spec"],
    ["unfinished table", "| Surface | Contract |", "Surface · Contract"],
  ])("keeps %s readable while streaming", (_label, source, expected) => {
    const html = renderToStaticMarkup(<MarkdownContent text={source} streaming/>);
    expect(html).toContain(expected);
    expect(html).toContain("Streaming response");
    if (_label === "unfinished link") expect(html).not.toContain("https://example.com/spec");
    if (_label === "unfinished table") expect(html).not.toContain("| Surface | Contract |");
  });

  it("routes every prose-bearing Thread item through Markdown while preserving technical output", () => {
    const proseItems = [
      { type: "userMessage", text: "> user" },
      { type: "agentMessage", text: "> agent" },
      { type: "reasoning", text: "> reasoning", status: "completed" },
      { type: "subAgentActivity", text: "> subagent", status: "completed" },
      { type: "error", message: "> error" },
    ] as unknown as ThreadItem[];
    for (const item of proseItems) {
      const html = renderToStaticMarkup(<ItemView item={item} streamedText="" streaming={false} onOpenCodex={() => undefined}/>);
      expect(html, item.type).toContain("class=\"markdown-body");
      expect(html, item.type).toContain("<blockquote>");
      expect(html, item.type).not.toContain("&gt; ");
    }

    const command = { type: "commandExecution", command: "printf '**raw**'", aggregatedOutput: "**raw**", status: "completed" } as unknown as ThreadItem;
    const commandHtml = renderToStaticMarkup(<ItemView item={command} streamedText="" streaming={false} onOpenCodex={() => undefined}/>);
    expect(commandHtml).toContain("class=\"technical-output\"");
    expect(commandHtml).toContain("Ran a command");
    expect(commandHtml).toContain("class=\"syntax-string\"");
    expect(commandHtml).toContain("**raw**");
    expect(commandHtml).not.toContain("<strong>raw</strong>");
  });

  it("renders live plan and reasoning streams as safe Markdown with visible activity state", () => {
    const plan = { id: "plan-1", type: "plan", status: "inProgress" } as unknown as ThreadItem;
    const planHtml = renderToStaticMarkup(<ItemView
      item={plan}
      streamedText={"- **Inspect**\n<script>unsafe()</script>"}
      streaming
      onOpenCodex={() => undefined}
    />);
    expect(planHtml).toContain("Planning");
    expect(planHtml).toContain("Working");
    expect(planHtml).toContain("<ul>");
    expect(planHtml).toContain("<strong>Inspect</strong>");
    expect(planHtml).toContain("Streaming response");
    expect(planHtml).not.toContain("<script>");

    const reasoning = { id: "reasoning-1", type: "reasoning", status: "inProgress" } as unknown as ThreadItem;
    const summaryHtml = renderToStaticMarkup(<ItemView
      item={reasoning}
      streamedText={"First summary\n\nSecond **summary**"}
      streamedReasoningContent="raw private fallback"
      streaming
      onOpenCodex={() => undefined}
    />);
    expect(summaryHtml).toContain("Thinking");
    expect(summaryHtml).toContain("First summary");
    expect(summaryHtml).toContain("<strong>summary</strong>");
    expect(summaryHtml).not.toContain("raw private fallback");

    const rawHtml = renderToStaticMarkup(<ItemView
      item={reasoning}
      streamedText=""
      streamedReasoningContent="Raw **fallback**"
      streaming
      onOpenCodex={() => undefined}
    />);
    expect(rawHtml).toContain("Raw <strong>fallback</strong>");
  });

  it("preserves live command output exactly as technical text", () => {
    const command = {
      id: "command-1",
      type: "commandExecution",
      command: "printf raw",
      status: "inProgress",
    } as unknown as ThreadItem;
    const html = renderToStaticMarkup(<ItemView
      item={command}
      streamedText={"  **raw**\nnext  \n"}
      streaming
      onOpenCodex={() => undefined}
    />);
    expect(html).toContain("Running a command");
    expect(html).toContain("  **raw**\nnext  \n");
    expect(html).not.toContain("<strong>raw</strong>");
  });

  it("adds safe visual hierarchy to source and diff code without changing its text", () => {
    const source = "const ready = true; // shipped\n";
    const sourceTokens = highlightCode(source, "ts");
    expect(sourceTokens.map((token) => token.value).join("")).toBe(source);
    expect(sourceTokens.map((token) => token.kind)).toEqual(expect.arrayContaining(["keyword", "literal", "comment"]));

    const patch = "@@ -1 +1 @@\n-old\n+new\n";
    const patchTokens = highlightCode(patch, "diff");
    expect(patchTokens.map((token) => token.value).join("")).toBe(patch);
    expect(patchTokens.map((token) => token.kind)).toEqual(["meta", "deletion", "addition"]);
  });
});
