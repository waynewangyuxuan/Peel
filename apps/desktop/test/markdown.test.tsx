import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ThreadItem } from "@peel/codex-app-server";

import { MarkdownContent } from "../src/renderer/Markdown";
import { ItemView } from "../src/renderer/Transcript";

const LIVE_REDACTED_EXCERPT = `我们先把命题压实。

> **我们的护城河不是 AI 会写，而是你的 taste 能够通过一套可观测的生产系统被放大。**

> 人负责高杠杆决策和抽样验收；系统负责实现、检查、修复和定位风险。

| 软件工程 | 内容工程 |
| --- | --- |
| Product Spec | 故事命题、读者承诺、审美边界 |
| Tests | 连续性、时间线、人物动机 |`;

describe("MarkdownContent", () => {
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
    expect(html).toContain("target=\"_blank\"");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
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
    expect(commandHtml).toContain("class=\"activity-output\"");
    expect(commandHtml).toContain("**raw**");
    expect(commandHtml).not.toContain("<strong>raw</strong>");
  });
});
