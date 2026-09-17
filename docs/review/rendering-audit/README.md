# Codex rendering surface audit

Date: 2026-09-16

Ticket: `ticket-audit-codex-rendering-surface`

Audited runtime: `codex-cli 0.154.0`

## Executive result

Peel has a sound safety baseline and a good completed-prose baseline, but it is not yet a full-fidelity Codex client. The largest gaps are protocol routing and live lifecycle fidelity, not executable HTML:

1. Current App Server item and request variants mostly fall through to a generic JSON disclosure. Several live delta methods are not accumulated because the reducer recognizes only method names ending in the exact lowercase suffix `/delta`.
2. User attachments and structured inputs are accepted by the composer but disappear from the persisted transcript because only text parts are extracted.
3. Thread-scoped server requests are funneled into command/file approval UI even when they require user-input, permission, MCP elicitation, or dynamic-tool responses; host and legacy requests without `params.threadId` remain invisible and unresolved. Both routes violate the current method-specific response contracts.
4. CommonMark/GFM, safe links, code, tables, blockquotes, lists, and conservative images work. Math does not. Raw HTML is deliberately discarded and should remain disabled until a separate product/security decision demonstrates a real payload need.
5. Full-thread refreshes and full Markdown reparsing on streaming notifications create an unbounded large-thread performance risk. This audit does not attribute the reported two-second initial load to rendering without a profile; thread-read/startup latency remains a separate measured concern.

The immediate implementation sequence should therefore be: lifecycle/request correctness, structured user input and semantic item routes, the already reported math defect, then measured rendering performance and accessibility hardening. HTML is not an immediate implementation ticket.

## Authority and method

The audit used four evidence layers:

