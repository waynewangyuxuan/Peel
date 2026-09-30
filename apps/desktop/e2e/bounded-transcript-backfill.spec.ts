import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { TranscriptPerformanceSnapshot } from "../src/renderer/transcript-performance";

const desktop = resolve(import.meta.dirname, "..");
const codexMock = join(desktop, "e2e/fixtures/codex");
const boundedThreadId = "b5000000-0000-4000-8000-000000000500";

test("bounded Focus history preserves anchors, selection, images, and Branch navigation", async () => {
  test.setTimeout(180_000);
  await chmod(codexMock, 0o755);
  const scratch = await mkdtemp(join(tmpdir(), "peel-bounded-transcript-"));
  const userData = join(scratch, "data");
  const attachmentPath = join(scratch, "pixel.png");
  await mkdir(userData);
  await writeFile(attachmentPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  let application: ElectronApplication | null = null;
  try {
    application = await electron.launch({
      args: [desktop],
      env: {
        ...process.env,
        PEEL_RENDERER_URL: "",
        PEEL_NATIVE_TRANSCRIPT_BENCHMARK: "optimized",
        PEEL_USER_DATA_PATH: userData,
        PEEL_CODEX_BINARY: codexMock,
        TMPDIR: scratch,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
    });
    await application.evaluate(({ shell }) => {
      const audit = { urls: [] as string[] };
      (globalThis as typeof globalThis & { peelBoundedOpenAudit: typeof audit }).peelBoundedOpenAudit = audit;
      Object.defineProperty(shell, "openExternal", {
        configurable: true,
        value: async (url: string) => { audit.urls.push(url); },
      });
    });
    let page = await application.firstWindow();
    await expect.poll(async () => await page.evaluate(() => window.peel.bootstrap().then((payload) => payload.connected))).toBe(true);
    await expect(page.locator(".app")).toBeVisible();
    const fixtureThreads = await page.evaluate(async (threadIds) => {
      let finalState = (await window.peel.bootstrap()).state;
      for (const threadId of threadIds) finalState = await window.peel.startSpace({ threadId });
      await window.peel.saveState(finalState);
      return Object.values(finalState.spaces).flatMap((space) => Object.keys(space.nodes));
    }, [boundedThreadId, "performance-100", "performance-10"]);
    expect(fixtureThreads).toEqual(expect.arrayContaining([boundedThreadId, "performance-100", "performance-10"]));
    await page.reload();
    await expect.poll(async () => await page.evaluate(() => Boolean(window.__peelTranscriptPerformance))).toBe(true);
    await expect(page.locator(".transcript")).toBeVisible();

    await openThread(page, boundedThreadId, true);
    const transcript = page.locator(".transcript");
    await expect(transcript).toHaveAttribute("data-mounted-turns", "32");
    await expect(transcript).toHaveAttribute("data-total-turns", "500");
    await expect(page.locator('[data-turn-id="bounded-backfill-500-turn-500"]')).toBeVisible();
    await expect(page.locator('[data-turn-id="bounded-backfill-500-turn-1"]')).toHaveCount(0);
    expect(await transcript.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(1);

    const localImage = page.locator('img[alt="bounded local image"]');
    await page.locator('[data-turn-id="bounded-backfill-500-turn-490"]').scrollIntoViewIfNeeded();
    await expect(localImage).toBeVisible();
    await expect(page.locator('img[src^="http"]')).toHaveCount(0);
    await expect(page.getByText("remote image", { exact: true })).toBeVisible();
    const imageSizing = await localImage.evaluate((image) => ({
      width: image.getBoundingClientRect().width,
      parentWidth: image.parentElement?.getBoundingClientRect().width ?? 0,
      naturalWidth: (image as HTMLImageElement).naturalWidth,
    }));
    expect(imageSizing.naturalWidth).toBe(320);
    expect(imageSizing.width).toBeLessThanOrEqual(imageSizing.parentWidth + 1);

    const imageAnchorShift = await page.evaluate(async () => {
      const scroller = document.querySelector<HTMLElement>(".transcript")!;
      const anchor = document.querySelector<HTMLElement>('[data-turn-id="bounded-backfill-500-turn-495"]')!;
      const image = document.querySelector<HTMLImageElement>('img[alt="bounded local image"]')!;
      anchor.scrollIntoView({ block: "start" });
      scroller.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const before = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#c7d9cf"/></svg>';
      const blobUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      await new Promise<void>((resolve) => {
        image.addEventListener("load", () => resolve(), { once: true });
        image.src = blobUrl;
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const after = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const result = { shift: Math.abs(after - before), src: image.src, width: image.getBoundingClientRect().width, parentWidth: image.parentElement?.getBoundingClientRect().width ?? 0 };
      URL.revokeObjectURL(blobUrl);
      return result;
    });
    expect(imageAnchorShift.src.startsWith("blob:")).toBe(true);
    expect(imageAnchorShift.width).toBeLessThanOrEqual(imageAnchorShift.parentWidth + 1);
    expect(imageAnchorShift.shift).toBeLessThanOrEqual(1);

    await page.evaluate(() => window.__peelTranscriptPerformance!.reset());
    const selectionBefore = await selectAcrossTurns(page, "bounded-backfill-500-turn-472", "bounded-backfill-500-turn-474");
    const anchorBeforePrepend = await transcript.evaluate((element) => {
      element.scrollTop = 0;
      return document.querySelector<HTMLElement>('[data-turn-id="bounded-backfill-500-turn-472"]')!.getBoundingClientRect().top - element.getBoundingClientRect().top;
    });
    await expect.poll(async () => Number(await transcript.getAttribute("data-mounted-turns"))).toBeGreaterThan(32);
    const anchorAfterPrepend = await page.locator('[data-turn-id="bounded-backfill-500-turn-472"]').evaluate((turn, selector) =>
      turn.getBoundingClientRect().top - document.querySelector<HTMLElement>(selector)!.getBoundingClientRect().top, ".transcript");
    expect(Math.abs(anchorAfterPrepend - anchorBeforePrepend)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe(selectionBefore);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());

    await page.locator(".transcript-history-boundary").click();
    const liveDraft = page.getByLabel("Message");
    await liveDraft.fill("Composer stays operable during historical backfill");
    const copy = page.locator('[data-turn-id="bounded-backfill-500-turn-500"] .copy-code');
    await copy.click();
    await expect(copy).toContainText("Copied");
    await page.locator('[data-turn-id="bounded-backfill-500-turn-500"]').getByRole("button", { name: "Branch from here" }).click();
    await expect(page.locator(".fork-surface")).toBeVisible();
    await page.getByRole("button", { name: "Cancel fork" }).click();
    await expect(liveDraft).toHaveValue("Composer stays operable during historical backfill");
    const openCodexActivity = page.locator('[data-turn-id="bounded-backfill-500-turn-473"] .activity-item');
    await openCodexActivity.locator("summary").click();
    await openCodexActivity.locator(".open-codex-item").click();
    await expect.poll(async () => await application!.evaluate(() =>
      (globalThis as typeof globalThis & { peelBoundedOpenAudit: { urls: string[] } }).peelBoundedOpenAudit.urls
    )).toEqual([`codex://threads/${boundedThreadId}`]);
    await liveDraft.fill("Exercise every server request route");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const liveTurn = page.locator('[data-turn-id="turn-501"]');
    const commandApproval = liveTurn.locator(".request-command-approval").filter({ hasText: "npm test --replacement" });
    await expect(commandApproval).toBeVisible();
    await commandApproval.getByRole("button", { name: "Allow once" }).click();
    await expect(liveTurn.locator(".codex-notice.error")).toContainText("The service briefly failed");
    await page.locator('.composer input[type="file"]').setInputFiles(attachmentPath);
    await expect(page.locator(".attachment")).toContainText("Image");
    await page.locator(".attachment button").click();
    await expect(page.locator(".attachment")).toHaveCount(0);
    await expect(transcript).toHaveAttribute("data-mounted-turns", "501", { timeout: 60_000 });
    expect(await page.locator("[data-turn-id]").count()).toBe(501);
    await expect(page.locator('[data-turn-id="bounded-backfill-500-turn-20"]').getByText("Reasoning", { exact: true })).toBeVisible();
    await expect(page.locator('[data-turn-id="bounded-backfill-500-turn-30"]').getByText("Ran a command", { exact: true })).toBeVisible();
    await expect(page.locator('[data-turn-id="bounded-backfill-500-turn-40"]').getByText("Updated src/bounded.ts", { exact: true })).toBeVisible();
    await expect(page.locator('[data-turn-id="bounded-backfill-500-turn-50"]').getByText("Worked with a subagent", { exact: true })).toBeVisible();
    await expect(page.locator('[data-turn-id="bounded-backfill-500-turn-60"]').getByText("Something needs attention", { exact: true })).toBeVisible();
    await expect(page.locator('[data-turn-id="bounded-backfill-500-turn-70"] .katex')).toBeAttached();
    await expect(page.locator('[data-turn-id="bounded-backfill-500-turn-499"] .activity-label')).toHaveText("Additional Codex activity");
    await page.locator('[data-turn-id="bounded-backfill-500-turn-20"]').getByRole("button", { name: "Branch from here" }).click();
    await expect(page.locator(".fork-surface")).toBeVisible();
    await page.getByRole("button", { name: "Cancel fork" }).click();

    const distantSelection = await selectAcrossTurns(page, "bounded-backfill-500-turn-1", "bounded-backfill-500-turn-500");
    expect(distantSelection).toContain("Prompt 1 in the 500-Turn transcript");
    expect(distantSelection).toContain("Prompt 500 in the 500-Turn transcript");
    const backfillSnapshot = await page.evaluate(() => window.__peelTranscriptPerformance!.snapshot());
    const backfill = backfillSnapshot.backfillTasks;
    expect(backfill.length).toBeGreaterThan(1);
    expect(backfillSnapshot.longTaskDurations).toEqual([]);
    expect(Math.max(...backfill.map((task) => task.anchorDeltaPx))).toBeLessThanOrEqual(1);

    const savedOffset = await page.evaluate(() => {
      const element = document.querySelector<HTMLElement>(".transcript")!;
      const turn = document.querySelector<HTMLElement>('[data-turn-id="bounded-backfill-500-turn-211"]')!;
      turn.scrollIntoView({ block: "start" });
      element.scrollTop += 24;
      element.dispatchEvent(new Event("scroll"));
      return turn.getBoundingClientRect().top - element.getBoundingClientRect().top;
    });
    await page.waitForTimeout(750);
    await openThread(page, "performance-10", false);
    const restored = await openThread(page, boundedThreadId, true);
    expect(restored.mountedTurns).toBeLessThanOrEqual(40);
    await expect(page.locator('[data-turn-id="bounded-backfill-500-turn-211"]')).toBeVisible();
    expect(Math.abs(await turnOffset(page, "bounded-backfill-500-turn-211") - savedOffset)).toBeLessThanOrEqual(1);

    await page.waitForTimeout(750);
    await application.close();
    application = await electron.launch({
      args: [desktop],
      env: {
        ...process.env,
        PEEL_RENDERER_URL: "",
        PEEL_NATIVE_TRANSCRIPT_BENCHMARK: "optimized",
        PEEL_USER_DATA_PATH: userData,
        PEEL_CODEX_BINARY: codexMock,
        TMPDIR: scratch,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
    });
    page = await application.firstWindow();
    await expect.poll(async () => await page.evaluate(() => window.peel.bootstrap().then((payload) => payload.connected))).toBe(true);
    await expect(page.locator('[data-turn-id="bounded-backfill-500-turn-211"]')).toBeVisible();
    expect(Math.abs(await turnOffset(page, "bounded-backfill-500-turn-211") - savedOffset)).toBeLessThanOrEqual(1);

    await installParentChildFixture(page);
    await page.reload();
    await expect(page.getByRole("button", { name: /Branched from/ })).toBeVisible();
    await page.getByRole("button", { name: /Branched from/ }).click();
    const highlighted = page.locator('[data-turn-id="bounded-backfill-500-turn-123"].highlighted');
    await expect(highlighted).toBeVisible();
    await highlighted.getByRole("button", { name: "Branch from here" }).click();
    await expect(page.locator(".fork-surface")).toBeVisible();
  } finally {
    await application?.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

async function openThread(page: Page, threadId: string, cold: boolean): Promise<TranscriptPerformanceSnapshot> {
  await page.evaluate(({ id, clear }) => {
    const api = window.__peelTranscriptPerformance!;
    api.reset();
    api.openThread(id, clear);
  }, { id: threadId, clear: cold });
  await page.evaluate(async () => await window.__peelTranscriptPerformance!.waitForNavigations(1, 30_000));
  return await page.evaluate(async () => await window.__peelTranscriptPerformance!.waitForUpdates(1, 30_000));
}

async function selectAcrossTurns(page: Page, firstId: string, lastId: string): Promise<string> {
  return await page.evaluate(({ first, last }) => {
    const firstMessage = document.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(first)}"] .user-message`)!;
    const lastMessage = document.querySelector<HTMLElement>(`[data-turn-id="${CSS.escape(last)}"] .user-message`)!;
    const range = document.createRange();
    range.selectNodeContents(firstMessage);
    range.setEndAfter(lastMessage);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  }, { first: firstId, last: lastId });
}

async function turnOffset(page: Page, turnId: string): Promise<number> {
  return await page.locator(`[data-turn-id="${turnId}"]`).evaluate((turn) =>
    turn.getBoundingClientRect().top - document.querySelector<HTMLElement>(".transcript")!.getBoundingClientRect().top);
}

async function installParentChildFixture(page: Page): Promise<void> {
  await page.evaluate(async (parentThreadId) => {
    const bootstrap = await window.peel.bootstrap();
    const state = bootstrap.state;
    const parentSpace = Object.values(state.spaces).find((space) => space.nodes[parentThreadId]);
    const childSpace = Object.values(state.spaces).find((space) => space.nodes["performance-10"]);
    if (!parentSpace || !childSpace) throw new Error("Missing performance fixture Spaces");
    parentSpace.nodes["performance-10"] = {
      ...structuredClone(childSpace.nodes["performance-10"]!),
      parentThreadId,
      forkedAtTurnId: "bounded-backfill-500-turn-123",
    };
    parentSpace.updatedAt = Date.now();
    state.activeSpaceId = parentSpace.id;
    state.activeThreadId = "performance-10";
    state.viewMode = "focus";
    await window.peel.saveState(state);
  }, boundedThreadId);
}
