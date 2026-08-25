# Verification record

Verified on 2026-08-25 on Apple Silicon macOS 26.5.2 with Node.js 23.9.0, Electron 44.0.0, and local Codex 0.149.0.

## Direct App Server handshake

Command:

```sh
npm run verify:handshake
```

Result:

```json
{"ok":true,"codexBinary":"/opt/homebrew/bin/codex","elapsedMs":90,"serverInfo":null,"userAgent":"peel_desktop_shell_spike/0.149.0 (Mac OS 26.5.2; arm64) unknown (peel_desktop_shell_spike; 0.0.0)"}
```

This proves the probe launched the real local `codex app-server --stdio`, received the response to request ID `0`, sent the `initialized` notification, and terminated the process.

## Integrated Electron shell

Command:

```sh
npm run verify:shell
```

Result:

```text
PEEL_SHELL_SPIKE_RESULT {"ok":true,"surface":{"title":"Spatial Thread Workspace — Product & UX Foundation","focus":true,"overview":true,"composer":true},"handshake":{"ok":true,"codexBinary":"/opt/homebrew/bin/codex","elapsedMs":94,"serverInfo":null,"userAgent":"peel_desktop_shell_spike/0.149.0 (Mac OS 26.5.2; arm64) unknown (peel_desktop_shell_spike; 0.0.0)"}}
```

This proves a real Electron application loaded the exact preserved Demo, found its Focus, Overview, and Composer surfaces, owned the App Server handshake, and quit with exit status 0.

## Permission-boundary observation

The direct handshake initially failed inside the restricted development sandbox because Codex could not initialize SQLite state under `~/.codex`. It passed unchanged with normal desktop permissions. This is expected architecture evidence: local Codex state belongs behind the privileged desktop service boundary and is not renderer-accessible.

## Dependency check

`npm install` completed with 14 audited packages and 0 reported vulnerabilities. The installed Electron development application measured 287 MB uncompressed; this is a framework-development measurement, not a signed Peel distribution artifact.

