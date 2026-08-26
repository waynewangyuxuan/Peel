import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownContent } from "../src/renderer/Markdown";

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
    expect(html).toContain("class=\"code-block\"");
    expect(html).toContain("target=\"_blank\"");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
  });

  it("keeps partial streaming Markdown legible", () => {
    const html = renderToStaticMarkup(<MarkdownContent text={"**Planning a direction\nnext line"} streaming/>);
    expect(html).toContain("Planning a direction");
    expect(html).toContain("<br/>");
    expect(html).toContain("Streaming response");
  });
});
