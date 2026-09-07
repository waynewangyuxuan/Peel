import { useId, type ReactNode } from "react";

const PHASE_MARK_PATH = "M28 105V48C28 28 42 16 63 16H70C91 16 104 29 104 49C104 70 90 82 69 82H50V105H28ZM50 38V62H69C78 62 83 58 83 50C83 42 78 38 69 38H50Z";

export function BrandMark({ className, title }: { className?: string; title?: string }): ReactNode {
  const instanceId = useId().replaceAll(":", "");
  const lowerId = `phase-lower-${instanceId}`;
  const upperId = `phase-upper-${instanceId}`;

  return <svg
    className={className}
    viewBox="0 0 120 120"
    role={title ? "img" : undefined}
    aria-hidden={title ? undefined : true}
    aria-label={title}
    focusable="false"
  >
    <defs>
      <clipPath id={lowerId}><path d="M0 86 120 56V120H0Z"/></clipPath>
      <clipPath id={upperId}><path d="M0 0H120V49L0 79Z"/></clipPath>
    </defs>
    <path d={PHASE_MARK_PATH} fill="currentColor" fillRule="evenodd" clipRule="evenodd" clipPath={`url(#${lowerId})`}/>
    <path d={PHASE_MARK_PATH} fill="currentColor" fillRule="evenodd" clipRule="evenodd" clipPath={`url(#${upperId})`} transform="translate(7 0)"/>
  </svg>;
}

export function PeelBrand({ className }: { className?: string }): ReactNode {
  return <span className={className}>
    <BrandMark className="peel-mark small"/>
    <strong>Peel</strong>
  </span>;
}
