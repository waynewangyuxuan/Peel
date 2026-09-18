import type { ThreadSnapshot } from "../shared/contracts";
import type { TranscriptSnapshotMode } from "./thread-snapshot";

export interface TranscriptUpdateMeasurement {
  id: number;
  threadId: string;
  method: string;
  source: "read" | "notification";
  threadReadMs: number | null;
  snapshotConstructionMs: number;
  ipcDeliveryMs: number;
  reconciliationMs: number;
  reactRenderToCommitMs: number;
  commitToPaintMs: number;
}

export interface TranscriptNavigationMeasurement {
  threadId: string;
  cold: boolean;
  firstContentToCommitMs: number;
  commitToPaintMs: number;
}

export interface TranscriptBackfillMeasurement {
  threadId: string;
  direction: "prepend" | "append";
  durationMs: number;
  addedTurns: number;
  anchorDeltaPx: number;
}

export interface TranscriptPerformanceSnapshot {
  mode: TranscriptSnapshotMode;
  updates: TranscriptUpdateMeasurement[];
  navigations: TranscriptNavigationMeasurement[];
  turnRenders: Record<string, number>;
  itemRenders: Record<string, number>;
  markdownRenders: Record<string, number>;
  backfillTasks: TranscriptBackfillMeasurement[];
  longTaskMs: number;
  longTaskDurations: number[];
  domNodes: number;
  mountedTurns: number;
  totalTurns: number;
  heapBytes: number | null;
}

export interface TranscriptPerformanceController {
  openThread(threadId: string, cold: boolean): void;
}

interface PendingUpdate {
  id: number;
  threadId: string;
  method: string;
  source: "read" | "notification";
  threadReadMs: number | null;
  snapshotConstructionMs: number;
  ipcDeliveryMs: number;
  reconciliationMs: number;
  renderStartedAt: number;
}

interface PendingNavigation {
  threadId: string;
  cold: boolean;
  startedAt: number;
}

const pendingUpdates: PendingUpdate[] = [];
const completedUpdates: TranscriptUpdateMeasurement[] = [];
const pendingNavigations: PendingNavigation[] = [];
const completedNavigations: TranscriptNavigationMeasurement[] = [];
const turnRenders = new Map<string, number>();
const itemRenders = new Map<string, number>();
const markdownRenders = new Map<string, number>();
const completedBackfillTasks: TranscriptBackfillMeasurement[] = [];
let nextUpdateId = 0;
let longTaskMs = 0;
const longTaskDurations: number[] = [];
let longTaskObserver: PerformanceObserver | null = null;

export function transcriptPerformanceEnabled(): boolean {
  return typeof window !== "undefined"
    && new URLSearchParams(window.location.search).has("transcript-performance");
}

export function transcriptSnapshotMode(): TranscriptSnapshotMode {
  if (!transcriptPerformanceEnabled()) return "optimized";
  return new URLSearchParams(window.location.search).get("transcript-performance") === "baseline"
    ? "baseline"
    : "optimized";
}

export function beginTranscriptUpdate(
  threadId: string,
  snapshot: ThreadSnapshot,
  reconciliationMs: number,
  method: string,
): void {
  if (!transcriptPerformanceEnabled()) return;
  const timing = snapshot.performance;
  pendingUpdates.push({
    id: ++nextUpdateId,
    threadId,
    method,
    source: timing?.source ?? "notification",
    threadReadMs: timing?.threadReadMs ?? null,
    snapshotConstructionMs: timing?.snapshotConstructionMs ?? 0,
    ipcDeliveryMs: timing ? Math.max(0, Date.now() - timing.sentAtEpochMs) : 0,
    reconciliationMs,
    renderStartedAt: performance.now(),
  });
}

export function commitTranscriptUpdates(threadId: string): void {
  if (!transcriptPerformanceEnabled()) return;
  const committedAt = performance.now();
  const navigations = pendingNavigations.filter((navigation) => navigation.threadId === threadId);
  for (let index = pendingNavigations.length - 1; index >= 0; index -= 1) {
    if (pendingNavigations[index]?.threadId === threadId) pendingNavigations.splice(index, 1);
  }
  const committed = pendingUpdates.filter((update) => update.threadId === threadId);
  for (let index = pendingUpdates.length - 1; index >= 0; index -= 1) {
    if (pendingUpdates[index]?.threadId === threadId) pendingUpdates.splice(index, 1);
  }
  if (committed.length === 0 && navigations.length === 0) return;
  void afterTwoAnimationFrames().then(() => {
    const paintedAt = performance.now();
    for (const navigation of navigations) {
      completedNavigations.push({
        threadId,
        cold: navigation.cold,
        firstContentToCommitMs: committedAt - navigation.startedAt,
        commitToPaintMs: paintedAt - committedAt,
      });
    }
    for (const update of committed) {
      completedUpdates.push({
        id: update.id,
        threadId: update.threadId,
        method: update.method,
        source: update.source,
        threadReadMs: update.threadReadMs,
        snapshotConstructionMs: update.snapshotConstructionMs,
        ipcDeliveryMs: update.ipcDeliveryMs,
        reconciliationMs: update.reconciliationMs,
        reactRenderToCommitMs: committedAt - update.renderStartedAt,
        commitToPaintMs: paintedAt - committedAt,
      });
    }
  });
}

