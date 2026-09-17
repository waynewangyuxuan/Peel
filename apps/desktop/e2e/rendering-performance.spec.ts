import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { BenchmarkRenderer, RenderingBenchmarkResult } from "../src/renderer/RenderingBenchmark";
import { expectedCopiedCode } from "../src/renderer/rendering-benchmark-corpus";

const desktop = resolve(import.meta.dirname, "..");
const codexMock = join(desktop, "e2e/fixtures/codex");

test("production Electron compares current Markdown with the isolated Streamdown prototype", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const scratch = await mkdtemp(join(tmpdir(), "peel-rendering-benchmark-"));
  const userData = join(scratch, "data");
  await mkdir(userData);
  await chmod(codexMock, 0o755);
  let application: ElectronApplication | null = null;
  try {
    application = await electron.launch({
      args: [desktop, "--js-flags=--expose-gc"],
      env: {
        ...process.env,
        PEEL_RENDERER_URL: "",
        PEEL_RENDERING_BENCHMARK: "1",
        PEEL_USER_DATA_PATH: userData,
        PEEL_CODEX_BINARY: codexMock,
        TMPDIR: scratch,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
    });
    const page = await application.firstWindow();
    await expect(page.getByText("Peel rendering benchmark")).toBeVisible();
    await expect.poll(async () => await page.evaluate(() => Boolean(window.__peelRenderingBenchmark))).toBe(true);

    const current = await runSuite(page, "current");
    assertSharedContract(current);
    expect((await application.evaluate(({ clipboard }) => clipboard.readText())).trimEnd()).toBe(expectedCopiedCode);
    expect(current.correctness.oversizedFallback).toBe(false);
    expect(current.correctness.errorFallback).toBe(false);

    const streamdown = await runSuite(page, "streamdown");
    expect((await application.evaluate(({ clipboard }) => clipboard.readText())).trimEnd()).toBe(expectedCopiedCode);
    assertSharedContract(streamdown);
    expect(streamdown.correctness.oversizedFallback).toBe(true);
    expect(streamdown.correctness.errorFallback).toBe(true);

    expect(streamdown.streaming.historicalRowRenders).toBe(0);
    expect(streamdown.streaming.tailRowRenders).toBe(streamdown.streaming.updates);
    expect(current.streaming.historicalRowRenders).toBe(0);
    expect(current.streaming.tailRowRenders).toBe(current.streaming.updates);

    const results = { current, streamdown };
    await testInfo.attach("rendering-benchmark.json", {
      body: Buffer.from(JSON.stringify(results, null, 2)),
      contentType: "application/json",
    });
    console.log(`RENDERING_BENCHMARK ${JSON.stringify(results)}`);
  } finally {
    await application?.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

async function runSuite(page: import("@playwright/test").Page, renderer: BenchmarkRenderer): Promise<RenderingBenchmarkResult> {
  return await page.evaluate(async (selected) => {
    if (!window.__peelRenderingBenchmark) throw new Error("Rendering benchmark API was not installed");
    return await window.__peelRenderingBenchmark.runSuite(selected);
  }, renderer);
}

function assertSharedContract(result: RenderingBenchmarkResult): void {
  expect(result.environment.productionBuild).toBe(true);
  expect(result.environment.threadReadMs).toBe(0);
  expect(result.firstContent.coldMs).toBeGreaterThan(0);
  expect(result.firstContent.warmMs).toBeGreaterThan(0);
  expect(result.transcriptMounts.map((entry) => entry.turns)).toEqual([10, 100, 500]);
  expect(result.transcriptMounts.every((entry) => entry.domNodes > 0)).toBe(true);
  expect(result.sessionSwitch).toMatchObject({ fromTurns: 10, toTurns: 500 });
  expect(result.correctness).toMatchObject({
    corpusCases: 8,
    katexBlocks: 3,
    remoteImages: 0,
    embeddedImages: 1,
    unsafeScriptExecuted: false,
    unsafeImageExecuted: false,
    clippedMathBlocks: 0,
    pageFits: true,
    partialTextPresent: true,
    safeLinksHardened: true,
    remoteImageLinkPresent: true,
    exactCodeText: true,
    codeCopyControl: true,
  });
}
