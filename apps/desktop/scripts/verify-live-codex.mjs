import { _electron as electron } from "playwright";
import { AppServerClient, AppServerTransport } from "@peel/codex-app-server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const executable = join(desktopRoot, "out/Peel-darwin-arm64/Peel.app/Contents/MacOS/Peel");
const scratch = await mkdtemp(join(tmpdir(), "peel-live-codex-"));
let application;
try {
  const transport = new AppServerTransport({ reconnect: false, requestTimeoutMs: 30_000 });
  const client = new AppServerClient(transport);
  const connectionStartedAt = performance.now();
  let transportReadyAt = 0;
  let ordinaryListRequestedAt = 0;
  let ordinaryListCompletedAt = 0;
  let ordinaryListPromise;
  transport.once("ready", () => {
    transportReadyAt = performance.now();
    ordinaryListRequestedAt = performance.now();
    ordinaryListPromise = client.listThreads({
      cursor: null,
      limit: 30,
      sortKey: "updated_at",
      sortDirection: "desc",
    }).then((response) => {
      ordinaryListCompletedAt = performance.now();
      return response;
    });
  });
  let directProbe;
  try {
    await client.connect();
    if (!ordinaryListPromise || !transportReadyAt || !ordinaryListRequestedAt) {
      throw new Error("The ordinary recent-list probe did not start when transport became ready");
    }
    const ordinaryList = await ordinaryListPromise;
    directProbe = {
      transportConnectMs: Math.round(transportReadyAt - connectionStartedAt),
      transportReadyToListRequestMs: Math.round(ordinaryListRequestedAt - transportReadyAt),
      ordinaryRecentListMs: Math.round(ordinaryListCompletedAt - ordinaryListRequestedAt),
      ordinaryRecentListThreads: ordinaryList.data.length,
      ordinaryRecentListSearchTerm: "omitted",
    };
  } finally {
    await transport.shutdown().catch(() => undefined);
  }

  const launchStartedAt = performance.now();
  application = await electron.launch({
    executablePath: executable,
    env: { ...process.env, PEEL_USER_DATA_PATH: join(scratch, "user-data"), ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  const page = await application.firstWindow();
  const search = page.locator(".welcome").getByRole("button", { name: "Search Chats", exact: true });
  await search.waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll(".welcome button")].find((candidate) => candidate.textContent?.includes("Search Chats"));
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 20_000 });
  const launchToSearchReadyMs = Math.round(performance.now() - launchStartedAt);
  const coldPickerStartedAt = performance.now();
  await search.click();
  await page.locator(".thread-result").first().waitFor({ state: "visible", timeout: 20_000 });
  const coldPickerFirstContentMs = Math.round(performance.now() - coldPickerStartedAt);
  const firstPageThreads = await page.locator(".thread-result").count();
  const loadMore = page.getByRole("button", { name: "Load more" });
  const hadNextCursor = await loadMore.isVisible();
  if (hadNextCursor) {
    await loadMore.click();
    await page.waitForFunction((count) => document.querySelectorAll(".thread-result").length > count, firstPageThreads, { timeout: 20_000 });
  }
  const listedThreads = await page.locator(".thread-result").count();
  await page.locator(".picker-header .icon-button").click();
  const warmPickerFirstContentMs = await page.evaluate(async () => {
    const choose = [...document.querySelectorAll(".welcome button, .space-sidebar button")]
      .find((button) => button.textContent?.includes("Search Chats"));
    if (!choose) throw new Error("Search Chats button was missing");
    const started = performance.now();
    choose.click();
    while (!document.querySelector(".thread-result")) await new Promise(requestAnimationFrame);
    return Math.round(performance.now() - started);
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    connectedToLocalCodex: true,
    ...directProbe,
    launchToSearchReadyMs,
    coldPickerFirstContentMs,
    warmPickerFirstContentMs,
    firstPageThreads,
    hadNextCursor,
    listedThreads,
  })}\n`);
} finally {
  await application?.close();
  await rm(scratch, { recursive: true, force: true });
}
