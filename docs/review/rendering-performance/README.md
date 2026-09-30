# Rendering runtime evaluation

Date: 2026-09-17
Ticket: `ticket-evaluate-streamdown-rendering-runtime`

## Decision

Defer Streamdown as Peel's production Markdown renderer. Keep the checked-in candidate and production-Electron benchmark as an isolated evaluation surface, but do not route Focus through it.

The candidate is safe and can be adapted to Peel's accepted content contract, yet it does not produce a material end-to-end performance win on the measured transcript shapes. In the final instrumented run, at 500 Turns it was 15.0% slower to mount and 22.4% slower to switch into than the current renderer. It allocated about 11.0 MB while mounting that case versus 4.0 MB for the current renderer. Its long-stream p99 frame interval was better in this run (16.8 ms versus 25.4 ms), but total stream time was effectively tied and neither renderer produced a streaming long task. That isolated improvement does not justify replacing a renderer whose security, math geometry, code copy, media, and streaming projection behavior Peel already owns.

Do not evaluate the assistant-ui runtime next. It would introduce a second conversation model around Codex Thread, Turn, and ThreadItem without addressing the measured bottleneck. Revisit only if Peel later needs assistant-ui's interaction primitives and first defines a lossless adapter that keeps Codex lifecycle and Peel state authoritative.

## What was measured

Run the repeatable production-build Electron comparison with:

```sh
npm run build --workspace @peel/desktop
npm run benchmark:rendering --workspace @peel/desktop
```

`PEEL_RENDERING_BENCHMARK=1` loads a dynamically imported benchmark page. Ordinary Focus continues to load the existing `App` and `MarkdownContent`. The harness deliberately bypasses App Server thread reads, reports `threadReadMs: 0`, times corpus construction separately as reducer work, records Markdown/render work through React's layout-effect commit marker, and then records the remaining commit-to-two-animation-frame paint interval. It also records long tasks, frame intervals, DOM nodes, heap delta and post-unmount heap, session switching, and row render counts.

The corpus covers complete and incomplete Markdown; headings; nested and task lists; tables; blockquotes; hardened links; citation-shaped content; short, diff, and 160-line fenced code; both reported CJK/math layouts; unsafe HTML; remote and embedded media; bidi/CJK prose; malformed syntax; large technical output; a response over 200,000 characters; and 10/100/500-Turn transcripts.

## Representative result

Mac Electron 44 / Chromium 152 production build, final passing run:

| Measurement | Current | Streamdown candidate | Reading |
|---|---:|---:|---|
| Cold first content, 10 Turns | 42.4 ms | 25.4 ms | Candidate wins this ordered sample; module loading is already complete |
| Warm first content, 10 Turns | 15.6 ms | 16.7 ms | Equivalent |
| Mount 100 Turns | 48.9 ms | 58.3 ms | Candidate 19.2% slower |
| 500-Turn Markdown + React commit | 132.3 ms | 161.6 ms | Candidate 22.1% slower before post-commit paint |
| Mount 500 Turns through paint | 174.9 ms | 201.2 ms | Candidate 15.0% slower; both create a long task |
| Switch 10 → 500 Turns | 158.5 ms | 194.0 ms | Candidate 22.4% slower |
| 500-Turn DOM descendants | 9,311 | 9,977 | Candidate 7.2% higher |
| 500-Turn heap delta | 4.0 MB | 11.0 MB | Candidate materially higher; post-unmount retained estimates were both under 0.6 MB |
| 36 streaming updates | 609.0 ms | 599.5 ms | Equivalent total time |
| Streaming p95 / p99 frame | 18.6 / 25.4 ms | 16.8 / 16.8 ms | Candidate has the steadier tail in this run |
| Streaming long-task time | 0 ms | 0 ms | Both stay below the long-task threshold |
| History row rerenders | 0 | 0 | Stable identity works |
| Tail row rerenders | 36 | 36 | Only the live tail invalidates |

Heap delta is Chromium's precise heap estimate, not a proof of a leak. The post-unmount readings are noisy because collection and module initialization differ; the useful result is that neither candidate retained the large mount delta after unmount.

The candidate passed the shared content assertions: eight corpus sections, three semantic/selectable KaTeX display blocks, no clipped math, exact visible and copied code, no page-wide overflow, readable partial Markdown, hardened external links, no remote `<img>` fetch, one explicitly allowed embedded image, no script/event execution, a readable over-200k fallback, and a message-local error fallback.

