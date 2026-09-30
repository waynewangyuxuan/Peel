# Bounded Focus transcript backfill

Date: 2026-09-17
Ticket: `ticket-add-bounded-focus-history-backfill`

## Outcome

Long Focus transcripts now mount an anchor-aware window of 32 authoritative Codex Turns instead of constructing the complete historical DOM before first paint. Ordinary entry opens at the live tail; saved Scroll and highlighted Parent/Branch entry include their exact target before restoration is acknowledged. Older history is prepended through interruptible one-Turn transitions; the visible “Load earlier messages” control schedules the remaining history without requiring hundreds of clicks.

This is presentation state only. `ReducedThread` remains the complete source of truth; the renderer stores only the mounted index range and a `{ turnId, offset }` viewport anchor. It introduces no transcript cache, content truncation, Markdown replacement, `content-visibility`, or full virtualization.

## Production A/B result

Run the ordinary production Focus benchmark with:

```sh
npm run build --workspace @peel/desktop
npm run benchmark:transcript --workspace @peel/desktop
```

The Electron harness drives `App → Focus → Transcript → MarkdownContent`, with two warmups and seven measured samples for each full-mount baseline and bounded production mode. The final passing run used Mac Electron 44 / Chromium 152.

| Scenario | Full-mount median first content / through paint | Bounded median first content / through paint | Mounted result |
|---|---:|---:|---:|
| Cold Focus, 10 Turns | 10.9 / 31.0 ms | 9.9 / 21.5 ms | 10 / 10 |
| Cold Focus, 100 Turns | 74.9 / 86.5 ms | 29.1 / 34.0 ms | 32 / 100 |
| Cold Focus, 500 Turns | 329.6 / 380.9 ms | 42.6 / 48.0 ms | 32 / 500 |
| Warm switch, 10 → 500 Turns | 285.2 / 342.8 ms | 24.3 / 29.9 ms | 32 / 500 |

For 500 Turns, bounded first content is 12.9% of baseline and through-paint is 12.6% of baseline, comfortably below the 50% limits. Initial transcript descendants fall from 29,506 to 1,896, and no task of 50 ms or longer occurs before first content. The 10-Turn path improves; the 100-Turn path improves substantially.

The same run retains the previous live-tail optimization: 100 settled Turns plus exactly 36 deltas produce zero historical Turn or Markdown rerenders and no streaming long task. Every optimized sample explicitly proves the live Turn is visible, scrolling away from the bottom is respected, and returning to the bottom resumes follow behavior. The recorded median renderer cost was 1.6 ms versus 40.1 ms for baseline.

## Anchor, history, and restart proof

`bounded-transcript-backfill.spec.ts` runs the production Electron app against a separate deterministic 500-Turn fidelity fixture. Most Turns are ordinary prose, with code, math/CJK, reasoning, command, file change, subagent Activity, error, unknown item, local image, and remote image cases distributed through history. The high-density table-and-code fixture remains exclusive to the initial-mount A/B benchmark. The fidelity run proves:

- ordinary entry mounts the newest 32 Turns at the bottom;
- approaching the top and the explicit history control restore all 500 exact Turn IDs in one-Turn scheduled commits;
- browser Long Tasks observation records no 50 ms task during backfill, and each settled commit leaves the visible Turn anchor within one CSS pixel;
- while restoration is active, Composer editing, code copy, Branch open/cancel, exact Open in Codex dispatch, command approval response, error notice display, image attachment add/remove, and user scrolling remain operable;
- a live selection spanning several mounted Turns remains exact through prepend, and a later selection spans Turn 1 through Turn 500;
- the saved Turn-211 anchor returns within one CSS pixel after switching Threads and after fully closing and relaunching the app;
- a Child’s “Branched from” action mounts and highlights the exact Parent Turn 123 before exposing its persistent “Branch from here” action;
- after all history has backfilled, an early completed Turn still exposes and opens its exact Branch draft;
- local `data:` and `blob:` images retain bounded sizing, image settlement stays within the one-pixel anchor budget, and remote images remain click-only.

The existing production math-layout, exact Open in Codex, renderer safety/performance, and server-request routing E2Es also pass. Unit coverage preserves valid anchors, rejects malformed anchors, tests bounded-range selection, and keeps local-image URL policy explicit.

The broad v0.1 journey again completed its Focus, Branch, Draft/Scroll, attachment, Voice, streaming, request, scale, and restart checks before its pre-existing line-903 session-resume expectation failed because the fixture did not produce the expected “could not be resumed” alert. It is not reported as passing and did not fail in the transcript path.

## User-visible change

Opening a large Chat no longer presents a multi-hundred-millisecond blank or frozen interval while every old message is created. The newest conversation becomes readable almost immediately. Returning to a previous reading position or navigating from a Branch lands directly on that message without a temporary jump, while older content remains available progressively and ultimately selectable in full.
