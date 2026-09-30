import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { TranscriptPerformanceSnapshot, TranscriptUpdateMeasurement } from "../src/renderer/transcript-performance";

type Mode = "baseline" | "optimized";

interface PhaseSample {
  threadReadMs: number;
  snapshotConstructionMs: number;
  ipcDeliveryMs: number;
  reconciliationMs: number;
  reactRenderToCommitMs: number;
  commitToPaintMs: number;
  firstContentMs: number;
  throughPaintMs: number;
  longTaskMs: number;
  domNodes: number;
  mountedTurns: number;
  totalTurns: number;
  heapBytes: number | null;
}

interface StreamSample {
  deltaCount: number;
  medianRendererMs: number;
  historicalTurnRenders: number;
  historicalMarkdownRenders: number;
  liveTurnRenders: number;
  liveMarkdownRenders: number;
  longTaskMs: number;
  liveTurnVisible: boolean;
  userScrollPreserved: boolean;
  followBottomResumed: boolean;
  domNodes: number;
  heapBytes: number | null;
}

interface ModeResult {
  mode: Mode;
  coldFocus: Record<string, PhaseSample[]>;
  warmSwitch: PhaseSample[];
  streaming: StreamSample[];
  oversized: {
    exactCharacters: number;
    rawHtmlElements: number;
    remoteImages: number;
    selectedExactly: boolean;
    overflow: string;
  };
}

const desktop = resolve(import.meta.dirname, "..");
const codexMock = join(desktop, "e2e/fixtures/codex");
const measuredSamples = 7;
const warmups = 2;

test("production App keeps settled Focus history out of live-tail rendering cost", async ({}, testInfo) => {
  test.setTimeout(600_000);
  await chmod(codexMock, 0o755);

  const baseline = await runMode("baseline");
  const optimized = await runMode("optimized");

  for (const turns of [10, 100]) {
    const key = String(turns);
    expect(optimized.coldFocus[key]).toHaveLength(measuredSamples);
    expect(baseline.coldFocus[key]).toHaveLength(measuredSamples);
    expect(median(optimized.coldFocus[key]!.map((sample) => sample.firstContentMs)))
      .toBeLessThanOrEqual(regressionLimit(median(baseline.coldFocus[key]!.map((sample) => sample.firstContentMs))));
    expect(median(optimized.coldFocus[key]!.map((sample) => sample.throughPaintMs)))
      .toBeLessThanOrEqual(regressionLimit(median(baseline.coldFocus[key]!.map((sample) => sample.throughPaintMs))));
  }
  expect(optimized.coldFocus["500"]).toHaveLength(measuredSamples);
  expect(baseline.coldFocus["500"]).toHaveLength(measuredSamples);
  expect(median(optimized.coldFocus["500"]!.map((sample) => sample.firstContentMs)))
    .toBeLessThanOrEqual(median(baseline.coldFocus["500"]!.map((sample) => sample.firstContentMs)) * .5);
  expect(median(optimized.coldFocus["500"]!.map((sample) => sample.throughPaintMs)))
    .toBeLessThanOrEqual(median(baseline.coldFocus["500"]!.map((sample) => sample.throughPaintMs)) * .5);
  for (const sample of optimized.coldFocus["500"]!) {
    expect(sample.longTaskMs).toBe(0);
    expect(sample.mountedTurns).toBeLessThanOrEqual(32);
    expect(sample.totalTurns).toBe(500);
  }
  expect(baseline.coldFocus["500"]!.every((sample) => sample.mountedTurns === 500)).toBe(true);
  expect(median(optimized.warmSwitch.map((sample) => sample.throughPaintMs)))
    .toBeLessThanOrEqual(regressionLimit(median(baseline.warmSwitch.map((sample) => sample.throughPaintMs))));

  expect(optimized.streaming).toHaveLength(measuredSamples);
  for (const sample of optimized.streaming) {
    expect(sample.deltaCount).toBe(36);
    expect(sample.historicalTurnRenders).toBe(0);
    expect(sample.historicalMarkdownRenders).toBe(0);
    expect(sample.liveTurnRenders).toBeGreaterThanOrEqual(36);
    expect(sample.liveMarkdownRenders).toBeGreaterThanOrEqual(36);
    expect(sample.longTaskMs).toBe(0);
    expect(sample.liveTurnVisible).toBe(true);
    expect(sample.userScrollPreserved).toBe(true);
    expect(sample.followBottomResumed).toBe(true);
  }
  expect(baseline.streaming.some((sample) => sample.historicalTurnRenders > 0)).toBe(true);
  expect(median(optimized.streaming.map((sample) => sample.medianRendererMs)))
    .toBeLessThanOrEqual(median(baseline.streaming.map((sample) => sample.medianRendererMs)) * .5);

  expect(optimized.oversized).toMatchObject({
    exactCharacters: 200_086,
    rawHtmlElements: 0,
    remoteImages: 0,
    selectedExactly: true,
  });
  expect(["auto", "scroll"]).toContain(optimized.oversized.overflow);

  const result = { baseline, optimized };
  await testInfo.attach("native-transcript-performance.json", {
    body: Buffer.from(JSON.stringify(result, null, 2)),
    contentType: "application/json",
  });
  console.log(`NATIVE_TRANSCRIPT_PERFORMANCE ${JSON.stringify(result)}`);
});

