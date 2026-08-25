# Git Workspace adapter verification

Verified on 2026-08-25 with the system Git client in disposable repositories
under the OS temporary directory.

## Automated suite

`npm test` compiled the strict TypeScript package and passed 10 tests:

1. Main-checkout and linked-worktree roots, branch, HEAD, common Git directory,
   dirty state, and read-only inspection.
2. Unique `peel/<slug>` branch and direct-child paths across naming collisions.
3. Modified and untracked file counts, additions/deletions, aggregate and
   per-file unified diffs, and Worktree/Editor/Codex open targets.
4. Missing cwd, non-Git cwd, filesystem-root target, unresolved target parent,
   option-like invalid base ref, and proof that validation failures create no
   branch or worktree.
5. Injected failure after branch creation, exact branch-only artifact reporting,
   unchanged pending Fork ID, Current Workspace fallback, and successful retry
   under a newly allocated identity.
6. Rejection of Diff paths that escape the resolved worktree.
7. Git process failure normalized into the same recoverable envelope with the
   pending Fork ID preserved.
8. Exact distinction between a registered worktree and an unregistered
   leftover directory after partial creation failure.
9. NUL-safe additions/deletions and per-file diff for a tracked filename that
   contains a literal Tab.
10. Realpath-aware rejection of a worktree symlink whose target is outside the
    checkout, for both Diff and Editor/Codex open-target paths.

All fixture cleanup is scoped to the unique temporary root returned by
`mkdtemp`; the product adapter itself intentionally exposes no destructive
cleanup API.

## Packaging check

`npm pack --dry-run --cache /private/tmp/peel-npm-cache` passed and showed that
the package surface contains only compiled adapter modules, type declarations,
README, and package metadata. Tests, temporary repositories, local dependencies,
and build caches are excluded.