export function recordTurnRender(turnId: string): void {
  increment(turnRenders, turnId);
}

export function recordItemRender(itemId: string): void {
  increment(itemRenders, itemId);
}

export function recordMarkdownRender(itemId: string): void {
  increment(markdownRenders, itemId);
}

export function recordTranscriptRange(_threadId: string, _mountedTurns: number, _totalTurns: number): void {
  // The current range is read from the ordinary Transcript DOM in snapshot().
  // Keeping this hook explicit makes range commits observable without adding a
  // parallel runtime store in production.
}

export function recordTranscriptBackfill(measurement: TranscriptBackfillMeasurement): void {
  if (!transcriptPerformanceEnabled()) return;
  completedBackfillTasks.push(measurement);
}

export function installTranscriptPerformanceApi(controller: TranscriptPerformanceController): () => void {
  if (!transcriptPerformanceEnabled()) return () => undefined;
  startLongTaskObserver();
  window.__peelTranscriptPerformance = {
    mode: transcriptSnapshotMode(),
    reset: resetTranscriptPerformance,
    snapshot: transcriptPerformanceSnapshot,
    waitForUpdates,
    waitForNavigations,
    openThread: (threadId, cold = false) => {
      pendingNavigations.push({ threadId, cold, startedAt: performance.now() });
      controller.openThread(threadId, cold);
    },
  };
  return () => {
    delete window.__peelTranscriptPerformance;
    longTaskObserver?.disconnect();
    longTaskObserver = null;
  };
}

function resetTranscriptPerformance(): void {
  pendingUpdates.length = 0;
  completedUpdates.length = 0;
  pendingNavigations.length = 0;
  completedNavigations.length = 0;
  turnRenders.clear();
  itemRenders.clear();
  markdownRenders.clear();
  completedBackfillTasks.length = 0;
  longTaskMs = 0;
  longTaskDurations.length = 0;
  longTaskObserver?.takeRecords();
}

function transcriptPerformanceSnapshot(): TranscriptPerformanceSnapshot {
  collectLongTasks();
  const transcript = document.querySelector<HTMLElement>(".transcript");
  return {
    mode: transcriptSnapshotMode(),
    updates: [...completedUpdates],
    navigations: [...completedNavigations],
    turnRenders: Object.fromEntries(turnRenders),
    itemRenders: Object.fromEntries(itemRenders),
    markdownRenders: Object.fromEntries(markdownRenders),
    backfillTasks: [...completedBackfillTasks],
    longTaskMs,
    longTaskDurations: [...longTaskDurations],
    domNodes: transcript?.querySelectorAll("*").length ?? 0,
    mountedTurns: Number(transcript?.dataset.mountedTurns ?? 0),
    totalTurns: Number(transcript?.dataset.totalTurns ?? 0),
    heapBytes: (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
  };
}

async function waitForNavigations(count: number, timeoutMs = 10_000): Promise<TranscriptPerformanceSnapshot> {
  const deadline = performance.now() + timeoutMs;
  while (completedNavigations.length < count) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${count} transcript navigations; saw ${completedNavigations.length}`);
    await new Promise((resolve) => window.setTimeout(resolve, 16));
  }
  return transcriptPerformanceSnapshot();
}

async function waitForUpdates(count: number, timeoutMs = 10_000): Promise<TranscriptPerformanceSnapshot> {
  const deadline = performance.now() + timeoutMs;
  while (completedUpdates.length < count) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${count} transcript paints; saw ${completedUpdates.length}`);
    await new Promise((resolve) => window.setTimeout(resolve, 16));
  }
  return transcriptPerformanceSnapshot();
}

function startLongTaskObserver(): void {
  if (longTaskObserver || !("PerformanceObserver" in window) || !PerformanceObserver.supportedEntryTypes.includes("longtask")) return;
  longTaskObserver = new PerformanceObserver((entries) => {
    recordLongTasks(entries.getEntries());
  });
  longTaskObserver.observe({ entryTypes: ["longtask"] });
}

function collectLongTasks(): void {
  if (longTaskObserver) recordLongTasks(longTaskObserver.takeRecords());
}

function recordLongTasks(entries: PerformanceEntry[]): void {
  for (const entry of entries) {
    longTaskMs += entry.duration;
    longTaskDurations.push(entry.duration);
  }
}

function increment(counts: Map<string, number>, id: string): void {
  if (!transcriptPerformanceEnabled()) return;
  counts.set(id, (counts.get(id) ?? 0) + 1);
}

async function afterTwoAnimationFrames(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
}
