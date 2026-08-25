# Peel Git Workspace adapter

This package owns the local Git facts that Codex App Server does not promise:
detecting checkout/worktree identity, creating an optional Fork worktree, and
providing lightweight Diff Surface data. It is deliberately separate from the
Codex App Server client and from Peel's Space/Fork graph.

## Product boundary

- `inspect()` is read-only and resolves the current worktree, main checkout,
  common Git directory, branch/HEAD, linked-worktree status, and dirty state.
- `createWorktree()` requires an existing absolute target parent, rejects broad
  or repository-root targets, allocates a unique `peel/<slug>` branch and direct
  child path, resolves the requested base ref to a validated commit ID, then
  uses one `git worktree add` operation.
- Every creation failure is a `GitWorkspaceError` containing the failed stage,
  exact attempted branch/path, positively detected partial artifacts, current
  workspace fallback, and the unchanged `pendingForkId` needed to recover the
  caller-owned Prompt. Registered worktrees and unregistered leftover
  directories are distinguished.
- `getDiffSummary()` and `getDiff()` expose changed files, line totals, binary
  flags, and unified file/hunk data for tracked and untracked files. Numstat is
  NUL-delimited so every valid Git path—including tabs—is preserved.
- `getOpenTargets()` returns explicit Worktree, Editor, and Codex navigation
  intents. Lexical and realpath containment both run before a file target is
  returned, so an in-worktree symlink cannot open outside the checkout. The
  adapter never launches an application itself.

The adapter has no cleanup, commit, push, PR, branch graph, branch-management,
or multi-worktree comparison API. Worktree remains Thread metadata; no method
creates a Space node or Fork Edge.

## Verification

```sh
npm test
```

Tests use disposable repositories under the OS temporary directory and cover
main/linked checkout detection, dirty and untracked files, naming collisions,
invalid repositories, broad targets, an injected partial branch-only failure,
retry/current-workspace recovery facts, Diff data, open targets, and path
escape rejection. Test cleanup removes only each test's own temporary root.
