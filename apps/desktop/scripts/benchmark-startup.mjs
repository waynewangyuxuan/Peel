import { _electron as electron } from "playwright";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const executable = join(desktopRoot, "out/Peel-darwin-arm64/Peel.app/Contents/MacOS/Peel");
const codexMock = join(desktopRoot, "e2e/fixtures/codex");
const sampleCount = Math.max(1, Number(process.env.PEEL_STARTUP_SAMPLES) || 7);
const label = process.env.PEEL_STARTUP_LABEL || "startup";
const samples = [];

await chmod(codexMock, 0o755);
for (let index = 0; index < sampleCount; index += 1) {
  const scratch = await mkdtemp(join(tmpdir(), `peel-${label}-`));
  let application;
  try {
    const startedAt = Date.now();
    application = await electron.launch({
      executablePath: executable,
      env: {
        ...process.env,
        PEEL_USER_DATA_PATH: join(scratch, "data"),
        PEEL_CODEX_BINARY: codexMock,
        TMPDIR: scratch,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
    });
    const page = await application.firstWindow();
    const firstWindowMs = Date.now() - startedAt;
    await page.locator(".welcome, .app").first().waitFor({ state: "visible", timeout: 20_000 });
    const localShellMs = Date.now() - startedAt;
    const search = page.getByRole("button", { name: "Search Chats", exact: true }).last();
    await search.waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("Search Chats"));
      return button instanceof HTMLButtonElement && !button.disabled;
    }, undefined, { timeout: 20_000 });
    const connectedActionMs = Date.now() - startedAt;
    const paint = await page.evaluate(() => {
      const firstPaint = performance.getEntriesByName("first-paint")[0];
      const contentful = performance.getEntriesByName("first-contentful-paint")[0];
      return {
        firstPaintEpochMs: firstPaint ? Math.round(performance.timeOrigin + firstPaint.startTime) : null,
        firstContentfulPaintEpochMs: contentful ? Math.round(performance.timeOrigin + contentful.startTime) : null,
      };
    });
    const rpc = await readRpcEvents(join(scratch, "peel-mock-rpc.jsonl"));
    const initialize = rpc.find((event) => event.method === "initialize");
    const firstReadyRequest = rpc.find((event) => event.method === "thread/list");
    samples.push({
      firstWindowMs,
      firstPaintMs: paint.firstPaintEpochMs === null ? null : paint.firstPaintEpochMs - startedAt,
      firstContentfulPaintMs: paint.firstContentfulPaintEpochMs === null ? null : paint.firstContentfulPaintEpochMs - startedAt,
      localShellMs,
      initializeRequestMs: initialize?.atMs ? initialize.atMs - startedAt : null,
      transportReadyMs: firstReadyRequest?.atMs ? firstReadyRequest.atMs - startedAt : null,
      connectedActionMs,
    });
  } finally {
    await application?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

const median = (key) => {
  const values = samples.map((sample) => sample[key]).filter((value) => typeof value === "number").sort((a, b) => a - b);
  return values[Math.floor(values.length / 2)] ?? null;
};

const metrics = ["firstWindowMs", "firstPaintMs", "firstContentfulPaintMs", "localShellMs", "initializeRequestMs", "transportReadyMs", "connectedActionMs"];
process.stdout.write(`${JSON.stringify({
  label,
  sampleCount,
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  samples,
  medians: Object.fromEntries(metrics.map((metric) => [metric, median(metric)])),
}, null, 2)}\n`);

async function readRpcEvents(path) {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
