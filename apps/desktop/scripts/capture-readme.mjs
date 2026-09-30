import { _electron as electron } from "playwright";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const executable = join(desktopRoot, "out/Peel-darwin-arm64/Peel.app/Contents/MacOS/Peel");
const codexMock = join(desktopRoot, "e2e/fixtures/codex");
const scratch = await mkdtemp(join(tmpdir(), "peel-readme-captures-"));
const userData = join(scratch, "data");
const workspace = join(scratch, "workspace");
let application;

try {
  await Promise.all([mkdir(userData), mkdir(workspace), chmod(codexMock, 0o755)]);
  await writeFile(join(userData, "peel-state.json"), JSON.stringify(readmeState(workspace)));
  application = await electron.launch({
    executablePath: executable,
    env: {
      ...process.env,
      PEEL_USER_DATA_PATH: userData,
      PEEL_CODEX_BINARY: codexMock,
      TMPDIR: scratch,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
  const page = await application.firstWindow();
  await page.locator(".thread-name").waitFor({ state: "visible" });
  await page.locator(".branched-from").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Branch from here", exact: true }).last().waitFor({ state: "visible" });
  await page.locator(".transcript").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(repositoryRoot, "docs/assets/peel-focus.png") });

  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.locator(".overview-card").nth(5).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.waitForTimeout(350);
  await page.locator(".overview-card").filter({ hasText: "Navigation and return" }).hover();
  await page.screenshot({ path: join(repositoryRoot, "docs/assets/peel-overview.png") });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    focus: "docs/assets/peel-focus.png",
    overview: "docs/assets/peel-overview.png",
    fixture: "isolated six-Thread production Electron Space",
  })}\n`);
} finally {
  await application?.close();
  await rm(scratch, { recursive: true, force: true });
}

function readmeState(cwd) {
  const createdAt = Date.now() - 20_000;
  const root = node("thread-root", null, null, "Peel product direction", 70, 270, cwd, createdAt);
  const nodes = {
    [root.threadId]: root,
    "synthetic-focus": node("synthetic-focus", root.threadId, "turn-2", "Focus reading experience", 390, 115, cwd, createdAt + 1),
    "synthetic-rendering": node("synthetic-rendering", "synthetic-focus", "turn-2", "Rendering fidelity", 735, 40, cwd, createdAt + 2),
    "synthetic-navigation": node("synthetic-navigation", "synthetic-focus", "turn-2", "Navigation and return", 735, 300, cwd, createdAt + 3),
    "synthetic-performance": node("synthetic-performance", root.threadId, "turn-2", "Startup and performance", 390, 520, cwd, createdAt + 4),
    "synthetic-packaging": node("synthetic-packaging", "synthetic-performance", "turn-2", "Desktop packaging", 735, 545, cwd, createdAt + 5),
  };
  return {
    version: 1,
    activeSpaceId: "space-readme",
    activeThreadId: "synthetic-navigation",
    viewMode: "focus",
    spaces: {
      "space-readme": {
        id: "space-readme",
        name: "Build a spatial Codex workspace",
        nameOrigin: "manual",
        rootThreadId: root.threadId,
        archived: false,
        createdAt,
        updatedAt: createdAt + 6,
        nodes,
        camera: { x: 20, y: 20, scale: 1 },
      },
    },
    threadViews: {},
  };
}

function node(threadId, parentThreadId, forkedAtTurnId, title, x, y, cwd, createdAt) {
  return {
    threadId,
    parentThreadId,
    forkedAtTurnId,
    createdAt,
    position: { x, y },
    title,
    titleOrigin: "manual",
    cwd,
    worktreeName: null,
    lastViewedTurnId: null,
  };
}
