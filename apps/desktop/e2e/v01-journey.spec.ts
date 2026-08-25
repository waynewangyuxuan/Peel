import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
let scratch = "";
let repository = "";
let userData = "";
let rpcLog = "";
let app: ElectronApplication | null = null;
let page: Page;

test.beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "peel-e2e-"));
  repository = join(scratch, "repository");
  userData = join(scratch, "user-data");
  rpcLog = join(repository, "peel-mock-rpc.jsonl");
  await chmod(codexMock, 0o755);
  await chmod(speechHelper, 0o755);
  await exec("git", ["init", repository]);
  await exec("git", ["config", "user.email", "peel@example.test"], { cwd: repository });
  await exec("git", ["config", "user.name", "Peel Test"], { cwd: repository });
  await writeFile(join(repository, "README.md"), "# Peel fixture\n");
  await exec("git", ["add", "README.md"], { cwd: repository });
  await exec("git", ["commit", "-m", "fixture"], { cwd: repository });
});

test.afterAll(async () => {
  await app?.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function launch(): Promise<void> {
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
}

async function startFreshSpace(): Promise<void> {
  await page.getByRole("button", { name: /New Space/ }).click();
  await expect(page.locator(".thread-picker")).toBeVisible();
  await page.locator(".thread-results button").first().click();
  await expect(page.getByRole("heading", { name: "Spatial product direction" })).toBeVisible();
}

test("real Thread-first Fork loop, recovery surfaces, scale, and restart", async () => {
  await launch();
  await expect(page.getByRole("button", { name: /Choose a Codex Chat/ })).toBeEnabled();
  await page.getByRole("button", { name: /Choose a Codex Chat/ }).click();
  await expect(page.getByText("Spatial product direction").last()).toBeVisible();
  await page.getByText("Spatial product direction").last().click();
  await expect(page.getByRole("heading", { name: "Spatial product direction" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Direction", exact: true })).toBeVisible();
  await expect(page.locator(".agent-message strong")).toHaveText("full-fidelity");
  await expect(page.getByText("Command · completed")).toBeVisible();
  await expect(page.getByText("File changes · 1")).toBeVisible();
  await expect(page.getByText("Subagent activity")).toBeVisible();
  await expect(page.getByText("A recoverable fixture error")).toBeVisible();
  await expect(page.getByText("Codex item: futureCapability")).toBeVisible();

  const forkLatency = await page.evaluate(async () => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".turn-actions button")];
    const start = performance.now();
    buttons.at(-1)?.click();
    while (!document.querySelector(".fork-surface")) await new Promise(requestAnimationFrame);
    return performance.now() - start;
  });
  expect(forkLatency).toBeLessThan(150);
  await page.locator(".fork-surface textarea").fill("Cancel this local-only direction");
  await page.keyboard.press("Escape");
  await expect(page.locator(".fork-surface")).toHaveCount(0);
  const beforeSend = await readFile(rpcLog, "utf8");
  expect(beforeSend).not.toContain('"method":"thread/fork"');

  const peelHandle = page.getByRole("button", { name: "Peel a branch from this turn" }).last();
  const handleBox = await peelHandle.boundingBox();
  if (!handleBox) throw new Error("Peel handle did not have a layout box");
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 82, handleBox.y + 24, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".fork-surface")).toBeVisible();
  await page.locator(".fork-surface textarea").fill("Try a compact navigation direction");
  await page.getByRole("button", { name: "Create & send" }).click();
  await expect(page.locator(".lineage-tree button")).toHaveCount(2);
  await page.locator(".thread-name").dblclick();
  await page.locator(".topbar-title input").fill("Manual branch name");
  await page.locator(".topbar-title input").press("Enter");
  await expect(page.getByText("A streamed result for this direction.")).toBeVisible();
  await expect(page.locator(".thread-name")).toHaveText("Manual branch name");
  await expect(page.getByText("Command approval")).toBeVisible();
  await page.getByRole("button", { name: "Decline" }).click();
  const afterSend = await readFile(rpcLog, "utf8");
  expect(afterSend).toContain('"method":"thread/fork"');
  expect(afterSend).toContain('"lastTurnId":"turn-2"');

  await page.getByLabel("Message").fill("Child-specific remembered draft");
  const attachmentPath = join(scratch, "pixel.png");
  await writeFile(attachmentPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await page.locator('.composer input[type="file"]').setInputFiles(attachmentPath);
  await expect(page.locator(".attachment")).toContainText("Image");
  await page.locator(".attachment button").click();
  await page.locator(".branched-from").click();
  await expect(page.locator(".turn.highlighted")).toHaveAttribute("data-turn-id", "turn-2");
  await page.locator(".lineage-tree button").nth(1).click();
  await expect(page.getByLabel("Message")).toHaveValue("Child-specific remembered draft");

  const draft = page.getByLabel("Message");
  await draft.fill("This draft must survive restart");
  const turnsBeforeVoice = (await readFile(rpcLog, "utf8")).match(/"method":"turn\/start"/g)?.length ?? 0;
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 220;
      oscillator.connect(destination);
      oscillator.start();
      return destination.stream;
    } });
  });
  await page.getByTitle("Dictate into draft").click();
  await expect(page.getByTitle("Stop dictation")).toBeVisible();
  await page.waitForTimeout(100);
  await page.getByTitle("Stop dictation").click();
  await expect(draft).toHaveValue("This draft must survive restart dictated editable words");
  const turnsAfterVoice = (await readFile(rpcLog, "utf8")).match(/"method":"turn\/start"/g)?.length ?? 0;
  expect(turnsAfterVoice).toBe(turnsBeforeVoice);
  await draft.fill("This draft must survive restart");
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => { throw new DOMException("Permission denied", "NotAllowedError"); } });
  });
  await page.getByTitle("Dictate into draft").click();
  await expect(page.getByText(/Permission denied/)).toBeVisible();
  await expect(draft).toHaveValue("This draft must survive restart");
  await page.getByRole("button", { name: /Overview/ }).click();
  await expect(page.getByText("1 subagent · Running").first()).toBeVisible();
  await page.getByRole("button", { name: /Focus/ }).click();

  const firstSpaceId = await page.evaluate(() => window.peel.bootstrap().then((payload) => payload.state.activeSpaceId!));

  await startFreshSpace();
  await page.locator(".turn-actions button").last().click();
  await page.locator(".fork-surface textarea").fill("Isolated worktree direction");
  await page.getByText("Create a new worktree").click();
  await page.getByRole("button", { name: "Create & send" }).click();
  await expect(page.locator(".lineage-tree button")).toHaveCount(2);
  await page.getByRole("button", { name: /Overview/ }).click();
  await expect(page.locator(".overview-card").getByText("peel/isolated-worktree-direction", { exact: true })).toBeVisible();

  await startFreshSpace();
  await page.evaluate(async (badCwd) => {
    const state = (await window.peel.bootstrap()).state;
    const space = state.spaces[state.activeSpaceId!];
    space.nodes[space.rootThreadId]!.cwd = badCwd;
    await window.peel.saveState(state);
    location.reload();
  }, scratch);
  await expect(page.getByRole("heading", { name: "Spatial product direction" })).toBeVisible();
  await page.locator(".turn-actions button").last().click();
  await page.locator(".fork-surface textarea").fill("Worktree failure keeps this prompt");
  await page.getByText("Create a new worktree").click();
  await page.getByRole("button", { name: "Create & send" }).click();
  await expect(page.locator(".fork-error")).toContainText("not-a-worktree");
  await expect(page.locator(".fork-surface textarea")).toHaveValue("Worktree failure keeps this prompt");
  await page.getByText("Create a new worktree").click();
  await page.getByRole("button", { name: "Create & send" }).click();
  await expect(page.locator(".lineage-tree button")).toHaveCount(2);

  await startFreshSpace();
  await writeFile(join(repository, "fail-fork"), "1");
  const worktreesBeforeForkFailure = (await readdir(join(userData, "Worktrees"))).length;
  await page.locator(".turn-actions button").last().click();
  await page.locator(".fork-surface textarea").fill("Fork failure keeps this prompt");
  await page.getByText("Create a new worktree").click();
  await page.getByRole("button", { name: "Create & send" }).click();
  await expect(page.locator(".fork-error")).toContainText("Forced Fork failure");
  await expect(page.locator(".fork-surface textarea")).toHaveValue("Fork failure keeps this prompt");
  await expect(page.getByText(/Prepared peel\/fork-failure-keeps-this-prompt/)).toBeVisible();
  await page.getByRole("button", { name: "Create & send" }).click();
  await expect(page.locator(".lineage-tree button")).toHaveCount(2);
  expect((await readdir(join(userData, "Worktrees"))).length).toBe(worktreesBeforeForkFailure + 1);

  await startFreshSpace();
  await writeFile(join(repository, "fail-turn"), "1");
  await page.locator(".turn-actions button").last().click();
  await page.locator(".fork-surface textarea").fill("First Turn failure keeps this prompt");
  await page.getByRole("button", { name: "Create & send" }).click();
  await expect(page.getByLabel("Message")).toHaveValue("First Turn failure keeps this prompt");
  await page.getByLabel("Message").press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await page.locator(".branched-from").click();
  await expect(page.locator(".lineage-tree button").nth(1).locator(".node-dot.new-result")).toBeVisible();

  await page.evaluate(async (targetSpaceId) => {
    const state = (await window.peel.bootstrap()).state;
    state.activeSpaceId = targetSpaceId;
    state.activeThreadId = "thread-child-1";
    state.viewMode = "overview";
    const space = state.spaces[targetSpaceId]!;
    const root = space.nodes[space.rootThreadId]!;
    for (let index = 0; index < 48; index += 1) {
      const id = `synthetic-${index}`;
      const parentThreadId = index < 8 ? "thread-child-1" : `synthetic-${Math.floor((index - 8) / 4)}`;
      space.nodes[id] = { ...root, threadId: id, parentThreadId, forkedAtTurnId: "turn-2", createdAt: Date.now() + index, position: { x: 600 + (index % 8) * 300, y: Math.floor(index / 8) * 200 - 500 }, title: `Scale direction ${index}`, titleOrigin: "automatic", lastViewedTurnId: null };
    }
    space.camera = { x: 70, y: 60, scale: .42 };
    await window.peel.saveState(state);
  }, firstSpaceId);

  await app!.close();
  app = null;
  await launch();
  await expect(page.locator(".overview-card")).toHaveCount(50);
  await expect(page.getByText("Scale direction 47")).toBeAttached();
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(desktopRoot, "test-results/overview-50.png") });
  await page.getByRole("button", { name: /Focus/ }).click();
  await expect(page.getByLabel("Message")).toHaveValue("This draft must survive restart");
  await page.screenshot({ path: join(desktopRoot, "test-results/focus-restored.png") });
  await page.getByRole("button", { name: /Diff/ }).click();
  await expect(page.getByText("Workspace changes")).toBeVisible();
});
