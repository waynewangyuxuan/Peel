import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const codexMock = join(here, "fixtures/codex");
const speechHelper = join(here, "fixtures/speech-helper");
const captureRoot = resolve(desktopRoot, "../../docs/review/semantic-zoom");
const rootTitle = "Review Inkstone Legacy product migration and narrative architecture across multiple directions";

let scratch = "";
let repository = "";
let userData = "";
let app: ElectronApplication | null = null;
let page: Page;

test.beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "peel-screenshot-"));
  repository = join(scratch, "repository");
  userData = join(scratch, "user-data");
  await mkdir(captureRoot, { recursive: true });
  await chmod(codexMock, 0o755);
  await chmod(speechHelper, 0o755);
  await exec("git", ["init", "--initial-branch=main", repository]);
  await exec("git", ["config", "user.email", "peel@example.test"], { cwd: repository });
  await exec("git", ["config", "user.name", "Peel Screenshot"], { cwd: repository });
  await writeFile(join(repository, "README.md"), "# Peel screenshot fixture\n");
  await exec("git", ["add", "README.md"], { cwd: repository });
  await exec("git", ["commit", "-m", "fixture"], { cwd: repository });

  app = await electron.launch({
    args: [desktopRoot],
    env: {
      ...process.env,
      PATH: `${dirname(codexMock)}:${process.env.PATH}`,
      PEEL_CODEX_BINARY: codexMock,
      PEEL_USER_DATA_PATH: userData,
      PEEL_VOICE_HELPER: speechHelper,
      TMPDIR: repository,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
});

test.afterAll(async () => {
  await app?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function reloadIntoOverview(scale: number, x: number, y: number): Promise<void> {
  await page.evaluate(async ({ scale, x, y }) => {
    const payload = await window.peel.bootstrap();
    const state = structuredClone(payload.state);
    const spaceId = state.activeSpaceId;
    if (!spaceId) throw new Error("No active Space");
    const space = state.spaces[spaceId];
    if (!space) throw new Error("Active Space is missing");
    const root = space.nodes[space.rootThreadId];
    if (!root) throw new Error("Root node is missing");

    space.name = "Peel interface refinement";
    space.nodes = {
      [root.threadId]: { ...root, position: { x: 0, y: 0 }, title: "Spatial workspace foundation", titleOrigin: "manual" },
      "catalog-01": {
        threadId: "catalog-01",
        parentThreadId: root.threadId,
        forkedAtTurnId: "turn-1",
        createdAt: root.createdAt + 1,
        position: { x: 360, y: -170 },
        title: "Simplify the navigation shell",
        titleOrigin: "manual",
        cwd: root.cwd,
        worktreeName: null,
        lastViewedTurnId: null,
      },
      "catalog-02": {
        threadId: "catalog-02",
        parentThreadId: root.threadId,
        forkedAtTurnId: "turn-2",
        createdAt: root.createdAt + 2,
        position: { x: 360, y: 120 },
        title: "Make branch status instantly legible",
        titleOrigin: "manual",
        cwd: root.cwd,
        worktreeName: "peel/status-language",
        lastViewedTurnId: null,
      },
      "catalog-03": {
        threadId: "catalog-03",
        parentThreadId: "catalog-01",
        forkedAtTurnId: "turn-1",
        createdAt: root.createdAt + 3,
        position: { x: 720, y: -170 },
        title: "Increase typography and reading rhythm",
        titleOrigin: "manual",
        cwd: root.cwd,
        worktreeName: null,
        lastViewedTurnId: null,
      },
      "catalog-04": {
        threadId: "catalog-04",
        parentThreadId: "catalog-02",
        forkedAtTurnId: "turn-2",
        createdAt: root.createdAt + 4,
        position: { x: 720, y: 120 },
        title: "Explore semantic zoom transitions",
        titleOrigin: "manual",
        cwd: root.cwd,
        worktreeName: "peel/semantic-zoom",
        lastViewedTurnId: null,
      },
    };
    space.camera = { scale, x, y };
    space.updatedAt = Date.now();
    state.viewMode = "overview";
    state.activeThreadId = root.threadId;
    await window.peel.saveState(state);
  }, { scale, x, y });

  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator(".overview-card")).toHaveCount(5, { timeout: 15_000 });
  await page.waitForTimeout(900);
}

test("capture the refined Focus and semantic Overview levels", async () => {
  test.setTimeout(120_000);

  await expect(page.locator(".welcome").getByRole("button", { name: "Search Chats", exact: true })).toBeEnabled({ timeout: 15_000 });
  await page.locator(".welcome").getByRole("button", { name: "Search Chats", exact: true }).click();
  await expect(page.locator(".thread-picker")).toBeVisible();
  await page.locator(".thread-results button").first().click();
  await expect(page.getByRole("heading", { name: rootTitle })).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(captureRoot, "01-focus.png") });

  await reloadIntoOverview(.9, 18, 315);
  await expect(page.locator(".overview-shell")).toHaveAttribute("data-zoom-mode", "detail");
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(captureRoot, "02-overview-detail.png") });

  await reloadIntoOverview(.62, 150, 385);
  await expect(page.locator(".overview-shell")).toHaveAttribute("data-zoom-mode", "compact");
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(captureRoot, "03-overview-compact.png") });

  await reloadIntoOverview(.31, 255, 435);
  await expect(page.locator(".overview-shell")).toHaveAttribute("data-zoom-mode", "map");
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(captureRoot, "04-overview-map.png") });
});
