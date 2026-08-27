# ADR-0001: Use Electron as Peel's desktop shell

- Status: Accepted
- Date: 2026-08-25
- Ticket: `ticket-establish-desktop-shell`
- Decision owner: Engineering

## Decision

Peel v0.1 will use **Electron with a TypeScript web renderer and a privileged local service process**. The renderer keeps the preserved Focus/Overview interaction model in ordinary screen-space HTML/CSS. Electron's main process owns window lifecycle, permission mediation, and updates. A Node.js service launched with `utilityProcess` owns Codex, Git, persistence, and transcription adapters; it launches the external `codex app-server --stdio` process and converts its wire protocol into typed domain events.

Electron-specific APIs must stop at the shell boundary. The Thread-first domain model, App Server protocol types, event reducer, Git facts, Space state, and UI components must remain portable modules.

This decision does not add Project to the product model and does not make experimental Project or Realtime APIs a v0.1 dependency.

## Why Electron wins for v0.1

Peel's primary risk is not binary size. It is whether a rich, Codex-faithful chat and spatial Fork interaction can be delivered against a fast-moving local protocol without losing Drafts, approvals, streaming state, microphone input, or Git recovery paths. Electron keeps the Demo, renderer, App Server adapter, and existing VibeHub TypeScript patterns in one language and one Chromium behavior target while still providing explicit native process and permission boundaries.

The disposable spike proves the two highest-risk shell assumptions together:

- Electron 44 loaded the exact preserved Demo in a sandboxed renderer with `nodeIntegration: false` and `contextIsolation: true`; the Focus, Overview, and Composer surfaces were detected.
- The Electron main process launched the locally installed Codex `0.149.0` App Server, completed `initialize` / `initialized`, and shut it down cleanly. The integrated run completed the handshake in 94 ms on the test machine and stored no credential or token.

The development Electron runtime is large (287 MB uncompressed on the test machine). That is an accepted v0.1 cost, not evidence of the eventual signed artifact size. Distribution size and idle memory become measured release constraints during the packaged v0.1 Ticket.

## Candidate comparison

Scores are directional: 5 is strongest for Peel v0.1. They express this product's constraints, not general framework quality.

| Dimension | Electron 44 | Tauri 2 | Native SwiftUI + WKWebView |
|---|---:|---:|---:|
| App Server stdio ownership | **5** — direct Node process and stream primitives; internal service isolation available | 4 — Rust process or permission-scoped sidecar is strong, but adds a Rust/TS protocol boundary | 4 — Foundation `Process` supports pipes, but the full protocol client must be rebuilt in Swift or bridged |
| Existing Demo / web-UI fidelity | **5** — bundled Chromium is the same target on every desktop | 4 — web UI is reusable, but behavior follows each OS WebView | 3 — WKWebView preserves much HTML, but native/web composition and future cross-platform work diverge |
| Microphone and dictation | 4 — Chromium media capture plus explicit Electron/macOS permission mediation; transcription stays an adapter | 3 — WebView media behavior and permissions vary by platform; native plugin work is likely | **5** on macOS — first-class Speech and audio frameworks, but platform-specific |
| Git/worktree access | **5** — mature Node filesystem/process APIs behind a typed bridge | 4 — Rust is excellent, with more glue and a second implementation language | 4 — Foundation/process APIs are capable, with the highest implementation cost for this team and codebase |
| Accessibility | 4 — semantic HTML maps to Chromium's accessibility tree and VoiceOver | 4 — semantic HTML maps through the system WebView, with platform variance | **5** — native controls are strongest, but a WKWebView-heavy UI reduces that advantage |
| Packaging and updates | 4 — Forge provides package/make/sign/notarize/publish; runtime is larger | **5** — small system-WebView bundles and first-class platform installers | 4 — excellent macOS packaging; a separate solution is required for every non-Apple platform |
| Testability | **5** — Node protocol tests plus deterministic Chromium UI automation | 4 — good web tests and Rust tests, but end-to-end failures cross language/runtime boundaries | 3 — strong XCTest tooling, but the preserved web UI and TypeScript protocol work need separate harnesses |
| Security boundary | 4 — secure only with sandbox, context isolation, narrow preload APIs, local-only content, and deny-by-default permissions | **5** — capability-scoped commands are an excellent default | 4 — native sandboxing is strong; WKWebView ↔ native bridge still requires careful scoping |
| v0.1 delivery and reuse cost | **5** | 3 | 2 |

