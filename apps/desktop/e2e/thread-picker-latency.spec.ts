import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const codexMock = join(here, "fixtures/codex");
let scratch = "";
let repository = "";
let userData = "";
let rpcLog = "";
let app: ElectronApplication | null = null;
let page: Page;

test.beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "peel-picker-e2e-"));
  repository = join(scratch, "repository");
  userData = join(scratch, "user-data");
  rpcLog = join(repository, "peel-mock-rpc.jsonl");
  await chmod(codexMock, 0o755);
  await exec("git", ["init", "--initial-branch=main", repository]);
  await exec("git", ["config", "user.email", "peel@example.test"], { cwd: repository });
  await exec("git", ["config", "user.name", "Peel Test"], { cwd: repository });
  await writeFile(join(repository, "README.md"), "# Peel picker fixture\n");
  await writeFile(join(repository, "delay-thread-list-warm"), "1");
  await exec("git", ["add", "README.md"], { cwd: repository });
  await exec("git", ["commit", "-m", "fixture"], { cwd: repository });
});

test.afterAll(async () => {
  await app?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function readRpcEvents(): Promise<Array<{ method?: string; params?: Record<string, unknown> }>> {
  const content = await readFile(rpcLog, "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

test("recent Chats share warmup, omit empty searchTerm, and reopen immediately", async () => {
  test.setTimeout(30_000);
  app = await electron.launch({
    args: [desktopRoot],
    env: {
      ...process.env,
      PATH: `${dirname(codexMock)}:${process.env.PATH}`,
      PEEL_CODEX_BINARY: codexMock,
      PEEL_USER_DATA_PATH: userData,
      TMPDIR: repository,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const search = page.locator(".welcome").getByRole("button", { name: "Search Chats", exact: true });
  await expect(search).toBeEnabled();
  await expect.poll(async () => (await readRpcEvents()).filter((event) => event.method === "thread/list").length).toBe(1);
  const warmRequest = (await readRpcEvents()).find((event) => event.method === "thread/list");
  expect(warmRequest?.params).toBeDefined();
  expect(warmRequest?.params).not.toHaveProperty("searchTerm");

  await search.click();
  await expect(page.getByLabel("Search Codex Chats")).toBeEditable();
  await expect(page.getByText("Loading recent Codex Chats…")).toBeVisible();
  expect((await readRpcEvents()).filter((event) => event.method === "thread/list")).toHaveLength(1);
  await expect(page.locator(".thread-result")).toHaveCount(30);
  expect((await readRpcEvents()).filter((event) => event.method === "thread/list")).toHaveLength(1);

  await page.getByRole("button", { name: "Close Chat picker" }).click();
  const warmPickerFirstContentMs = await page.evaluate(async () => {
    const choose = [...document.querySelectorAll<HTMLButtonElement>(".welcome button")]
      .find((button) => button.textContent?.includes("Search Chats"));
    if (!choose) throw new Error("Search Chats button was missing");
    const started = performance.now();
    choose.click();
    while (!document.querySelector(".thread-result")) await new Promise(requestAnimationFrame);
    return performance.now() - started;
  });
  expect(warmPickerFirstContentMs).toBeLessThan(100);
  expect((await readRpcEvents()).filter((event) => event.method === "thread/list")).toHaveLength(1);

  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.locator(".thread-result")).toHaveCount(60);
  const nextPageRequest = (await readRpcEvents()).find((event) =>
    event.method === "thread/list" && event.params?.cursor === "offset:30"
  );
  expect(nextPageRequest?.params).toBeDefined();
  expect(nextPageRequest?.params).not.toHaveProperty("searchTerm");

  await page.getByLabel("Search Codex Chats").fill("Catalog direction 05");
  await expect.poll(async () => (await readRpcEvents()).some((event) =>
    event.method === "thread/list" && event.params?.searchTerm === "Catalog direction 05"
  )).toBe(true);
  await expect(page.locator(".thread-result strong")).toHaveText("Catalog direction 05");
});