Accessibility is acceptable for an isolated candidate, not yet proven for production Focus. It keeps native headings, lists, tables, links, buttons, selectable text, and KaTeX HTML/MathML; `dir="auto"` handles bidi blocks; table and code overflow remain local; and copy controls retain native button titles. The harness also verifies readable fallback text instead of blank content. It does not prove the complete Focus keyboard order, screen-reader announcements during streaming, selection across deferred history, exact-Turn navigation, or saved Scroll restoration. Those remain mandatory acceptance evidence for any future production integration.

## Bundle and dependency cost

The benchmark is code-split. Compared with the pre-spike build, the ordinary renderer entry moved from 702.21 kB / 212.18 kB gzip to 704.05 kB / 212.97 kB gzip. The opt-in benchmark candidate adds a 359.33 kB / 112.14 kB gzip chunk to packaged assets.

`streamdown@2.5.0`, `@streamdown/math@1.0.2`, and `@streamdown/cjk@1.0.3` are Apache-2.0, which is acceptable. Installation added 136 packages. Although Peel does not enable Mermaid, Streamdown declares it as a dependency; the installed Mermaid tree occupies about 88 MB. The candidate also participates in a KaTeX 0.16 plugin chain while Peel directly owns KaTeX 0.18. These are acceptable for a dev-only spike but unattractive for a production migration without a demonstrated win.

Streamdown's official API provides streaming repair, block splitting/memoization, sanitization, math/CJK plugins, and custom components. Those are useful capabilities, but open upstream reports also document live-stream math edge cases and Mermaid's unconditional install cost. They reinforce keeping Peel's adapter and fallback boundary even if the decision changes later.

## Peel semantic boundary

The prototype replaces only the prose renderer inside a synthetic row. It does not convert Codex state into a generic assistant message store. A production adoption would have to leave all of these in Peel-owned `Transcript` and item components:

- Codex Thread, Turn, ThreadItem identity and lifecycle;
- approvals, server requests, commands, file changes, Activity, attachments, and unknown-item fallback;
- exact completed-Turn `Branch from here` anchors;
- saved Draft and Scroll state;
- Space membership and thread lineage.

Because the candidate is not connected to Focus, the spike cannot regress those semantics. This is also why a broad assistant-ui runtime migration is out of scope and currently unjustified.

## Techniques to carry forward

| Technique | Decision | Evidence / boundary |
|---|---|---|
| Stable Turn row identity | Adopt in a native follow-up | The harness measured zero historical rerenders during all 36 tail updates |
| Tail-only streaming invalidation | Adopt in a native follow-up | Both renderers stayed at exactly 36 tail renders |
| Render-cost first paint and bounded backfill | Defer pending a production `Transcript` trace | The final 500-Turn mount was 174.9 ms current and 201.2 ms candidate through paint, so the technique is promising, but the synthetic surface does not prove Scroll/Branch behavior |
| Memoized settled Markdown/math | Adopt with stable Turn rows | Avoids reparsing unchanged settled history without changing renderer ownership |
| Lazy heavy syntax engine | Reject for now | Peel's deterministic highlighter is small; the spike did not enable Shiki and found no need to pay for it |
| `content-visibility` on settled history | Defer | Requires exact selection, anchor navigation, image sizing, and Scroll restoration evidence |
| Readable size fallback at 200k characters | Adopt | Candidate proves a bounded, selectable plain-text fallback that cannot blank Focus |
| Full transcript virtualization | Reject until proven | No evidence yet covers prepend anchors, exact Turn navigation, selection, images, or restored Scroll |

The smallest justified production follow-up is not a Streamdown migration. It is a native transcript-cost Ticket: memoize settled Turn rows, preserve stable item objects during tail deltas, add the readable 200k fallback to the current renderer, and measure the real Focus surface before considering bounded backfill. No production implementation was made in this decision spike.

## References

- [Hermes Markdown renderer](https://github.com/NousResearch/hermes-agent/blob/main/apps/desktop/src/components/assistant-ui/markdown-text.tsx)
- [Hermes thread list and render-budget approach](https://github.com/NousResearch/hermes-agent/blob/main/apps/desktop/src/components/assistant-ui/thread/list.tsx)
- [Hermes desktop performance harness](https://github.com/NousResearch/hermes-agent/blob/main/apps/desktop/scripts/perf/README.md)
- [Streamdown package and documentation](https://github.com/vercel/streamdown)
- [Streamdown plugin reference](https://github.com/vercel/streamdown/blob/main/skills/streamdown/references/plugins.md)
- [Upstream live-stream math report](https://github.com/vercel/streamdown/issues/601)
- [Upstream Mermaid dependency-size report](https://github.com/vercel/streamdown/issues/501)
