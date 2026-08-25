# v0.1 verification

## Automated results

- Strict desktop TypeScript check and three Vite production bundles pass.
- 10 focused tests cover the single-root state model, deterministic titles, 50-node stable allocation, atomic restoration, real PCM-to-WAV encoding, successful native transcript boundary, recognition failure, and unusable capture.
- The Electron journey covers existing-Thread search, one-Root Space creation, Focus rendering and unknown Item fallback, a measured sub-150ms local Fork Draft, Escape cancellation with no RPC Fork, exact `lastTurnId`, manual-title precedence, streaming, Approval, Parent Turn return and highlight, Child draft restoration, Voice edit/no-auto-send, microphone denial, Current and New Worktree sends, Worktree failure fallback, Fork failure with prepared-Worktree reuse, First Turn failure retry, deterministic 50-node Overview, Focus re-entry, Diff, and full restart restoration.
- The package verification checks the ASAR build, unpacked executable Speech helper, parent microphone/Speech privacy strings, the helper's embedded Speech privacy declaration and bundle identity, launch outside the dev server, and state restoration after two complete packaged-app lifecycles.
- The App Server adapter separately passed its live local Codex smoke and installed-schema check; the Git adapter separately passed 10 disposable-repository and adversarial path tests.

## Manual dogfood boundary

Automated UI tests intentionally use a deterministic Speech helper so they can prove draft behavior without claiming that fake text is real recognition. The production package contains and calls `native/SpeechTranscriber.m`, linked to Apple `Speech.framework`, while the renderer captures actual microphone PCM. Final dogfood should speak once into the packaged app, accept both macOS permissions, edit the returned words, and only then send. This permission-bound user action remains visible rather than being mislabeled as an automated proof.

The package is local and unsigned for dogfood. Signing, notarization, update delivery, and broader distribution are not part of v0.1.
