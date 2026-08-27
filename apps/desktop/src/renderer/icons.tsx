import type { ReactNode } from "react";

export function Icon({ name, size = 16 }: { name: string; size?: number }): ReactNode {
  const paths: Record<string, ReactNode> = {
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    branch: <><circle cx="6" cy="5" r="2"/><circle cx="18" cy="19" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10M8 7c4 0 4 10 8 10"/></>,
    map: <><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z"/><path d="M9 3v15M15 6v15"/></>,
    chat: <><path d="M4 5h16v12H8l-4 4Z"/></>,
    mic: <><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></>,
    send: <><path d="m4 4 17 8-17 8 4-8Z"/><path d="M8 12h13"/></>,
    arrowUp: <><path d="M12 19V5"/><path d="m6.5 10.5 5.5-5.5 5.5 5.5"/></>,
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
    check: <path d="m5 12 4 4L19 6"/>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></>,
    terminal: <><path d="m5 7 4 5-4 5"/><path d="M12 17h7"/></>,
    file: <><path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h5"/></>,
    reasoning: <><path d="M9 18h6M10 21h4"/><path d="M8.5 15.5A7 7 0 1 1 15.5 15.5C14.4 16.3 14 17 14 18h-4c0-1-.4-1.7-1.5-2.5Z"/></>,
    agent: <><circle cx="12" cy="8" r="3"/><path d="M5 20c.7-4 3-6 7-6s6.3 2 7 6"/></>,
    warning: <><path d="M12 4 3 20h18Z"/><path d="M12 9v5M12 17h.01"/></>,
    spinner: <><circle cx="12" cy="12" r="8" opacity=".28"/><path d="M12 4a8 8 0 0 1 8 8"/></>,
  };
  return <svg className={name === "spinner" ? "icon-spinner" : undefined} aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