### Electron

Electron embeds Chromium and Node.js and formalizes main, renderer, preload, and utility processes. This is the shortest path to preserving the Demo while owning a long-lived stdio service. Electron Forge supplies packaging, code-signing, notarization, and publishing stages. Microphone access still requires both application-level permission handling and macOS usage descriptions.

Tradeoff: the runtime and dependency surface are materially larger. Electron must be kept current, renderer Node integration stays disabled, all renderer permissions are denied unless explicitly required, and no remote application content is loaded.

### Tauri 2

Tauri has the best default capability model and substantially smaller bundles because it uses the operating system WebView. It can run `codex` through a Rust command or permission-scoped sidecar and can package a macOS app cleanly.

It is not selected because Peel's v0.1 work is dominated by a large, evolving bidirectional App Server adapter and web interaction fidelity. Moving that boundary into Rust or maintaining a Rust/TypeScript bridge adds failure modes exactly where v0.1 needs rapid protocol iteration. System WebViews also turn renderer and microphone behavior into a platform matrix earlier than necessary.

### Native SwiftUI + WKWebView

The native candidate is strongest for a macOS-only voice implementation: Apple's Speech framework supports streamed recognition, authorization, availability, partial results, and on-device capability checks. Foundation also provides external process and stdio primitives.

It is not selected because Peel's differentiated UI already exists as a web prototype, the reusable Codex adapter experience is TypeScript, and a native-first shell would either rewrite the interaction surface or create a bespoke WKWebView bridge. It also makes future Windows/Linux support a new product implementation rather than a packaging target.

## Production boundaries

```text
Electron main process
  Window lifecycle · menus · deep links · updates
  OS/session permission policy
  Narrow IPC router
          │
          ├── sandboxed renderer
          │     Focus / Overview / Composer
          │     Space view state and per-Thread Draft presentation
          │     microphone capture UI
          │
          └── Peel service (Electron utilityProcess)
                AppServerTransport ── spawns ── codex app-server --stdio
                ThreadClient
                EventReducer
                GitWorkspaceAdapter ── local Git / worktrees
                PeelStateStore ── versioned local Space/view metadata
                VoiceTranscriptionAdapter
```

### Renderer contract

- No Node.js integration, direct filesystem access, process execution, raw IPC object, or credential access.
- A context-isolated preload exposes a small versioned API made of typed commands and subscriptions, never `ipcRenderer` itself.
- Focus and Overview remain normal screen-space web UI. The preserved Demo supplies interaction evidence, not production state management.
- Navigation and new-window creation are denied by default; intentional external links open in the system browser.

### App Server contract

- `AppServerTransport` exclusively owns process lookup, launch, line-delimited JSON, correlation IDs, cancellation, stderr, timeout, reconnect, and shutdown.
- `ThreadClient` exposes typed Thread/Turn/Item operations. The renderer never receives raw JSON-RPC.
- `EventReducer` treats Codex snapshots and completed Items as authoritative and produces reconstructable UI state.
- Startup capability detection marks methods `stable`, `experimental-enabled`, or `unavailable`. Pure Thread mode remains complete with Project APIs absent.
- A GUI app cannot assume an interactive shell's `PATH`; production resolution must use a user-selected executable, known signed bundle locations, or an explicit discovery flow. The spike accepts `PEEL_CODEX_BIN` and standard Homebrew locations.

### Git and persistence contract

- `GitWorkspaceAdapter` is separate from the Codex client. It accepts resolved, validated repository paths and returns structured facts or recoverable errors.
- Git process and filesystem authority never crosses into the renderer. Destructive cleanup cannot target unresolved paths.
- `PeelStateStore` persists only Peel-owned Space membership and view metadata under Electron's user-data directory using versioned, atomic writes. Codex remains the source of truth for conversation and execution facts.

### Voice contract

- The renderer requests microphone capture only after a direct user gesture. Electron main mediates both the Chromium session request and the operating-system permission; the packaged app declares a clear microphone usage description.
- Captured audio is sent through a bounded typed channel to `VoiceTranscriptionAdapter`. Partial/final text is applied to the current Draft by explicit Draft operations and never triggers Send.
- Permission denial, capture interruption, service unavailability, and transcription failure are first-class recoverable results. Existing Draft text is never replaced on failure.
- The adapter may use a native helper or another explicitly selected transcription implementation. Experimental Codex Realtime APIs are not the baseline.

