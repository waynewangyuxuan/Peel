# Peel desktop app icon

Date: 2026-09-17

Peel now carries the same accepted split Phase mark from the renderer into the native macOS application identity. The checked-in 1024px source uses a restrained warm-neutral rounded tile so the black mark remains legible in light and dark desktop contexts without introducing a second brand direction.

The native identity has three layers:

- `apps/desktop/build/Peel.svg` is the editable 1024px source and preserves the exact two clipped Phase paths used by `Brand.tsx`.
- `apps/desktop/build/Peel.png` is loaded locally before the first development `BrowserWindow` and supplied to the packaged app as a Dock resource.
- `apps/desktop/build/Peel.icns` contains the standard 16px through 1024px macOS representations and is embedded by `electron-packager` as the bundle icon.

`scripts/build-app-icon.mjs` regenerates both native assets with macOS system tools (`qlmanage`, `sips`, and `iconutil`), without a runtime request, font, or new image dependency. `main.ts` sets the application name to Peel and installs the local Dock icon before showing the first window. The focused production Electron check verifies the unpackaged runtime name and visible renderer identity. The packaged smoke verifier reads `CFBundleIconFile`, validates the linked ICNS and 1024px PNG, checks the runtime app name, and then completes the existing full-restart Draft restoration journey.

Reproduce with:

```sh
npm run build:icon --workspace @peel/desktop
npm run test --workspace @peel/desktop
npm run package:desktop
npm run test:e2e --workspace @peel/desktop -- native-app-identity.spec.ts
npm run verify:package --workspace @peel/desktop
```