async function runMode(mode: Mode): Promise<ModeResult> {
  const scratch = await mkdtemp(join(tmpdir(), `peel-native-transcript-${mode}-`));
  const userData = join(scratch, "data");
  await mkdir(userData);
  let application: ElectronApplication | null = null;
  try {
    application = await electron.launch({
      args: [desktop, "--js-flags=--expose-gc"],
      env: {
        ...process.env,
        PEEL_RENDERER_URL: "",
        PEEL_NATIVE_TRANSCRIPT_BENCHMARK: mode,
        PEEL_USER_DATA_PATH: userData,
        PEEL_CODEX_BINARY: codexMock,
        TMPDIR: scratch,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
    });
    const page = await application.firstWindow();
    await expect.poll(async () => await page.evaluate(() => window.peel.bootstrap().then((payload) => payload.connected))).toBe(true);

    const streamIds = Array.from({ length: warmups + measuredSamples }, (_, index) => `performance-100-stream-${index + 1}`);
    const threadIds = ["performance-10", "performance-100", "performance-500", "performance-oversized", ...streamIds];
    for (const threadId of threadIds) {
      await page.evaluate(async (id) => { await window.peel.startSpace({ threadId: id }); }, threadId);
    }
    await page.reload();
    await expect.poll(async () => await page.evaluate(() => Boolean(window.__peelTranscriptPerformance))).toBe(true);
    await expect(page.locator(".transcript")).toBeVisible();

    const coldFocus: Record<string, PhaseSample[]> = {};
    for (const turns of [10, 100, 500]) {
      const threadId = `performance-${turns}`;
      for (let index = 0; index < warmups; index += 1) await measureFocus(page, threadId, true);
      coldFocus[String(turns)] = [];
      for (let index = 0; index < measuredSamples; index += 1) coldFocus[String(turns)]!.push(await measureFocus(page, threadId, true));
    }

    for (let index = 0; index < warmups; index += 1) await measureSwitch(page);
    const warmSwitch: PhaseSample[] = [];
    for (let index = 0; index < measuredSamples; index += 1) warmSwitch.push(await measureSwitch(page));

    const streaming: StreamSample[] = [];
    for (let index = 0; index < streamIds.length; index += 1) {
      const sample = await measureStream(page, streamIds[index]!);
      if (index >= warmups) streaming.push(sample);
    }

    await openThread(page, "performance-oversized", true);
    const oversized = await page.locator('[data-rendering-fallback="oversized"]').evaluate((element) => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      const text = element.textContent ?? "";
      const result = {
        exactCharacters: text.length,
        rawHtmlElements: element.querySelectorAll("script, iframe, form, style").length,
        remoteImages: element.querySelectorAll('img[src^="http"]').length,
        selectedExactly: selection?.toString() === text,
        overflow: getComputedStyle(element).overflow,
      };
      selection?.removeAllRanges();
      return result;
    });

    return { mode, coldFocus, warmSwitch, streaming, oversized };
  } finally {
    await application?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

async function measureFocus(page: Page, threadId: string, cold: boolean): Promise<PhaseSample> {
  const snapshot = await openThread(page, threadId, cold);
  const update = latestRead(snapshot);
  const navigation = snapshot.navigations.at(-1)!;
  return {
    threadReadMs: update.threadReadMs ?? 0,
    snapshotConstructionMs: update.snapshotConstructionMs,
    ipcDeliveryMs: update.ipcDeliveryMs,
    reconciliationMs: update.reconciliationMs,
    reactRenderToCommitMs: update.reactRenderToCommitMs,
    commitToPaintMs: update.commitToPaintMs,
    firstContentMs: navigation.firstContentToCommitMs,
    throughPaintMs: navigation.firstContentToCommitMs + navigation.commitToPaintMs,
    longTaskMs: snapshot.longTaskMs,
    domNodes: snapshot.domNodes,
    mountedTurns: snapshot.mountedTurns,
    totalTurns: snapshot.totalTurns,
    heapBytes: snapshot.heapBytes,
  };
}

async function measureSwitch(page: Page): Promise<PhaseSample> {
  await openThread(page, "performance-10", false);
  return await measureFocus(page, "performance-500", false);
}

async function measureStream(page: Page, threadId: string): Promise<StreamSample> {
  await openThread(page, threadId, true);
  await page.evaluate(() => window.__peelTranscriptPerformance!.reset());
  await page.evaluate(async (id) => {
    await window.peel.sendTurn({
      threadId: id,
      cwd: "/tmp/project",
      input: [{ type: "text", text: "__PEEL_PERF_STREAM_36__", text_elements: [] }],
    });
  }, threadId);
  const transcript = page.locator(".transcript");
  const liveTurn = page.locator('[data-turn-id="turn-101"]');
  await expect(liveTurn).toBeVisible();
  const liveTurnVisible = await liveTurn.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const viewport = document.querySelector<HTMLElement>(".transcript")!.getBoundingClientRect();
    return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
  });
  const detachedScrollTop = await transcript.evaluate((element) => {
    element.scrollTop = Math.min(320, Math.max(200, element.scrollHeight - element.clientHeight - 400));
    element.dispatchEvent(new Event("scroll"));
    return element.scrollTop;
  });
  await expect.poll(async () => await page.evaluate(() => window.__peelTranscriptPerformance!.snapshot().updates
    .filter((update) => update.method === "item/agentMessage/delta").length), { timeout: 30_000 }).toBeGreaterThanOrEqual(18);
  const userScrollPreserved = await transcript.evaluate((element, expected) => Math.abs(element.scrollTop - expected) <= 1, detachedScrollTop);
  await transcript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(async () => await page.evaluate(() => window.__peelTranscriptPerformance!.snapshot().updates
    .filter((update) => update.method === "item/agentMessage/delta").length), { timeout: 30_000 }).toBe(36);
  await expect.poll(async () => await page.evaluate(() => window.__peelTranscriptPerformance!.snapshot().updates
    .some((update) => update.method === "turn/completed")), { timeout: 30_000 }).toBe(true);
  const snapshot = await page.evaluate(() => window.__peelTranscriptPerformance!.snapshot());
  const followBottomResumed = await transcript.evaluate((element) =>
    element.scrollHeight - element.scrollTop - element.clientHeight <= 1);
  const deltas = snapshot.updates.filter((update) => update.method === "item/agentMessage/delta");
  const historicalPrefix = `${threadId}-turn-`;
  const liveTurnId = "turn-101";
  return {
    deltaCount: deltas.length,
    medianRendererMs: median(deltas.map(rendererMs)),
    historicalTurnRenders: sumEntries(snapshot.turnRenders, (id) => id.startsWith(historicalPrefix)),
    historicalMarkdownRenders: sumEntries(snapshot.markdownRenders, (id) => id.startsWith(historicalPrefix)),
    liveTurnRenders: snapshot.turnRenders[liveTurnId] ?? 0,
    liveMarkdownRenders: snapshot.markdownRenders[`${liveTurnId}-a`] ?? 0,
    longTaskMs: snapshot.longTaskMs,
    liveTurnVisible,
    userScrollPreserved,
    followBottomResumed,
    domNodes: snapshot.domNodes,
    heapBytes: snapshot.heapBytes,
  };
}