Post-decision implementation note (2026-08-27): Peel now owns a capability-first
Codex Realtime adapter behind this boundary. It enables the under-development
feature only on Peel's child process and preflights each Thread before capture.
The installed Codex 0.149 runtime still requires API-key auth for Realtime when
the App Server is authenticated through ChatGPT/SIWC, so the current package
honestly selects Apple Speech before recording. No API key is inherited,
requested, stored, or exposed; a future runtime may replace the engine after a
real `thread/realtime/started` without changing the Dictation contract.

## Packaging, updates, and security policy

- Use Electron Forge for `package`, `make`, signing, notarization, and publishing. Public macOS distribution requires signing and notarization.
- Package only bundled local renderer content. Apply a restrictive Content Security Policy before v0.1 delivery.
- Keep `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`; validate every IPC sender and payload; expose one method per capability.
- Implement deny-by-default permission request/check handlers. Allow microphone media only for the packaged local renderer and only after the Voice action.
- Updates use a signed release channel with explicit rollback metadata. Automatic background installation is deferred until packaged-build recovery is proven.
- Pin Electron and update it routinely because Chromium, Node.js, Electron, dependencies, and application code jointly define the security posture.

## Rejected alternatives and migration cost

- **Tauri 2:** rejected for v0.1, not permanently. Migration is medium if shell portability is preserved: reuse UI and domain TypeScript, replace preload/main/service adapters with Tauri commands and decide whether App Server logic stays in a sidecar or moves to Rust. Packaging, permissions, automated desktop tests, and native voice must be rebuilt.
- **Native SwiftUI + WKWebView:** rejected for the current product. Migration is high: either rewrite Focus/Overview/Composer natively or maintain a custom web/native state bridge, then port protocol, Git, persistence, and test infrastructure. It becomes reasonable only if macOS-native interaction or on-device Speech quality proves more valuable than web fidelity and cross-platform reuse.
- **Browser/PWA:** rejected because it cannot safely own a local long-lived App Server stdio process, worktree lifecycle, desktop packaging, and OS permission behavior without adding a separate daemon—the desktop shell is the product boundary being decided.

The portability rule is the rollback strategy: Electron may be replaced without changing Thread, Fork Edge, Space, Worktree metadata, Focus/Overview information contracts, or the Source-of-Truth split.

## Evidence and references

Local executable evidence:

- [`spikes/desktop-shell-electron/`](../../spikes/desktop-shell-electron/) contains the exact spike and pinned lockfile.
- `npm run verify:handshake`: Codex App Server `initialize` succeeded against local Codex `0.149.0` in 90 ms.
- `npm run verify:shell`: Electron loaded the exact preserved Demo, found Focus/Overview/Composer, completed the same real handshake in 94 ms, printed `PEEL_SHELL_SPIKE_RESULT`, and quit cleanly.
- Running the handshake in the restricted development sandbox failed because Codex could not initialize its SQLite state under `~/.codex`; the same command succeeded with normal desktop permissions. This validates that local Codex state access belongs to the privileged service boundary.

Primary documentation:

- [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron media permissions](https://www.electronjs.org/docs/latest/api/session)
- [Electron macOS media access](https://www.electronjs.org/docs/latest/api/system-preferences)
- [Electron accessibility](https://www.electronjs.org/docs/latest/tutorial/accessibility)
- [Electron Forge build lifecycle](https://www.electronforge.io/core-concepts/build-lifecycle)
- [Electron Forge macOS signing](https://www.electronforge.io/guides/code-signing/code-signing-macos)
- [Tauri process model](https://v2.tauri.app/concept/process-model/)
- [Tauri capabilities](https://v2.tauri.app/security/capabilities/)
- [Tauri sidecars](https://v2.tauri.app/develop/sidecar/)
- [Tauri macOS bundles](https://v2.tauri.app/distribute/macos-application-bundle/)
- [Apple Foundation external process configuration](https://developer.apple.com/documentation/foundation/process/executableurl)
- [Apple Speech recognition](https://developer.apple.com/documentation/speech/sfspeechrecognizer)
- [Apple WKWebView media capture](https://developer.apple.com/documentation/webkit/wkwebview)
