import type { ReactNode } from "react";

export function Icon({ name, size = 16 }: { name: string; size?: number }): ReactNode {
  const paths: Record<string, ReactNode> = {
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    branch: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 7c4 0 4 10 8 10"/></>,
    map: <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z"/><path d="M9 3v15M15 6v15"/></>,
    chat: <><path d="M4 5h16v12H8l-4 4Z"/></>,
    mic: <><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></>,
    send: <><path d="m4 4 17 8-17 8 4-8Z"/><path d="M8 12h13"/></>,
    diff: <><path d="M7 3v18M17 3v18M4 7h6M14 17h6"/></>,
    external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v7H4V6h7"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    chevron: <><path d="m9 18 6-6-6-6"/></>,
    folder: <><path d="M3 6h7l2 2h9v11H3Z"/></>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
    paperclip: <><path d="m20 12-8 8a6 6 0 0 1-8-8l9-9a4 4 0 0 1 6 6l-9 9a2 2 0 0 1-3-3l8-8"/></>,
    arrowBack: <><path d="m15 18-6-6 6-6"/></>,
    stop: <rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor"/>,
    retry: <><path d="M20 11a8 8 0 1 0-2 6"/><path d="M20 5v6h-6"/></>,
  };
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