async function openThread(page: Page, threadId: string, cold: boolean): Promise<TranscriptPerformanceSnapshot> {
  await page.evaluate(({ id, clear }) => {
    const performanceApi = window.__peelTranscriptPerformance!;
    performanceApi.reset();
    performanceApi.openThread(id, clear);
  }, { id: threadId, clear: cold });
  await page.evaluate(async () => await window.__peelTranscriptPerformance!.waitForNavigations(1, 30_000));
  return await page.evaluate(async () => await window.__peelTranscriptPerformance!.waitForUpdates(1, 30_000));
}

function latestRead(snapshot: TranscriptPerformanceSnapshot): TranscriptUpdateMeasurement {
  const update = [...snapshot.updates].reverse().find((candidate) => candidate.method === "thread/read");
  if (!update) throw new Error("Focus measurement did not record a thread/read update");
  return update;
}

function rendererMs(update: TranscriptUpdateMeasurement): number {
  return update.reconciliationMs + update.reactRenderToCommitMs;
}

function sumEntries(values: Record<string, number>, include: (id: string) => boolean): number {
  return Object.entries(values).filter(([id]) => include(id)).reduce((sum, [, count]) => sum + count, 0);
}

function regressionLimit(baseline: number): number {
  return baseline + Math.max(baseline * .1, 5);
}

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2 : ordered[middle] ?? 0;
}
