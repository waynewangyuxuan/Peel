# Peel desktop v0.1

Peel is a macOS desktop client for navigating real Codex Threads as a single-root Fork tree. It keeps the conversation and execution record in Codex while persisting only Peel-owned Space membership and view state locally.

## Product boundary

- Start a Space by searching and selecting an existing Codex Chat. Project membership is neither required nor displayed.
- Thread discovery warms a 30-Chat recent page after Codex connects, keeps a 15-second in-memory page cache, uses App Server cursors for explicit progressive loading, and never treats the first page as the complete Chat history.
- Focus is the full conversation surface: streamed Items, commands, file changes, approvals, Activity, attachments, editable per-Thread drafts, Voice Dictation, and a safe fallback for unknown Items.
- A completed Turn can create a local, cancellable Fork Draft. No Thread or Worktree exists until First Send.
- Overview contains deterministic Fork cards and real Fork edges only. Card positions and camera state are stable and persisted.
- Incremental placement never moves existing cards, avoids occupied card slots, and keeps a 50-node synthetic Space navigable through Fit, pan, zoom, and Focus entry.
- New Worktree and Diff are lightweight execution-location tools. Peel does not implement commit, push, PR, branch management, arbitrary graph editing, or Project management.

## Local development

Requirements: macOS, Node.js 22 or 24+, the Codex CLI with App Server support, Git, and Apple Command Line Tools.

```sh
npm install --legacy-peer-deps
npm run build
npm test
npm run test:e2e --workspace @peel/desktop
```

The end-to-end journey launches Electron and therefore needs permission to start a local GUI process. It uses isolated Codex and Speech fixtures, a disposable Git repository, and a dedicated Peel user-data directory. The renderer records real mono PCM from `getUserMedia`. Before capture, Peel preflights its owned Codex App Server Realtime adapter; only a real `thread/realtime/started` selects it. Codex 0.149 rejects the existing ChatGPT/SIWC login for Realtime, so today's package selects the native Apple Speech helper before recording without exposing the protocol error. Peel never requires or inherits an independent API key.

## Package and verify

```sh
npm run package:desktop
npm run verify:package --workspace @peel/desktop
```

The package is written to `apps/desktop/out/Peel-darwin-arm64/Peel.app`. The verification launches that exact bundle twice outside Vite, checks the unpacked native Speech helper and privacy usage strings, and proves an edit made immediately before close survives a full restart. This is a local dogfood package; distribution signing and notarization are release operations outside the v0.1 Ticket.

Voice Dictation requests the permissions required by the selected engine on first use. Recognition errors and capture interruption leave the existing draft untouched. The transcript is appended to the draft and is never sent automatically.

“Copy ID & open Codex” copies the exact Thread ID to the clipboard and opens Codex as an explicit escape hatch. Peel does not fabricate an undocumented Thread deep link.
