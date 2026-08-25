# v0.1 verification

## Automated results

- Strict desktop TypeScript check and three Vite production bundles pass.
- 12 focused tests cover the single-root state model, deterministic titles, collision-free 50-node incremental allocation, serialized/merged state updates, atomic restoration, real PCM-to-WAV encoding, successful native transcript boundary, recognition failure, and unusable capture.
- The Electron journey covers existing-Thread search, one-Root Space creation, selectable Markdown plus horizontally scrolling code, a leading/trailing real-stream throttle, bottom-follow and deliberate scroll-up suppression, exact per-Thread Draft/Scroll restoration under out-of-order reads, and unknown Item fallback.
- The same journey measures a sub-150ms local Fork Draft, proves Escape cancellation has no RPC Fork, locks dismissal during First Send, uses exact `lastTurnId`, and verifies Prompt/artifact preservation across Worktree, Fork, state-persist, First Turn, and post-Turn persistence failures without duplicate remote Forks or Turns.
- Voice checks include pending-permission Thread switching, capture interruption, typed-during-transcription preservation, recognition failure, permission denial, editability, and no auto-send. Naming checks exercise delayed automatic response/notification races plus manual Rename from Header, Focus Tree, and Overview Card.
- Overview uses 50 nodes produced by the real stable allocator, verifies no Card overlap/clipping, dynamic Edge bounds, Fit, Failed/New Result indicators, traceable snippet return, and Focus entry into a late node. Worktree metadata, Current/New Worktree wording, Diff file/patch, and return to the prior mode are exercised literally.
- The package verification checks the ASAR build, unpacked executable Speech helper, parent microphone/Speech privacy strings, the helper's embedded Speech privacy declaration and bundle identity, launch outside the dev server, and state restoration after an immediate close without waiting for the renderer debounce.
- The App Server adapter separately passed its live local Codex smoke and installed-schema check; the Git adapter separately passed 10 disposable-repository and adversarial path tests.

## Manual dogfood boundary

Automated UI tests intentionally use a deterministic Speech helper so they can prove draft behavior without claiming that fake text is real recognition. The production package contains and calls `native/SpeechTranscriber.m`, linked to Apple `Speech.framework`, while the renderer captures actual microphone PCM. Final dogfood should speak once into the packaged app, accept both macOS permissions, edit the returned words, and only then send. This permission-bound user action remains visible rather than being mislabeled as an automated proof; a synthetic waveform is not claimed as a human speech-recognition result.

The package is local and unsigned for dogfood. Signing, notarization, update delivery, and broader distribution are not part of v0.1.