- The [official Codex App Server documentation](https://developers.openai.com/codex/app-server), especially its `ThreadItem`, lifecycle, delta, review, error, and approval contracts.
- TypeScript generated from the exact installed binary with both `codex app-server generate-ts --out ...` and `--experimental`. The stable and experimental `v2/ThreadItem.ts` files were byte-identical at SHA-256 `ee25d621ee645f49a88e494effcdf625d88cc229edbb184827d8cf4c135ff6f4`.
- Source inspection of Peel's protocol adapter, reducer, renderer, Electron boundary, fixtures, and tests.
- A content-free observation of the most recent 200 local session files, counting only completed item type names. No prompt, response, path, or tool argument content was copied into the repository.

The local observation found these completed persisted item types: AgentMessage 1,654; CollabAgentToolCall 39; CommandExecution 3,992; ContextCompaction 80; DynamicToolCall 4; Extension 15; FileChange 358; ImageView 35; McpToolCall 92; Reasoning 4,732; SubAgentActivity 70; UserMessage 944. Content-free representative key/type structures are checked in as [`sanitized-local-payload-shapes.json`](./sanitized-local-payload-shapes.json). Scalar values and dynamic map keys were removed, so the artifact records shape without retaining prompts, responses, paths, arguments, IDs, or account data. These stored shapes use internal PascalCase and snake_case names and are observation evidence only; the generated App Server schema remains wire authority. The sample demonstrates that the generic fallback is routinely exercised, not that it represents every user or future Codex version.

Reproduction commands:

```sh
/opt/homebrew/bin/codex --version
/opt/homebrew/bin/codex app-server generate-ts --out /tmp/<stable>
/opt/homebrew/bin/codex app-server generate-ts --experimental --out /tmp/<experimental>
diff -u /tmp/<stable>/v2/ThreadItem.ts /tmp/<experimental>/v2/ThreadItem.ts
rg --files /Users/bytedance/.codex/sessions | sort | tail -n 200 | xargs jq -r 'select(.type == "event_msg" and .payload.type == "item_completed") | .payload.item.type // empty' | sort | uniq -c
```

## Content contract inventory

The official contract describes `ThreadItem` as a tagged union delivered by turn responses and `item/*` lifecycle notifications. Completed `item/completed` payloads are authoritative; streamed text is provisional. The installed 0.154 stable union is broader than the documentation's “common types” list.

There is no standalone HTML item in either authority. `agentMessage` and `plan` carry text; HTML, Markdown, math, links, and media syntax inside that text are renderer policy, not separate App Server protocol capabilities.

Installed stable `ThreadItem` variants:

| Variant | Important content | Stability note |
| --- | --- | --- |
| `userMessage` | text, image, local image, audio, local audio, skill, mention inputs | Stable union; docs show the common text/image subset. |
| `hookPrompt` | text fragments with hook run IDs | Present in stable generated union; omitted from docs' common list. |
| `agentMessage` | text, optional phase, memory citation, delivery, questions | Phase can be commentary or final answer; providers may omit it. |
| `functionCallOutput` | string or text/image/audio/encrypted output parts | Stable union. |
| `plan` | text | Final completed item is authoritative over deltas. |
| `reasoning` | summary sections and raw content sections | Summary and raw text have distinct delta methods. |
| `commandExecution` | command, cwd, actions, status, output, exit/duration | Output has a camel-cased `outputDelta` event. |
| `fileChange` | path/kind/diff changes and status | `turn/diff/updated` is the aggregate authority. |
| `mcpToolCall` | server/tool/arguments/status/result/error/app context | New metadata can be absent in older persisted items. |
| `dynamicToolCall` | namespace/tool/arguments/status/text-image-audio outputs | Corresponding dynamic tool call flow is documented as experimental. |
| `collabAgentToolCall` | tool, sender/receivers, prompt, model, agent states | Installed name differs from the docs' shorter `collabToolCall` wording. |
| `subAgentActivity` | kind, agent thread/path | Present in stable generated union. |
| `webSearch` | query, action, optional opaque results | Search/open/find actions are structured. |
| `imageView` | local path | Must not imply automatic disclosure or remote upload. |
| `sleep` | duration | Present in stable generated union; omitted from common list. |
| `imageGeneration` | status, prompt, result, failure, optional saved path | Potentially very large result data. |
| `enteredReviewMode` | review label | Lifecycle marker. |
| `exitedReviewMode` | final review prose | Docs explicitly direct clients to render this output. |
| `contextCompaction` | ID | Replaces the deprecated `thread/compacted` notification. |

The stable and experimental generated `ThreadItem` unions are identical. That does not make every surrounding API stable: the official docs explicitly call the dynamic tool request flow experimental, and generated types separately label some approval auto-review fields unstable.

## Peel route matrix

The structural protocol type is intentionally open (`type: string`), so unknown data survives the adapter. That is a useful compatibility property, but the renderer currently has only six semantic branches.

| Shape | Current reducer/renderer route | Streaming and completion | Fallback and coverage | Assessment |
| --- | --- | --- | --- | --- |
| `userMessage` text | `itemText` -> `MarkdownContent` user bubble | Completed snapshot; no user delta | Markdown unit + Electron coverage | Good for text. |
| `userMessage` image/audio/skill/mention | Non-text parts ignored by `itemText` | Completed snapshot | Empty item becomes “User message”; no persisted attachment test | **Gap:** sent context disappears visually. |
| `hookPrompt` | Generic technical JSON | Item lifecycle only | Unknown-item fallback only | Safe but not readable. |
| `agentMessage` | `MarkdownContent` | `/agentMessage/delta` works; completed item replaces deltas | Strong Markdown and streaming tests | Good baseline; `phase`, citations, delivery, and questions are ignored. |
| `functionCallOutput` | Generic technical disclosure | Item lifecycle; no dedicated delta | No type-specific test | Text can appear; media/encrypted parts are not semantically represented. |
| `plan` | Generic technical disclosure | `/plan/delta` happens to match lowercase `/delta`; final item replaces it | No type-specific test | Content survives but is mislabeled and visually technical. |
| `reasoning` | Markdown disclosure; `summary` wins over `content` | `summaryTextDelta` and `textDelta` do **not** match lowercase `/delta` and are ignored | Completed Reasoning is covered | **Gap:** live reasoning is incomplete; summary/content provenance is collapsed. |
| `commandExecution` | Command/output `TechnicalOutput` | `outputDelta` does **not** match lowercase `/delta`; completion is authoritative | Completed/failed commands covered | **Gap:** live output is lost until a refresh/completion. |
| `fileChange` | Per-file diff `TechnicalOutput`; aggregate diff kept separately | Deprecated `outputDelta` ignored; completed item and `turn/diff/updated` work | Completed file change covered | Appropriate for current contract. |
| `mcpToolCall` | Generic JSON disclosure | Started/completed only | Real local occurrences; no renderer test | High-frequency readability gap; large results may create huge DOM text. |
| `dynamicToolCall` | Generic JSON disclosure | Started/completed only | Real local occurrences; no renderer test | Text/image/audio outputs are not represented. |
| collaboration/subagent | Markdown disclosure around `itemText` or full JSON | Started/completed only | Completed fixture + Electron coverage | Basic status works; prompt/results are often noisy JSON. |
| `webSearch` | Generic JSON disclosure | Started/completed only | Historical local occurrences; no type-specific test | Query/action/result/citations lack semantic presentation. |
| `imageView` | Generic JSON with local path | Started/completed only | Real local occurrences; no type-specific test | No preview/open policy; raw local path is exposed in disclosure. |
| `sleep` | Generic JSON disclosure | Started/completed only | No test | Low impact. |
| `imageGeneration` | Generic JSON disclosure, including result | Started/completed only | No test | **Risk:** a large encoded result can be serialized into the DOM. |
| review enter/exit | Generic JSON disclosure | Started/completed only | No test | **Gap:** final review prose is not rendered as prose despite explicit docs guidance. |
| `contextCompaction` | Generic JSON disclosure | Started/completed only | Real local occurrences; no type-specific test | Content is safe but needlessly technical. |
| turn error | Only turn status label; `turn.error` has no message surface | Turn completion is authoritative | Synthetic legacy `error` item is tested, not current turn error | **Gap:** actionable failure detail can disappear. |
| unknown future item | Generic exact JSON + “Open in Codex” | Started/completed, generic lowercase deltas only | Unit/Electron fallback coverage | Preserve until a semantic route is proven. |
| v2 command/file approval | Requests with matching `params.threadId` become cards after all turns | Removed only after a local button response; resolved notification is not consumed | Electron journey covers basic command approval | Basic response path exists; network/grant-root detail and exact-turn anchoring are missing. |
| other thread-scoped server request | Requests with matching `params.threadId` also become the same card | Non-file requests answer as command decisions | No coverage | **Correctness gap:** presentation and response schema are wrong. |
| host/legacy request without `params.threadId` | Stored in approval state but excluded from the active-thread card filter | No host callback or explicit rejection | No coverage | **Correctness gap:** request can remain unresolved and invisible. |

Reducer details:

- `item/completed` correctly clears provisional deltas and replaces the started item.
- The generic delta branch checks `startsWith("item/") && endsWith("/delta")`. This recognizes `item/agentMessage/delta` and `item/plan/delta`, but not `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`, `item/commandExecution/outputDelta`, or the deprecated `item/fileChange/outputDelta` because `Delta` is capitalized. `item/reasoning/summaryPartAdded` is also ignored, so section boundaries cannot be reconstructed even if text deltas are later added.
- App notification handling then schedules a full `readThread` refresh, so some missing live state can appear later. That fallback is neither a substitute for ordered streaming nor a guarantee that the interim UI is accurate.

### Complete stable ServerRequest routing

Transport forwards every generated stable `ServerRequest` to the renderer. `App.tsx` stores every request in one `approvals` array, but `Transcript` receives only entries whose `params.threadId` equals the active Thread. The card distinguishes only method names containing `fileChange`; every other visible request is labeled and answered as a command approval. The resulting per-method matrix is:

| Stable method | Current Peel route | Required route |
| --- | --- | --- |
| `item/commandExecution/requestApproval` | Visible on matching Thread; command card; command decision | Keep, but distinguish command/stdin/network kinds, available decisions, amendments, and exact Turn. |
| `item/fileChange/requestApproval` | Visible on matching Thread; file card; file decision | Keep, add reason/grant-root semantics and exact Turn. |
| `item/tool/requestUserInput` | Visible as command approval; sends invalid command decision | Render questions/options and answer with the user-input response contract. |
| `mcpServer/elicitation/request` | Visible as command approval; sends invalid command decision | Render form/URL elicitation and accept/decline/cancel with validated content. |
| `item/permissions/requestApproval` | Visible as command approval; sends invalid command decision | Render requested filesystem/network subset and respond with grants plus scope. |
| `item/tool/call` | Visible as command approval; sends invalid command decision | Dispatch to the registered dynamic tool implementation and return tool output; never present as user approval unless the tool contract requires it. |
| `account/chatgptAuthTokens/refresh` | No `threadId`; invisible and unresolved | Handle through an explicit host auth callback or reject deterministically as unsupported. |
| `attestation/generate` | No `threadId`; invisible and unresolved | Handle through an explicit attestation provider or reject deterministically as unsupported. |
| `applyPatchApproval` (legacy) | Uses `conversationId`; invisible and unresolved | Normalize to legacy file approval or explicitly opt out/reject. |
| `execCommandApproval` (legacy) | Uses `conversationId`; invisible and unresolved | Normalize to legacy command approval or explicitly opt out/reject. |

`serverRequest/resolved` is a notification rather than a request. It currently causes a Thread refresh when it has a `threadId`, but it does not remove the matching pending card. Only Peel's own button handler removes a request, so server-side cleanup or auto-resolution can leave stale UI.

### Complete stable notification routing

All generated stable notifications enter the same client listener. The reducer first rejects notifications without `threadId`; its semantic switch handles only Thread status/name, Turn start/completion/diff, item start/completion, and the two lowercase `/delta` methods. The renderer then ignores notifications without `params.threadId`; notifications with one schedule a full Thread read, with `thread/name/updated` receiving one additional title mutation. There is no other notification-specific presentation.

The exact 0.154 stable union is inventoried below by current route:

- **Semantic reducer route:** `thread/status/changed`, `thread/name/updated`, `turn/started`, `turn/completed`, `turn/diff/updated`, `item/started`, `item/completed`, `item/agentMessage/delta`, `item/plan/delta`.
- **Known content/lifecycle notifications with no semantic reducer route:** `error`, `warning`, `configWarning`, `guardianWarning`, `deprecationNotice`, `turn/plan/updated`, `turn/moderationMetadata`, `hook/started`, `hook/completed`, `item/reasoning/summaryTextDelta`, `item/reasoning/summaryPartAdded`, `item/reasoning/textDelta`, `item/commandExecution/outputDelta`, `item/commandExecution/terminalInteraction`, `item/fileChange/outputDelta`, `item/fileChange/patchUpdated`, `item/mcpToolCall/progress`, `item/autoApprovalReview/started`, `item/autoApprovalReview/completed`, `autoApprovalReview/strictReviewRequired`, `serverRequest/resolved`, `thread/compacted`, `thread/tokenUsage/updated`, `thread/queue/changed`, `thread/goal/updated`, `thread/goal/cleared`, `thread/project/updated`, `thread/environment/connected`, `thread/environment/disconnected`, `thread/settings/updated`, `model/rerouted`, `model/safetyBuffering/updated`, `model/verification`, `modelProvider/authRecoveryStarted`, `modelProvider/authRecoveryCompleted`, and `rawResponseItem/completed`, `rawResponse/completed`. If they carry a string `threadId`, the UI merely rereads the Thread; otherwise it ignores them.
- **Thread/global lifecycle with no dedicated presentation:** `thread/started`, `thread/archived`, `thread/unarchived`, `thread/closed`, `thread/deleted`, `thread/reverted`, `project/changed`, `skills/changed`, `account/updated`, `account/rateLimits/updated`, `account/login/completed`, `app/list/updated`, `remoteControl/status/changed`, `mcpServer/oauthLogin/completed`, `mcpServer/startupStatus/updated`, `mcpServer/event/stream/notification`, `externalAgentConfig/import/progress`, `externalAgentConfig/import/completed`, `fs/changed`, `fuzzyFileSearch/sessionUpdated`, `fuzzyFileSearch/sessionCompleted`, `windows/worldWritableWarning`, and `windowsSandbox/setupCompleted`. Their only possible renderer effect is the generic `threadId` refresh rule.
- **Standalone process and realtime paths with no Transcript item route:** `command/exec/outputDelta`, `process/outputDelta`, `process/exited`, `thread/realtime/started`, `thread/realtime/itemAdded`, `thread/realtime/item/started`, `thread/realtime/item/transcript/delta`, `thread/realtime/item/completed`, `thread/realtime/transcript/delta`, `thread/realtime/transcript/done`, `thread/realtime/outputAudio/delta`, `thread/realtime/sdp`, `thread/realtime/error`, and `thread/realtime/closed`. Realtime dictation uses a separate service path; these notifications are not rendered as normal Transcript items.

The top-level `error` notification contains `threadId`, `turnId`, structured error detail, and `willRetry`. Peel rereads the Thread but never creates an error surface from the notification; a later failed Turn shows only “Needs attention” unless an older/synthetic `error` item happens to exist. `warning` and the other warning variants likewise have no visible message route.

## Prose, format, and media matrix

| Surface | Completed behavior | Streaming behavior | Desired safe boundary |
| --- | --- | --- | --- |
| CommonMark/GFM | Headings, emphasis, strike, autolinks, tables, blockquotes, ordered/nested/task lists work. | Heuristics close incomplete emphasis, code, links, and table headers. | Retain and add representative malformed-input regressions. |
| Raw HTML | `skipHtml` discards it. | Discarded. | Keep disabled. Consider only a separately approved, sanitized static subset with CSP tests after real payload evidence. Never allow script, iframe, event handlers, forms, style, or remote embeds. |
| Inline/display math | LaTeX remains literal; reported display delimiters visibly leak. | No incomplete-math projection. | Add a maintained math AST/typesetting path without enabling raw HTML; preserve readable source while incomplete and semantic/selectable output when complete. |
| Code | Fenced/inline code works; deterministic highlighter supports a limited language set; source is preserved; code copy uses main-process clipboard. | Open fences are projected closed. | Retain exact text, horizontal containment, and native button; add long-line/language fallback and accessible copied-status evidence. |
| Tables | Semantic table inside a keyboard-focusable horizontal wrapper. | Incomplete header becomes readable prose until delimiter arrives. | Add an accessible name/instruction for the scroll region and large-table evidence. |
| Links/citations | Safe URL transform removes unsafe schemes; anchors request a new window; Electron opens only HTTPS. Agent `memoryCitation` is ignored. | Incomplete link targets are removed from projection. | Preserve safe HTTPS behavior; define explicit citation treatment and avoid rendering a link that the shell will silently refuse. |
| Markdown images | `data:image/*` and `blob:` render lazily; remote images become outbound links and are not fetched. | No special image projection beyond incomplete link repair. | Keep remote content click-only by default; narrow/verify allowed data MIME types and test SVG/subresource behavior under CSP. |
| User/image-view/generated images | Composer accepts data URLs; persisted user media, `imageView`, and generated results have no semantic renderer. | Not applicable or item lifecycle only. | Render metadata first; require an explicit privacy policy before local-path or remote-content previews. Never dump encoded image data as JSON. |
| Audio/file references | Composer accepts audio, but completed audio/localAudio/skill/mention inputs are invisible. | Voice transcription is separate. | Show durable attachment chips and safe open/play affordances without auto-fetching remote media. |
| CJK and long prose | CJK works in existing fixtures; prose uses `overflow-wrap`. | Full accumulated text is reparsed each update. | Add bidi isolation/`dir=auto`, long unbroken token, mixed RTL/CJK, and very-large-document fixtures. |
| Malformed syntax | Common incomplete emphasis/code/link/table cases stay readable. | Projection is render-only and leaves authoritative text untouched. | Extend to math and fuzz/adversarial Markdown; never mutate stored content. |

## Security, privacy, accessibility, and performance

### Security and privacy

Current strengths:

- Electron uses `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`.
- Navigation is blocked; new windows are denied and only HTTPS is delegated to the OS.
- CSP limits scripts to self, images to self/data/blob, media to self/blob, and connections to self.
- ReactMarkdown skips raw HTML and applies its safe URL transform. Remote Markdown images are not loaded automatically.
- Technical output is rendered as React text, not injected HTML.

Open risks and required tests:

- Enabling raw HTML would materially weaken the present boundary. CSP currently permits inline styles, so sanitizing only scripts/events would still allow hostile visual overlays. Do not enable `rehype-raw` without a narrow allowlist, sanitization, CSP, URL, and regression threat model.
- `data:image/*` includes SVG. CSP reduces its reach, but the allowed MIME set and nested-resource behavior need an explicit adversarial test before treating every image subtype as equivalent.
- Generic JSON fallback can reveal local paths, tool arguments, MCP metadata, or encoded media more prominently than a semantic renderer would. It is user-local, but it should remain collapsed and size-bounded.
- Remote links are explicit, which is privacy-positive. Remote media must not become automatic network requests as a side effect of richer rendering.
- Local file/image affordances must validate targets in the main process and must not turn arbitrary Markdown paths into privileged `shell.openPath` calls.

### Accessibility and interaction

Current strengths:

- Native buttons, links, `details/summary`, semantic tables/lists/quotes, selectable text, visible focus behavior, and reduced-motion CSS provide a solid base.
- Code and tables contain overflow locally rather than widening the whole chat.

Gaps:

- The table scroll wrapper has `tabIndex=0` but no accessible name or explanation.
- Streaming announces a labeled caret but has no considered live-region strategy; a naive `aria-live` on every token would be noisy, so final/paragraph-granularity behavior needs testing.
- Copy success is visual text in the same button but is not independently asserted with an assistive-technology announcement.
- Structured attachments, tool states, review boundaries, compaction, and errors lack semantic labels because they are generic JSON.
- Prose does not opt into `dir=auto` or isolate mixed-direction user content.
- Approval cards are appended after all turns rather than associated with the exact producing turn.

### Performance and stability

Source-backed risks, not yet measured regressions:

- Each accepted notification can trigger a `readThread`; the renderer replaces the thread snapshot and traverses every turn.
- Streaming passes the full accumulated string through projection and ReactMarkdown again. Work therefore grows with both message length and notification count.
- Completed code highlighting tokenizes the whole block synchronously. Large MCP JSON, generated image results, diffs, and command output can create many text nodes.
- No transcript virtualization, content visibility boundary, item memoization, output truncation, or size budget is present.
- The reducer retains every delta string until completion and clones full items/threads for read projections.

Required evidence before optimization: performance marks for thread-read, reducer apply, React commit, and Markdown parse on synthetic 10/100/500-turn fixtures; a long streaming message; large command/MCP output; and image-generation payloads. Optimize the measured dominant stage rather than attributing the reported startup delay to Markdown by inference.

## Prioritized gaps

| Priority | Gap | User impact | Contract/security risk | Coupling | Evidence |
| --- | --- | --- | --- | --- | --- |
| P0 | Method-specific server-request routing and exact-turn placement | Turns can block or receive invalid answers; prompts are misleading | High contract risk | Adapter + IPC + UI | Official approval/request contracts; `App.tsx`, `peel-service.ts` source |
| P0 | Correct item-specific streaming reducer | Reasoning and command output appear late or incomplete | High contract risk | Reducer + renderer tests | Official delta names vs lowercase suffix check |
| P0 | Current turn errors and final review/plan prose | Important result/failure text can be hidden in status or JSON | High fidelity risk | Item routes | Official error/review guidance; source matrix |
| P1 | Persisted structured user inputs | Images/audio/skills/mentions disappear after send | Medium-high fidelity risk | Input model + transcript | Installed `UserInput` union; `itemText` source |
| P1 | Semantic MCP/dynamic/web/collab/lifecycle routes with size limits | Frequent activity is unreadable; large JSON can stall UI | Medium contract/privacy risk | Shared activity system | Local type counts; installed union |
| P1 | Safe math typesetting | Visible formula corruption in real response | Low protocol, medium UX risk | Markdown pipeline | Dogfood screenshot and existing math Ticket |
| P1 | Image-view/generation/media policy and renderer | Codex visual work is not visible; encoded result risk | Medium privacy/performance risk | Main/renderer boundary | Installed union and fallback behavior |
| P2 | Measured long-thread/streaming optimization | Possible lag and high CPU on large chats | Medium stability risk | Reducer + React architecture | Source-backed complexity; profile still required |
| P2 | Accessibility/bidi hardening | Keyboard and screen-reader context is incomplete | Medium accessibility risk | Shared components/CSS | Source inspection |
| Defer | Raw/sanitized HTML subset | No demonstrated App Server item need | High injection/privacy risk | Parser + CSP + threat model | No HTML item in docs or 0.154 schema |

Unsupported speculation is intentionally excluded: this audit does not claim that Codex promises executable embedded HTML, that raw HTML is necessary for visualizations, or that Markdown parsing caused the observed two-second initial load.

## Smallest follow-up Ticket graph

These are proposed boundaries, not changes made by this audit:

1. **`ticket-correct-app-server-live-item-and-request-routing`** — P0, no dependency. Implement explicit delta reducers for agent, plan, reasoning summary/content, and command output; render current turn errors; dispatch every supported server request by method with correct response schema and exact-turn association. Preserve completed-item authority and unknown fallback.
2. **`ticket-render-structured-user-inputs-and-media-metadata`** — P1, can run in parallel after contract fixtures are agreed. Render durable text/image/local-image/audio/local-audio/skill/mention chips; add metadata-first routes for image view/generation; keep remote loading opt-in and encoded payloads out of JSON fallback.
3. **`ticket-render-semantic-codex-activity-items`** — P1, depends on Ticket 1's lifecycle reducer. Add readable, size-bounded routes for plan, function output, MCP, dynamic tools, web search, collaboration, hooks, sleep, review transitions, and compaction. Keep machine facts out of prose and preserve Open in Codex.
4. **Split the existing `ticket-fix-focus-math-and-branch-affordance`** into two independent Tickets before execution. The math half remains P1 and owns safe completed/streaming formula rendering. The Branch half owns only the persistent Turn-footer action and circular handle removal. They share no implementation dependency.
5. **`ticket-profile-and-harden-large-transcript-rendering`** — P2, depends on the new semantic routes so benchmarks use realistic shapes. Establish budgets and then add only the measured combination of memoization, batching, bounded output, content visibility, or virtualization. Include accessibility and bidi fixtures where structural changes touch DOM order.
6. **No HTML implementation Ticket now.** If real Codex payloads later require HTML semantics that cannot be represented by Markdown, create a human-decision Ticket choosing between continued escaping, a sanitized static subset, or an isolated artifact/webview surface. Implementation must depend on that decision.

The existing `ticket-fix-new-chat-space-title-lifecycle` is unrelated and remains unchanged. The performance concern about initial Codex/thread loading also remains separate until profiling identifies a rendering contribution.

## Exit criteria status

- Authoritative content inventory: satisfied by official docs, installed stable/experimental generated schema, and sanitized local type counts.
- Renderer route matrix: satisfied above, including fallback, streaming, completion, approvals, errors, attachments, and coverage.
- Prose/format/media matrix: satisfied above.
- Security/accessibility/performance review: satisfied above without enabling unsafe behavior.
- Evidence-backed prioritization: satisfied above; inference is labeled and unsupported claims are excluded.
- Smallest follow-up plan: satisfied above; no production renderer behavior or dependency was changed.
