# Peel desktop-shell spike

This is disposable evidence for `ADR-0001`, not the production application.

It proves two things together:

1. Electron can host the preserved Peel Demo with a sandboxed renderer, context isolation, and no renderer-side Node.js access.
2. The Electron main process can resolve and own a local `codex app-server --stdio` child process through the `initialize` / `initialized` handshake.

Run from this directory:

```sh
npm install
npm run verify:handshake
npm run verify:shell
```

Set `PEEL_CODEX_BIN` to an absolute executable path if Codex is not installed at a standard Homebrew location. The probe passes an allowlisted environment to Codex and does not store credentials or tokens.

