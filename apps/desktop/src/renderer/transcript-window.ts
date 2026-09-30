export const INITIAL_TRANSCRIPT_TURNS = 32;
// Keep each DOM commit below the 50 ms interaction budget even when a chunk
// contains syntax-highlighted code, math, or media whose cost is uneven.
export const TRANSCRIPT_BACKFILL_CHUNK = 1;
export const TRANSCRIPT_BACKFILL_THRESHOLD_PX = 160;

export interface TranscriptScrollAnchor {
  turnId: string;
  offset: number;
}

export interface TranscriptRange {
  start: number;
  end: number;
}

export interface InitialTranscriptRangeInput {
  turnIds: string[];
  fullMount: boolean;
  highlightTurnId: string | null;
  restoreAnchor: TranscriptScrollAnchor | null;
  hasSavedScroll: boolean;
  restoreScrollTop: number;
}

/**
 * Chooses the smallest contiguous initial range that contains the user's
 * navigation target. The complete Codex Thread remains authoritative; this is
 * presentation state only.
 */
export function initialTranscriptRange({
  turnIds,
  fullMount,
  highlightTurnId,
  restoreAnchor,
  hasSavedScroll,
  restoreScrollTop,
}: InitialTranscriptRangeInput): TranscriptRange {
  const total = turnIds.length;
  if (fullMount || total <= INITIAL_TRANSCRIPT_TURNS) return { start: 0, end: total };

  const targetId = highlightTurnId ?? restoreAnchor?.turnId ?? null;
  const targetIndex = targetId ? turnIds.indexOf(targetId) : -1;
  if (targetIndex >= 0) return rangeAround(targetIndex, total);

  // A pre-anchor saved offset cannot be mapped safely without the historical
  // DOM. Mount it once, then normal scrolling records a durable Turn anchor.
  if (hasSavedScroll && restoreScrollTop > 1) return { start: 0, end: total };
  if (hasSavedScroll) return { start: 0, end: INITIAL_TRANSCRIPT_TURNS };
  return { start: total - INITIAL_TRANSCRIPT_TURNS, end: total };
}

export function prependTranscriptRange(range: TranscriptRange): TranscriptRange {
  return { start: Math.max(0, range.start - TRANSCRIPT_BACKFILL_CHUNK), end: range.end };
}

export function appendTranscriptRange(range: TranscriptRange, total: number): TranscriptRange {
  return { start: range.start, end: Math.min(total, range.end + TRANSCRIPT_BACKFILL_CHUNK) };
}

export function rangeContains(range: TranscriptRange, index: number): boolean {
  return index >= range.start && index < range.end;
}

function rangeAround(index: number, total: number): TranscriptRange {
  const before = Math.min(8, Math.floor(INITIAL_TRANSCRIPT_TURNS / 3));
  const maximumStart = Math.max(0, total - INITIAL_TRANSCRIPT_TURNS);
  const start = Math.min(maximumStart, Math.max(0, index - before));
  return { start, end: Math.min(total, start + INITIAL_TRANSCRIPT_TURNS) };
}
