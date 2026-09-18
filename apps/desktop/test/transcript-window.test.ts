import { describe, expect, it } from "vitest";

import {
  INITIAL_TRANSCRIPT_TURNS,
  TRANSCRIPT_BACKFILL_CHUNK,
  appendTranscriptRange,
  initialTranscriptRange,
  prependTranscriptRange,
  rangeContains,
} from "../src/renderer/transcript-window";

const ids = Array.from({ length: 500 }, (_, index) => `turn-${index + 1}`);

describe("bounded transcript range", () => {
  it("opens an ordinary long Thread at a bounded live tail", () => {
    expect(initialTranscriptRange({
      turnIds: ids,
      fullMount: false,
      highlightTurnId: null,
      restoreAnchor: null,
      hasSavedScroll: false,
      restoreScrollTop: 0,
    })).toEqual({ start: 500 - INITIAL_TRANSCRIPT_TURNS, end: 500 });
  });

  it("includes saved and highlighted Turn anchors in the first bounded range", () => {
    const restored = initialTranscriptRange({
      turnIds: ids,
      fullMount: false,
      highlightTurnId: null,
      restoreAnchor: { turnId: "turn-211", offset: 24 },
      hasSavedScroll: true,
      restoreScrollTop: 9_000,
    });
    const highlighted = initialTranscriptRange({
      turnIds: ids,
      fullMount: false,
      highlightTurnId: "turn-3",
      restoreAnchor: null,
      hasSavedScroll: false,
      restoreScrollTop: 0,
    });
    expect(restored.end - restored.start).toBe(INITIAL_TRANSCRIPT_TURNS);
    expect(rangeContains(restored, 210)).toBe(true);
    expect(rangeContains(highlighted, 2)).toBe(true);
  });

  it("preserves legacy numeric restoration once and keeps baseline full-mountable", () => {
    expect(initialTranscriptRange({
      turnIds: ids,
      fullMount: false,
      highlightTurnId: null,
      restoreAnchor: null,
      hasSavedScroll: true,
      restoreScrollTop: 600,
    })).toEqual({ start: 0, end: 500 });
    expect(initialTranscriptRange({
      turnIds: ids,
      fullMount: true,
      highlightTurnId: null,
      restoreAnchor: null,
      hasSavedScroll: false,
      restoreScrollTop: 0,
    })).toEqual({ start: 0, end: 500 });
  });

  it("grows in bounded chunks without changing the opposite edge", () => {
    expect(prependTranscriptRange({ start: 100, end: 132 })).toEqual({ start: 100 - TRANSCRIPT_BACKFILL_CHUNK, end: 132 });
    expect(appendTranscriptRange({ start: 92, end: 132 }, 500)).toEqual({ start: 92, end: 132 + TRANSCRIPT_BACKFILL_CHUNK });
  });
});
