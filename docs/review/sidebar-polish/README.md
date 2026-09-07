# Space sidebar polish

Reuses the previously selected Phase mark from the main worktree verbatim. The inline SVG needs no asset or font request. Its split silhouette now appears beside Peel in the sidebar and on the launch screen.

The sidebar keeps its 196px width (178px below 1120px) and 43px window drag region. A restrained neutral gradient, hairline divider, white inset-bordered selection, and clearer spacing establish hierarchy. The list has its own bounded scroll area; its header cannot shrink. Keyboard focus stays inside the scroll clip. Current Space is exposed with `aria-current`, and increased contrast/reduced motion preferences are honored.

The screenshots use 30 synthetic Spaces, including long English and Chinese names. They were captured in real Electron at requested content sizes 1440 × 960 and 1000 × 720; macOS may constrain the larger window height to the available display area.

- `sidebar-normal.png` / `sidebar-normal-detail.png`: full window and sidebar.
- `sidebar-narrow.png` / `sidebar-narrow-detail.png`: narrow window and sidebar.

Reproduce with `npm run build --workspace @peel/desktop`, then `npm run test:e2e --workspace @peel/desktop -- sidebar-polish.spec.ts`. The check exercises list scrolling, fixed header geometry, long title truncation, keyboard selection, Search Chats, New Chat, and increased contrast.

The running PR preview uses the same isolated preview data as before and loads the updated renderer from http://127.0.0.1:5173. The standalone package's embedded renderer is unchanged; this session's preview uses the live renderer.
