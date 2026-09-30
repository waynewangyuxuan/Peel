# Native transcript rendering optimization

Date: 2026-09-17
Ticket: `ticket-optimize-native-transcript-rendering`

## Outcome

Peel now reconciles complete App Server snapshots at the renderer boundary and preserves the object identity of unchanged settled Turns and ThreadItems. Memoized Turn, Item, and Markdown components therefore skip settled history while a live tail streams. Codex Thread, Turn, ThreadItem, request, completion, and lineage state remain authoritative; the optimization introduces no parallel conversation store.

Messages at or above 200,000 characters use the current renderer's inert, selectable plain-text fallback. The fallback preserves the exact source text, never interprets HTML, and never initiates remote media loads.

Streamdown and assistant-ui remain outside production Focus. Full virtualization, `content-visibility`, and bounded history backfill are also outside this implementation.

## Production App benchmark

Run the production-build Electron benchmark with:

```sh
npm run build --workspace @peel/desktop
npm run benchmark:transcript --workspace @peel/desktop
```

Unlike the earlier isolated renderer benchmark, this harness renders the ordinary `App → Focus → Transcript → MarkdownContent` route against the deterministic App Server fixture. The test-only `baseline` mode disables reconciliation and settled Markdown memoization, reproducing the previous full-snapshot invalidation path. The `optimized` mode is the production path.

Each mode runs two warmups followed by seven measured samples. Every sample records App Server `thread/read`, main-process snapshot construction, IPC delivery, renderer reconciliation, React render-to-layout-commit, commit-to-two-animation-frame paint, long tasks, DOM descendants, and precise heap readings when Chromium exposes them. Heap readings are diagnostics, not leak proof.

Final passing run, Mac Electron 44 / Chromium 152 production build:

| Scenario | Baseline median first content / through paint | Optimized median first content / through paint | Reading |
|---|---:|---:|---|
| Cold Focus, 10 Turns | 10.5 / 26.0 ms | 11.2 / 28.4 ms | +0.7 / +2.4 ms; inside the greater-of-10%-or-5ms limit |
| Cold Focus, 100 Turns | 64.1 / 69.5 ms | 65.4 / 70.0 ms | +1.3 / +0.5 ms; inside the limit |
| Cold Focus, 500 Turns | 295.6 / 314.9 ms | 289.8 / 309.0 ms | 5.8 / 5.9 ms faster |
| Warm switch, 10 → 500 Turns | 260.1 / 279.9 ms | 264.4 / 284.7 ms | +4.3 / +4.8 ms; inside the limit |

The 500-Turn optimized cold sample's representative median phase split was approximately 4.83 ms App Server read, 3.51 ms snapshot construction, 11 ms IPC delivery, 0 ms initial reconciliation, 270.4 ms React render-to-commit, and 18.4 ms post-commit paint. Baseline used approximately 5.01, 3.52, 11, 0, 275.6, and 18.3 ms respectively. Initial mount remains dominated by creating the full historical Focus DOM, not by App Server read time.

## Live-tail result

The streaming case starts with 100 completed Turns and replays exactly 36 `item/agentMessage/delta` notifications into a new live Turn.

| Measurement | Baseline | Optimized |
|---|---:|---:|
| Median reconciliation + React render/commit per delta | 36.25 ms | 1.50 ms |
| Relative reduction | — | 95.9% |
| Settled historical Turn renders per run | 2,600 median | 0 |
| Settled historical Markdown renders per run | 5,200 median | 0 |
| Live Turn / Markdown renders | affected tail only | affected tail only |
| Streaming long-task time | 0 ms | 0 ms |

The optimized renderer exceeds the Ticket's 50% reduction target while preserving exactly 36 measured deltas. Request and notice arrays remain independent of snapshot reconciliation; structural prop comparison invalidates only the owning Turn or the thread-level surface when their payload changes.

## Oversized and fidelity result

The production Focus case rendered all 200,086 fixture characters in one selectable local-overflow `<pre>`, created zero script/iframe/form/style elements, loaded zero remote images, and allowed a selection whose text exactly matched the source.

Fresh verification passed:

- 25 App Server tests;
- 12 Git workspace tests;
- 82 Desktop unit tests;
- Desktop typecheck and production renderer/main/preload/native build;
- native transcript production Electron benchmark;
- production Electron math-layout, exact Open Codex, server-request routing, and isolated renderer benchmark regressions.

The broad v0.1 journey progressed through all assertions before its existing line-903 session-resume expectation, where the fixture did not produce the expected “could not be resumed” alert. That test is not reported as passing; the failure occurs after the journey's Focus, Branch, Markdown, Draft/Scroll, attachment, Voice, streaming, request, scale, and restart checks and is unrelated to the transcript changes.

## Follow-up decision

A separate bounded-initial-backfill Ticket is justified, but it must not be folded into this implementation. The real optimized 500-Turn Focus entry still creates 29,506 transcript descendants, takes a 309.0 ms median through paint, and produces a roughly 263 ms median long task. App Server read plus snapshot construction is about 8.3 ms, so the remaining user-visible cost is now clearly historical DOM creation.

That follow-up must preserve exact Turn anchors and Branch actions, cross-history selection, image sizing, user-controlled follow-bottom, highlight navigation, and saved Scroll restoration. Full virtualization and `content-visibility` remain unjustified without those proofs.
