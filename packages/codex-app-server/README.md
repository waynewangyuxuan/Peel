# Peel Codex App Server adapter

This package is the typed, reconstructable boundary between Peel and the local
Codex App Server. It deliberately exposes a Thread-first product surface and
does not require Codex Project APIs.

## Boundaries

- `AppServerTransport` owns the local stdio child process, handshake, request
  correlation, stderr and protocol errors, graceful shutdown, and bounded
  reconnect. An unexpected disconnect rejects all pending requests and never
  replays writes.
- `AppServerClient` owns stable Thread and Turn requests, exact-turn Forks,
  approval response shapes, subscriptions, and capability downgrade on
  method-not-found. Its `connect()` binds capability gating to the transport's
  exact `experimentalApi` handshake and detects the same installed binary's
  stable and experimental schema before exposing the result.
- `AppServerReducer` owns only in-memory derived UI state. It rebuilds from
  `thread/read(includeTurns: true)`, applies stream events, treats completed
  Item/Turn payloads as authoritative, reconstructs aggregate diffs from
  snapshots, and preserves real collab/subagent activity fields.
- `CapabilityMatrix` distinguishes stable methods, explicitly enabled
  experimental features, and unavailable product features. Realtime Dictation
  is the one owned experimental adapter: Peel enables `realtime_conversation`
  only on its child process, then requires the complete installed request/event
  surface plus a successful per-Thread runtime preflight. Project,
  paginated-item, descendant filters, and WebSocket transport are not mainline
  dependencies.

Codex 0.149 exposes the Realtime schema but rejects a ChatGPT/SIWC-authenticated
session with `realtime conversation requires API key auth`. Peel does not
inherit or request an independent key. The desktop therefore selects its native
transcription adapter before microphone capture on this runtime. A future Codex
version that emits `thread/realtime/started` for the existing session will use
the same bounded PCM and transcript-only Draft path without a UI rewrite.

Codex remains the source of truth for Thread IDs, Transcript, Turns/Items,
names, status, approvals, cwd/worktree, Git facts, and subagent Threads. This
package does not persist a shadow transcript.

After an unexpected process exit, the client uses `thread/resume` for every
tracked Thread before rebuilding reducer state. `thread/read` alone is never
treated as a replacement for event subscription.

## Verification

```sh
npm test
npm run check:schema
```

`npm run check:schema` generates TypeScript from the installed Codex binary and
fails if a required stable method or notification is missing. It also probes
the experimental Realtime request and notification surface.

The opt-in real-server smoke test creates its own temporary Git repository and
two uniquely named Codex Threads, verifies list/search/read, a Turn that creates
a file, status and aggregate-diff notifications, and a Fork at the exact
completed `lastTurnId`. It deletes only the Thread IDs it created and removes
its temporary repository.

```sh
npm run test:live
npm run test:realtime
```

`test:realtime` creates and deletes one empty ephemeral Thread. It accepts the
current typed ChatGPT-auth rejection as the honest `native-fallback` result and
proves no Turn or Item event was created; if a future runtime starts Realtime,
it instead stops that session and proves the same zero-Turn boundary.

Set `PEEL_CODEX_BINARY` to an absolute executable path when Codex is not at
`/opt/homebrew/bin/codex`.
