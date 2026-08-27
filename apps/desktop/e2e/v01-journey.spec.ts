import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { suggestedChildPosition } from "../src/shared/state";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const codexMock = join(here, "fixtures/codex");
const speechHelper = join(here, "fixtures/speech-helper");
const rootTitle = "Review Inkstone Legacy product migration and narrative architecture across multiple directions";
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
  await exec("git", ["init", "--initial-branch=main", repository]);
  await exec("git", ["config", "user.email", "peel@example.test"], { cwd: repository });
  await exec("git", ["config", "user.name", "Peel Test"], { cwd: repository });
  await writeFile(join(repository, "README.md"), "# Peel fixture\n");
  await writeFile(join(repository, "delay-thread-list-warm"), "1");
  await writeFile(join(repository, "delay-thread-list-search"), "1");
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
      PEEL_TEST_STATE_FAILURE_MARKER: join(repository, "fail-persist"),
      TMPDIR: repository,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.evaluate(() => {
    (window as unknown as { peelNativeAudioContext?: typeof AudioContext }).peelNativeAudioContext = AudioContext;
  });
}

async function readRpcEvents(): Promise<Array<{ method?: string; params?: Record<string, unknown> }>> {
  const content = await readFile(rpcLog, "utf8");
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

async function startFreshSpace(): Promise<void> {
  await page.locator(".space-sidebar").getByRole("button", { name: "Search Chats" }).click();
  await expect(page.locator(".thread-picker")).toBeVisible();
  await page.locator(".thread-results button").first().click();
  await expect(page.getByRole("heading", { name: rootTitle })).toBeVisible({ timeout: 15_000 });
}

async function installMediaCapture(): Promise<void> {
  await page.evaluate(async () => {
    const testWindow = window as unknown as {
      peelCaptureAudio?: AudioContext;
      peelCaptureTrack?: MediaStreamTrack;
      peelNativeAudioContext?: typeof AudioContext;
    };
    const NativeAudioContext = testWindow.peelNativeAudioContext;
    if (!NativeAudioContext) throw new Error("Native AudioContext was not preserved");
    await testWindow.peelCaptureAudio?.close();
    const context = new NativeAudioContext();
    const destination = context.createMediaStreamDestination();
    const oscillator = context.createOscillator();
    oscillator.connect(destination);
    oscillator.start();
    await context.resume();
    testWindow.peelCaptureAudio = context;
    testWindow.peelCaptureTrack = destination.stream.getAudioTracks()[0];
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: class extends NativeAudioContext {
        override createAnalyser(): AnalyserNode {
          const analyser = super.createAnalyser();
          Object.defineProperty(analyser, "getFloatTimeDomainData", {
            configurable: true,
            value: (samples: Float32Array<ArrayBuffer>) => {
              for (let index = 0; index < samples.length; index += 1) samples[index] = Math.sin(index * .35) * .42;
            },
          });
          return analyser;
        }
      },
    });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => destination.stream });
  });
}

test("real Thread-first Fork loop, recovery surfaces, scale, and restart", async () => {
  test.setTimeout(120_000);
  await launch();
  await expect(page.locator(".welcome").getByRole("button", { name: "New Chat", exact: true })).toBeEnabled();
  await expect(page.locator(".welcome").getByRole("button", { name: "Search Chats", exact: true })).toBeEnabled();
  await page.screenshot({ path: join(desktopRoot, "test-results/ui-welcome.png") });
  await expect.poll(async () => (await readFile(rpcLog, "utf8")).includes('"method":"thread/list"')).toBe(true);
  const threadListsBeforeNewChat = (await readFile(rpcLog, "utf8")).match(/"method":"thread\/list"/g)?.length ?? 0;
  const newChatStarted = performance.now();
  await page.locator(".welcome").getByRole("button", { name: "New Chat", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New Chat", exact: true })).toBeVisible();
  expect(performance.now() - newChatStarted).toBeLessThan(250);
  const newChatRpc = await readFile(rpcLog, "utf8");
  expect(newChatRpc).toContain('"method":"thread/start"');
  expect(newChatRpc).not.toContain('"method":"fixture/thread-list/responded"');
  expect(newChatRpc.match(/"method":"thread\/list"/g)?.length ?? 0).toBe(threadListsBeforeNewChat);
  await expect(page.locator('.sidebar-entry-actions button[aria-label="New Chat"]')).toHaveCount(1);
  await expect(page.locator('.sidebar-entry-actions button[aria-label="Search Chats"]')).toHaveCount(1);
  await expect(page.locator(".new-space-button")).toHaveCount(0);
  const newChatDraft = page.getByLabel("Message");
  await newChatDraft.fill("First line");
  await newChatDraft.press("Shift+Enter");
  await newChatDraft.type("Second line");
  await expect(newChatDraft).toHaveValue("First line\nSecond line");
  await newChatDraft.fill("");
  const emptyComposerHeight = await page.locator(".composer").evaluate((element) => element.getBoundingClientRect().height);
  expect(emptyComposerHeight).toBeLessThanOrEqual(82);
  await page.screenshot({ path: join(desktopRoot, "test-results/ui-new-chat-empty.png") });

  const spacesBeforeStartFailure = await page.evaluate(() => window.peel.bootstrap().then((payload) => Object.keys(payload.state.spaces).length));
  await writeFile(join(repository, "fail-thread-start"), "1");
  await page.locator('.sidebar-entry-actions button[aria-label="New Chat"]').click();
  await expect(page.locator(".toast")).toContainText("New Chat could not be created");
  await expect(page.locator('.sidebar-entry-actions button[aria-label="New Chat"]')).toBeEnabled();
  expect(await page.evaluate(() => window.peel.bootstrap().then((payload) => Object.keys(payload.state.spaces).length))).toBe(spacesBeforeStartFailure);

  await expect.poll(async () => (await readFile(rpcLog, "utf8")).includes('"method":"fixture/thread-list/responded"')).toBe(true);
  const threadListsBeforeWarmOpen = (await readFile(rpcLog, "utf8")).match(/"method":"thread\/list"/g)?.length ?? 0;
  const warmOpenMs = await page.evaluate(async () => {
    const choose = document.querySelector<HTMLButtonElement>('.space-sidebar button[aria-label="Search Chats"]');
    if (!choose) throw new Error("Search Chats button was missing");
    const started = performance.now();
    choose.click();
    while (!document.querySelector(".thread-result")) await new Promise(requestAnimationFrame);
    return performance.now() - started;
  });
  expect(warmOpenMs).toBeLessThan(100);
  await expect(page.locator(".thread-result")).toHaveCount(30);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(desktopRoot, "test-results/ui-thread-picker.png") });
  await page.waitForTimeout(150);
  const threadListsAfterWarmOpen = (await readFile(rpcLog, "utf8")).match(/"method":"thread\/list"/g)?.length ?? 0;
  expect(threadListsAfterWarmOpen).toBe(threadListsBeforeWarmOpen + 1);

  const provisionalStarted = performance.now();
  await page.getByLabel("Search Codex Chats").fill("Catalog direction 05");
  await expect(page.locator(".thread-result")).toHaveCount(1);
  await expect(page.locator(".thread-result strong")).toHaveText("Catalog direction 05");
  const provisionalSearchMs = performance.now() - provisionalStarted;
  expect(provisionalSearchMs).toBeLessThan(100);
  await expect(page.getByText("Searching all Codex Chats…")).toBeVisible();
  await expect.poll(async () => (await readFile(rpcLog, "utf8")).includes('"search":"catalog direction 05"')).toBe(true);
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => ({
    input: document.querySelector<HTMLInputElement>('[aria-label="Search Codex Chats"]')?.value,
    results: [...document.querySelectorAll(".thread-result strong")].map((element) => element.textContent),
    feedback: [...document.querySelectorAll(".picker-results-state, .picker-pagination")].map((element) => element.textContent),
  }))).toEqual({
    input: "Catalog direction 05",
    results: ["Catalog direction 05"],
    feedback: ["1 Chat loadedEnd of results"],
  });
  const listsAfterAuthoritativeSearch = (await readFile(rpcLog, "utf8")).match(/"method":"thread\/list"/g)?.length ?? 0;

  await page.getByLabel("Search Codex Chats").fill("");
  await expect(page.locator(".thread-result")).toHaveCount(30);
  const repeatedStarted = performance.now();
  await page.getByLabel("Search Codex Chats").fill("Catalog direction 05");
  await expect(page.locator(".thread-result")).toHaveCount(1);
  const repeatedSearchMs = performance.now() - repeatedStarted;
  expect(repeatedSearchMs).toBeLessThan(100);
  await page.waitForTimeout(250);
  const listsAfterRepeatedSearch = (await readFile(rpcLog, "utf8")).match(/"method":"thread\/list"/g)?.length ?? 0;
  expect(listsAfterRepeatedSearch).toBe(listsAfterAuthoritativeSearch);

  await page.getByLabel("Search Codex Chats").fill("Catalog direction 06");
  await expect.poll(async () => (await readRpcEvents()).some((event) =>
    event.method === "thread/list" && event.params?.searchTerm === "Catalog direction 06"
  ), { intervals: [10, 20, 50], timeout: 2_000 }).toBe(true);
  await page.getByLabel("Search Codex Chats").fill("Catalog direction 07");
  await expect.poll(async () => (await readRpcEvents()).some((event) =>
    event.method === "thread/list" && event.params?.searchTerm === "Catalog direction 07"
  ), { intervals: [10, 20, 50], timeout: 2_000 }).toBe(true);
  await expect.poll(async () => {
    const responses = (await readRpcEvents())
      .filter((event) => event.method === "fixture/thread-list/responded")
      .map((event) => event.params?.search);
    return {
      olderFinished: responses.includes("catalog direction 06"),
      currentFinished: responses.includes("catalog direction 07"),
    };
  }, { intervals: [10, 20, 50], timeout: 2_000 }).toEqual({ olderFinished: true, currentFinished: false });
  expect(await page.locator(".thread-result strong").allTextContents()).toEqual(["Catalog direction 07"]);
  await expect(page.getByText("Searching all Codex Chats…")).toBeVisible();
  await expect.poll(async () => (await readRpcEvents()).some((event) =>
    event.method === "fixture/thread-list/responded" && event.params?.search === "catalog direction 07"
  )).toBe(true);
  await expect(page.locator(".thread-result strong")).toHaveText("Catalog direction 07");
  await expect(page.getByText("End of results")).toBeVisible();

  await page.getByLabel("Search Codex Chats").fill("Catalog direction 08");
  await expect.poll(async () => (await readRpcEvents()).some((event) =>
    event.method === "thread/list" && event.params?.searchTerm === "Catalog direction 08"
  ), { intervals: [10, 20, 50], timeout: 2_000 }).toBe(true);
  await page.locator(".picker-header .icon-button").click();
  await expect(page.locator(".thread-picker")).toHaveCount(0);
  await page.locator(".space-sidebar").getByRole("button", { name: "Search Chats" }).click();
  await expect(page.locator(".thread-result")).toHaveCount(30);
  await expect.poll(async () => (await readRpcEvents()).some((event) =>
    event.method === "fixture/thread-list/responded" && event.params?.search === "catalog direction 08"
  )).toBe(true);
  await expect(page.getByLabel("Search Codex Chats")).toHaveValue("");
  await expect(page.locator(".thread-result")).toHaveCount(30);
  await rm(join(repository, "delay-thread-list-search"));

  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.locator(".thread-result")).toHaveCount(60);
  await page.getByText("Catalog direction 54", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Catalog direction 54" })).toBeVisible();
  await page.locator(".space-sidebar").getByRole("button", { name: "Search Chats" }).click();
  await expect(page.locator(".thread-picker")).toBeVisible();
  await page.locator(".thread-result").first().click();
  await expect(page.getByRole("heading", { name: rootTitle })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Direction", exact: true })).toBeVisible();
  await expect(page.locator(".agent-message strong").first()).toHaveText("full-fidelity");
  await expect(page.locator(".agent-message table")).toBeVisible();
  await expect(page.locator(".agent-message blockquote")).toHaveCount(3);
  await expect(page.locator(".agent-message blockquote").first()).toContainText("Keep the Chat readable");
  await expect(page.locator(".agent-message blockquote").nth(1)).toContainText("我们的护城河不是 AI 会写");
  await expect(page.locator(".agent-message del")).toHaveText("Raw pipe text");
  const userBubbleProportion = await page.locator(".user-message").first().evaluate((bubble) => {
    const transcript = bubble.closest(".transcript")!;
    return bubble.getBoundingClientRect().width / transcript.getBoundingClientRect().width;
  });
  expect(userBubbleProportion).toBeLessThan(.5);
  expect(await page.evaluate(() => Boolean((window as unknown as { __peelUnsafe?: boolean }).__peelUnsafe))).toBe(false);
  expect(await page.locator(".agent-message").first().evaluate((element) => element.innerText.split("\n").filter((line) => line.trimStart().startsWith(">")))).toEqual([]);
  const quoteCraft = await page.locator(".agent-message blockquote").first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderLeftWidth: style.borderLeftWidth, backgroundColor: style.backgroundColor, paddingLeft: style.paddingLeft };
  });
  expect(quoteCraft).toMatchObject({ borderLeftWidth: "2px", paddingLeft: "15px", backgroundColor: "rgba(0, 0, 0, 0)" });
  await page.locator(".agent-message table").scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(desktopRoot, "test-results/ui-focus-markdown.png") });
  const code = page.locator(".markdown-code").first();
  await expect(code.locator(".markdown-code-header > span")).toHaveText("ts");
  await expect(code.locator(".syntax-keyword")).toContainText("const");
  await expect(code.locator(".syntax-string")).toContainText("a-very-long-code-line");
  const clipboardBeforeCopy = await app!.evaluate(({ clipboard }) => clipboard.readText());
  await code.getByRole("button", { name: "Copy code" }).click();
  await expect(code.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await app!.evaluate(({ clipboard }) => clipboard.readText())).toContain("const spatialSurface");
  await app!.evaluate(({ clipboard }, value) => clipboard.writeText(value), clipboardBeforeCopy);
  await page.screenshot({ path: join(desktopRoot, "test-results/ui-focus-markdown-code.png") });
  const reasoning = page.locator(".activity-item").filter({ hasText: "Reasoning" });
  await reasoning.locator("summary").click();
  await expect(reasoning.locator("strong")).toHaveText("Planning collaborative reasoning framework");
  await expect(reasoning.locator("blockquote")).toContainText("understand the result");
  const commandActivity = page.locator(".activity-item.technical").filter({ hasText: "Ran a command" });
  await expect(commandActivity).toBeVisible();
  await commandActivity.locator("summary").click();
  await expect(commandActivity.locator("header").first()).toContainText("Command");
  await expect(commandActivity.locator("pre").first()).toContainText("npm test");
  await expect(commandActivity.locator("header").nth(1)).toContainText("Output");
  await expect(commandActivity.locator("pre").nth(1)).toContainText("All checks passed");
  const failedCommand = page.locator(".activity-item.technical.failed").filter({ hasText: "Command needs attention" });
  await expect(failedCommand).toBeVisible();
  await failedCommand.locator("summary").click();
  await expect(failedCommand.locator("header").nth(1)).toContainText("Error output");
  await expect(failedCommand.locator("pre").nth(1)).toContainText("One presentation check needs attention");
  const fileActivity = page.locator(".activity-item.technical").filter({ hasText: "Updated src/focus.tsx" });
  await expect(fileActivity).toBeVisible();
  await fileActivity.locator("summary").click();
  await expect(fileActivity.locator(".syntax-addition")).toContainText("renderFocus");
  await page.screenshot({ path: join(desktopRoot, "test-results/ui-focus-activity.png") });
  await expect(page.getByText("Worked with a subagent")).toBeVisible();
  const issue = page.locator(".activity-item.failed").filter({ hasText: "Something needs attention" });
  await expect(issue).toBeVisible();
  await issue.locator("summary").click();
  await expect(issue).toContainText("A recoverable fixture error");
  await expect(page.getByText("Additional Codex activity")).toBeVisible();
  await expect(page.locator(".thread-name")).toHaveAttribute("title", rootTitle);
  await expect(page.locator(".thread-name")).toHaveAttribute("aria-label", `Current Thread: ${rootTitle}. Double-click to rename.`);
  const assertContainedNavigation = async (): Promise<void> => {
    const layout = await page.locator(".space-sidebar nav").evaluate((nav) => {
      const selected = nav.querySelector<HTMLElement>("button.selected")!;
      const navBounds = nav.getBoundingClientRect();
      const buttonBounds = selected.getBoundingClientRect();
      return {
        clientWidth: nav.clientWidth,
        scrollWidth: nav.scrollWidth,
        selectedFits: buttonBounds.left >= navBounds.left - 1 && buttonBounds.right <= navBounds.right + 1,
        title: selected.title,
      };
    });
    expect(layout.scrollWidth).toBe(layout.clientWidth);
    expect(layout.selectedFits).toBe(true);
    expect(layout.title).toBe(rootTitle);
  };
  await assertContainedNavigation();
  await page.locator(".thread-name").hover();
  await page.screenshot({ path: join(desktopRoot, "test-results/ui-focus.png") });
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 720));
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1000);
  await assertContainedNavigation();
  await page.screenshot({ path: join(desktopRoot, "test-results/ui-focus-markdown-narrow.png") });
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 960));
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440);
  const codeLayout = await page.locator(".code-block").evaluate((element) => ({
    whiteSpace: getComputedStyle(element).whiteSpace,
    overflowX: getComputedStyle(element).overflowX,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(codeLayout).toMatchObject({ whiteSpace: "pre", overflowX: "auto" });
  expect(codeLayout.scrollWidth).toBeGreaterThan(codeLayout.clientWidth);
  const selectable = await page.locator(".agent-message p").first().evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const text = selection?.toString() ?? "";
    selection?.removeAllRanges();
    return text;
  });
  expect(selectable).toContain("full-fidelity");

  const forkLatency = await page.evaluate(async () => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".turn-actions button")];
    const start = performance.now();
    buttons.at(-1)?.click();
    while (!document.querySelector(".fork-surface")) await new Promise(requestAnimationFrame);
    return performance.now() - start;
  });
  expect(forkLatency).toBeLessThan(150);
  await page.locator(".fork-surface textarea").fill("Cancel this local-only direction");
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(desktopRoot, "test-results/ui-fork-draft.png") });
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 720));
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1000);
  await page.waitForTimeout(300);
  const narrowForkLayout = await page.evaluate(() => {
    const primary = document.querySelector<HTMLElement>(".fork-footer .primary-button")!.getBoundingClientRect();
    const fork = document.querySelector<HTMLElement>(".fork-surface")!.getBoundingClientRect();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      fork: { left: fork.left, right: fork.right, top: fork.top, bottom: fork.bottom },
      primary: { left: primary.left, right: primary.right, top: primary.top, bottom: primary.bottom },
      pageFits: document.documentElement.scrollWidth === window.innerWidth,
      forkFits: fork.left >= -1 && fork.right <= window.innerWidth + 1,
      primaryFits: primary.left >= -1 && primary.right <= window.innerWidth + 1 && primary.bottom <= window.innerHeight + 1,
    };
  });
  if (!narrowForkLayout.pageFits || !narrowForkLayout.forkFits || !narrowForkLayout.primaryFits) {
    throw new Error(`Narrow Fork layout is clipped: ${JSON.stringify(narrowForkLayout)}`);
  }
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 960));
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440);
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
  const streamingAgent = page.locator(".turn").last().locator(".agent-message");
  await expect(streamingAgent.locator("strong")).toContainText("A streamed result");
  expect(await streamingAgent.innerText()).not.toContain("**");
  await page.locator(".transcript").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(125);
  const followedBottom = await page.locator(".transcript").evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
  expect(followedBottom).toBeLessThan(58);
  await page.locator(".transcript").evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(190);
  expect(await page.locator(".transcript").evaluate((element) => element.scrollTop)).toBeLessThan(4);
  await expect(page.getByText("Command approval")).toBeVisible();
  await page.locator(".thread-name").dblclick();
  await page.locator(".topbar-title input").fill("Manual branch name");
  await page.locator(".topbar-title input").press("Enter");
  await expect(page.getByText("A streamed result for this direction.")).toBeVisible();
  await expect(page.locator(".thread-name")).toHaveText("Manual branch name");
  await page.waitForTimeout(650);
  await expect(page.locator(".thread-name")).toHaveText("Manual branch name");
  expect(await page.evaluate(() => window.peel.bootstrap().then((payload) => payload.state.spaces[payload.state.activeSpaceId!]!.nodes[payload.state.activeThreadId!]!.titleOrigin))).toBe("manual");
  await page.getByRole("button", { name: "Decline" }).click();
  const afterSend = await readFile(rpcLog, "utf8");
  expect(afterSend).toContain('"method":"thread/fork"');
  expect(afterSend).toContain('"lastTurnId":"turn-2"');

  await page.getByLabel("Message").fill("Child-specific remembered draft");
  const attachmentPath = join(scratch, "pixel.png");
  await writeFile(attachmentPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await page.locator('.composer input[type="file"]').setInputFiles(attachmentPath);
  await expect(page.locator(".attachment")).toContainText("Image");
  await page.evaluate(() => {
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    const track = destination.stream.getAudioTracks()[0]!;
    const stop = track.stop.bind(track);
    const testWindow = window as unknown as { resolvePeelPermission?: () => void; stoppedPeelTracks?: number };
    testWindow.stoppedPeelTracks = 0;
    track.stop = () => { testWindow.stoppedPeelTracks = (testWindow.stoppedPeelTracks ?? 0) + 1; stop(); };
    const permission = new Promise<MediaStream>((resolve) => { testWindow.resolvePeelPermission = () => resolve(destination.stream); });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => await permission });
  });
  await page.getByTitle("Dictate into draft").click();
  await page.locator(".branched-from").click();
  await expect(page.locator(".turn.highlighted")).toHaveAttribute("data-turn-id", "turn-2");
  await expect(page.locator(".attachment")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { resolvePeelPermission?: () => void }).resolvePeelPermission?.());
  await expect.poll(() => page.evaluate(() => (window as unknown as { stoppedPeelTracks?: number }).stoppedPeelTracks ?? 0)).toBe(1);
  await expect(page.getByTitle("Dictate into draft")).toBeVisible();
  await page.locator(".lineage-tree button").nth(1).click();
  await expect(page.getByLabel("Message")).toHaveValue("Child-specific remembered draft");
  await expect(page.locator(".attachment")).toHaveCount(0);

  await page.locator(".thread-name").dblclick();
  await page.locator(".topbar-title input").fill("Must not rename the parent");
  await page.locator(".branched-from").click();
  await expect(page.locator(".thread-name")).toHaveText(rootTitle);
  await page.locator(".lineage-tree button").nth(1).click();
  await page.locator(".lineage-tree button").nth(1).dblclick();
  await page.locator(".lineage-rename input").fill("Lineage branch name");
  await page.locator(".lineage-rename input").press("Enter");
  await expect(page.locator(".thread-name")).toHaveText("Lineage branch name");
  const positionsBeforeFirstOverview = await page.evaluate(() => window.peel.bootstrap().then((payload) => Object.fromEntries(Object.entries(payload.state.spaces[payload.state.activeSpaceId!]!.nodes).map(([id, node]) => [id, node.position]))));
  await page.locator(".segmented button").nth(1).click();
  await expect(page.locator(".overview-card")).toHaveCount(2);
  await expect(page.locator(".overview-edges path")).toHaveCount(1);
  await expect(page.locator(".overview-edges path.active")).toHaveCount(1);
  const branchCard = page.locator(".overview-card").filter({ hasText: "Lineage branch name" });
  await branchCard.locator("h3").dblclick();
  await page.getByLabel("Rename Lineage branch name").fill("Overview branch name");
  await page.getByLabel("Rename Lineage branch name").press("Enter");
  const renamedBranchCard = page.locator(".overview-card").filter({ hasText: "Overview branch name" });
  await expect(renamedBranchCard).toBeVisible();
  await expect(renamedBranchCard.locator("h3")).toHaveAttribute("title", "Overview branch name");
  await expect(renamedBranchCard.getByText("Latest user", { exact: true })).toBeVisible();
  await expect(renamedBranchCard.getByText("Latest result", { exact: true })).toBeVisible();
  expect(await renamedBranchCard.innerText()).not.toContain("**");
  await page.waitForTimeout(500);
  const initialOverviewLayout = await page.locator(".overview-viewport").evaluate((viewport) => {
    const frame = viewport.getBoundingClientRect();
    const cards = [...document.querySelectorAll<HTMLElement>(".overview-card")].map((card) => card.getBoundingClientRect());
    const toolbar = document.querySelector<HTMLElement>(".overview-toolbar")!;
    const shell = document.querySelector<HTMLElement>(".overview-shell")!.getBoundingClientRect();
    return {
      cardsFit: cards.every((card) => card.left >= frame.left && card.top >= frame.top && card.right <= frame.right && card.bottom <= frame.bottom),
      cardsReadable: cards.every((card) => card.width >= 293 && card.height >= 204),
      centeredWithin: Math.abs((Math.min(...cards.map((card) => card.left)) + Math.max(...cards.map((card) => card.right))) / 2 - (frame.left + frame.right) / 2),
      toolbarPosition: getComputedStyle(toolbar).position,
      canvasStartsAtShellTop: Math.abs(frame.top - shell.top) < 1,
    };
  });
  expect(initialOverviewLayout).toMatchObject({ cardsFit: true, cardsReadable: true, toolbarPosition: "absolute", canvasStartsAtShellTop: true });
  expect(initialOverviewLayout.centeredWithin).toBeLessThan(2);
  expect(await page.evaluate(() => window.peel.bootstrap().then((payload) => Object.fromEntries(Object.entries(payload.state.spaces[payload.state.activeSpaceId!]!.nodes).map(([id, node]) => [id, node.position]))))).toEqual(positionsBeforeFirstOverview);
  await expect(page.locator(".toast")).toHaveCount(0, { timeout: 5_000 });
  await page.screenshot({ path: join(desktopRoot, "test-results/ui-overview-2.png") });
  await renamedBranchCard.locator(".card-facts button").nth(1).click();
  await expect(page.locator('.turn.highlighted[data-turn-id="turn-3"]')).toBeVisible();

  const draft = page.getByLabel("Message");
  await draft.fill("This draft must survive restart");
  const turnsBeforeVoice = (await readFile(rpcLog, "utf8")).match(/"method":"turn\/start"/g)?.length ?? 0;
  await installMediaCapture();
  await page.getByTitle("Dictate into draft").click();
  await expect(page.getByTitle("Stop dictation")).toBeVisible();
  await page.locator(".lineage-tree button").first().click();
  await expect(page.getByTitle("Dictate into draft")).toBeVisible();
  await expect(page.getByTitle("Stop dictation")).toHaveCount(0);
  await expect(page.locator(".voice-live")).toHaveCount(0);
  await page.getByLabel("Message").fill("The switched Composer is immediately retryable");
  await expect(page.getByTitle("Send message")).toBeEnabled();
  await page.locator(".lineage-tree button").nth(1).click();
  await expect(page.getByLabel("Message")).toHaveValue("This draft must survive restart");
  expect((await readFile(rpcLog, "utf8")).match(/"method":"turn\/start"/g)?.length ?? 0).toBe(turnsBeforeVoice);
  await installMediaCapture();
  await page.getByTitle("Dictate into draft").click();
  await expect(page.getByTitle("Stop dictation")).toBeVisible();
  await expect(page.locator(".voice-waveform i")).toHaveCount(17);
  await expect.poll(async () => await page.locator(".voice-waveform i").evaluateAll((bars) => Math.max(...bars.map((bar) => {
    const match = (bar as HTMLElement).style.transform.match(/scaleY\(([^)]+)\)/);
    return Number(match?.[1] ?? 0);
  })))).toBeGreaterThan(.5);
  await expect(page.locator(".voice-live")).toContainText("0:");
  await page.screenshot({ path: join(desktopRoot, "test-results/ui-voice-recording.png") });
  await page.evaluate(() => (window as unknown as { peelCaptureTrack?: MediaStreamTrack }).peelCaptureTrack?.dispatchEvent(new Event("ended")));
  await expect(page.getByText(/Microphone capture stopped/)).toBeVisible();
  await expect(draft).toHaveValue("This draft must survive restart");

  await installMediaCapture();
  await page.getByTitle("Dictate into draft").click();
  await expect(page.getByTitle("Stop dictation")).toBeVisible();
  await page.waitForTimeout(100);
  await writeFile(join(repository, "delay-speech"), "1");
  await page.getByTitle("Stop dictation").click();
  await expect(page.getByText("Transcribing…")).toBeVisible();
  await page.screenshot({ path: join(desktopRoot, "test-results/ui-voice-transcribing.png") });
  await draft.fill("This draft must survive restart plus words typed while transcribing");
  await expect(draft).toHaveValue("This draft must survive restart plus words typed while transcribing dictated editable words");
  const turnsAfterVoice = (await readFile(rpcLog, "utf8")).match(/"method":"turn\/start"/g)?.length ?? 0;
  expect(turnsAfterVoice).toBe(turnsBeforeVoice);
  await draft.fill("This draft must survive restart");
  await installMediaCapture();
  await writeFile(join(repository, "no-speech"), "1");
  await page.getByTitle("Dictate into draft").click();
  await expect(page.getByTitle("Stop dictation")).toBeVisible();
  await page.getByTitle("Stop dictation").click();
  await expect(page.getByText("I didn’t catch any speech. Try again and speak for a little longer.")).toBeVisible();
  await expect(page.locator(".composer-notice")).toHaveCount(1);
  await expect(page.locator(".composer-error")).toHaveCount(0);
  await expect(page.getByText(/Error invoking remote method|peel:voice:transcribe|No speech detected/)).toHaveCount(0);
  await expect(draft).toHaveValue("This draft must survive restart");
  expect((await readFile(rpcLog, "utf8")).match(/"method":"turn\/start"/g)?.length ?? 0).toBe(turnsBeforeVoice);
  await installMediaCapture();
  await page.getByTitle("Dictate into draft").click();
  await expect(page.locator(".composer-notice")).toHaveCount(0);
  await page.getByTitle("Stop dictation").click();
  await expect(draft).toHaveValue("This draft must survive restart dictated editable words");
  await draft.fill("This draft must survive restart");
  await installMediaCapture();
  await writeFile(join(repository, "fail-speech"), "1");
  await page.getByTitle("Dictate into draft").click();
  await expect(page.getByTitle("Stop dictation")).toBeVisible();
  await page.getByTitle("Stop dictation").click();
  await expect(page.getByText(/Forced transcription failure/)).toBeVisible();
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(desktopRoot, "test-results/ui-voice-error.png") });
  await expect(draft).toHaveValue("This draft must survive restart");
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => { throw new DOMException("Permission denied", "NotAllowedError"); } });
  });
  await page.getByTitle("Dictate into draft").click();
  await expect(page.getByText(/Permission denied/)).toBeVisible();
  await expect(draft).toHaveValue("This draft must survive restart");
  await page.locator(".segmented button").nth(1).click();
  await expect(page.getByText("1 subagent · Running").first()).toBeVisible();
  await page.locator(".segmented button").nth(0).click();

  const firstSpaceId = await page.evaluate(() => window.peel.bootstrap().then((payload) => payload.state.activeSpaceId!));

  await startFreshSpace();
  await page.locator(".turn-actions button").last().click();
  await page.locator(".fork-surface textarea").fill("Isolated worktree direction");
  await page.getByText("Create a new worktree").click();
  await page.getByRole("button", { name: "Create & send" }).click();
  await expect(page.locator(".lineage-tree button")).toHaveCount(2);
  await expect(page.locator(".thread-runtime")).toContainText("peel/isolated-worktree-direction");
  await expect(page.locator(".thread-runtime")).toContainText("changed file");
  await page.locator(".turn-actions button").last().click();
  await expect(page.locator(".current-workspace-note")).toContainText("Continue in this worktree");
  await page.keyboard.press("Escape");
  await page.locator(".segmented button").nth(1).click();
  await expect(page.locator(".overview-card").getByRole("button", { name: "Open changes for peel/isolated-worktree-direction" })).toBeVisible();

  await writeFile(join(repository, "root-non-git-once"), "1");
  await startFreshSpace();
  await expect(page.getByRole("heading", { name: rootTitle })).toBeVisible();
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
  await page.getByLabel("Message").press("Enter");
  await expect(page.getByText("Command approval")).toBeVisible();
  await page.getByRole("button", { name: "Decline" }).click();
  const recoveredChildId = await page.evaluate(() => window.peel.bootstrap().then((payload) => payload.state.activeThreadId!));
  await page.locator(".branched-from").click();
  await page.evaluate(async (childThreadId) => {
    const state = (await window.peel.bootstrap()).state;
    const space = state.spaces[state.activeSpaceId!]!;
    space.nodes[childThreadId]!.lastViewedTurnId = null;
    state.viewMode = "overview";
    await window.peel.saveState(state);
    location.reload();
  }, recoveredChildId);
  await expect(page.locator(".overview-card").filter({ hasText: "First Turn failure keeps th…" }).locator(".status-dot.result")).toBeVisible();

  await startFreshSpace();
  await writeFile(join(repository, "delay-fork"), "1");
  await page.locator(".turn-actions button").last().click();
  await page.locator(".fork-surface textarea").fill("Busy Fork cannot be dismissed");
  await page.getByRole("button", { name: "Create & send" }).click();
  await expect(page.getByRole("button", { name: "Cancel fork" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.locator(".fork-surface textarea")).toHaveValue("Busy Fork cannot be dismissed");
  await expect(page.locator(".lineage-tree button")).toHaveCount(2);

  await startFreshSpace();
  await page.waitForTimeout(700);
  const forksBeforePersistFailure = (await readFile(rpcLog, "utf8")).match(/"method":"thread\/fork"/g)?.length ?? 0;
  await page.locator(".turn-actions button").last().click();
  await page.locator(".fork-surface textarea").fill("Persist failure reuses exact remote Fork");
  await writeFile(join(repository, "fail-persist"), "1");
  await page.getByRole("button", { name: "Create & send" }).click();
  await expect(page.locator(".fork-error")).toContainText("Forced state persistence failure");
  await expect(page.locator(".fork-surface textarea")).toHaveValue("Persist failure reuses exact remote Fork");
  await page.getByRole("button", { name: "Create & send" }).click();
  await expect(page.locator(".lineage-tree button")).toHaveCount(2);
  const forksAfterPersistRecovery = (await readFile(rpcLog, "utf8")).match(/"method":"thread\/fork"/g)?.length ?? 0;
  expect(forksAfterPersistRecovery - forksBeforePersistFailure).toBe(1);

  await startFreshSpace();
  const turnsBeforeFinalizeFailure = (await readFile(rpcLog, "utf8")).match(/"method":"turn\/start"/g)?.length ?? 0;
  await writeFile(join(repository, "arm-finalize-persist"), "1");
  await page.locator(".turn-actions button").last().click();
  await page.locator(".fork-surface textarea").fill("One remote Turn despite final save failure");
  await page.getByRole("button", { name: "Create & send" }).click();
  await expect(page.locator(".lineage-tree button")).toHaveCount(2);
  await expect(page.getByLabel("Message")).toHaveValue("");
  const turnsAfterFinalizeFailure = (await readFile(rpcLog, "utf8")).match(/"method":"turn\/start"/g)?.length ?? 0;
  expect(turnsAfterFinalizeFailure - turnsBeforeFinalizeFailure).toBe(1);

  await page.evaluate(async (targetSpaceId) => {
    const state = (await window.peel.bootstrap()).state;
    state.activeSpaceId = targetSpaceId;
    state.activeThreadId = "thread-child-1";
    state.viewMode = "focus";
    await window.peel.saveState(state);
    location.reload();
  }, firstSpaceId);
  await expect(page.locator(".thread-name")).toHaveText("Overview branch name");
  await page.locator(".transcript").evaluate((element) => {
    element.scrollTop = Math.min(180, element.scrollHeight - element.clientHeight);
    element.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(700);
  const childScroll = await page.locator(".transcript").evaluate((element) => element.scrollTop);
  await writeFile(join(repository, "delay-read-thread-root"), "1");
  await page.locator(".branched-from").click();
  await page.locator(".lineage-tree button").nth(1).click();
  await page.waitForTimeout(420);
  await expect(page.locator(".thread-name")).toHaveText("Overview branch name");
  expect(await page.locator(".transcript").evaluate((element) => element.scrollTop)).toBeGreaterThanOrEqual(Math.max(0, childScroll - 3));

  await page.locator(".transcript").evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(700);
  await page.locator('.turn[data-turn-id="turn-3"] .turn-actions button').click();
  await page.locator(".fork-surface textarea").fill("Grandchild verifies exact long-turn return");
  await page.getByRole("button", { name: "Create & send" }).click();
  await expect(page.locator(".lineage-tree button")).toHaveCount(3);
  await page.locator(".branched-from").click();
  const exactLongParentTurn = page.locator('.turn.highlighted[data-turn-id="turn-3"]');
  await expect(exactLongParentTurn).toBeVisible();
  await page.waitForTimeout(500);
  const longParentTurn = page.locator('.turn[data-turn-id="turn-3"]');
  const exactReturn = await longParentTurn.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const viewport = element.closest(".transcript")!.getBoundingClientRect();
    return {
      highlighted: element.classList.contains("highlighted"),
      visible: bounds.bottom > viewport.top && bounds.top < viewport.bottom,
      turnTop: bounds.top,
      turnBottom: bounds.bottom,
      viewportTop: viewport.top,
      viewportBottom: viewport.bottom,
    };
  });
  expect(exactReturn).toMatchObject({ highlighted: true, visible: true });

  await page.getByLabel("Message").fill("Close-fast draft survives without waiting for debounce");
  await app!.close();
  app = null;
  await launch();
  await expect(page.getByLabel("Message")).toHaveValue("Close-fast draft survives without waiting for debounce");

  const demoState = await page.evaluate(() => window.peel.bootstrap().then((payload) => payload.state));
  demoState.activeSpaceId = firstSpaceId;
  demoState.activeThreadId = "thread-child-1";
  demoState.viewMode = "overview";
  const demoSpace = demoState.spaces[firstSpaceId]!;
  const root = demoSpace.nodes[demoSpace.rootThreadId]!;
  const child = demoSpace.nodes["thread-child-1"]!;
  const grandchild = Object.values(demoSpace.nodes).find((node) => node.threadId !== root.threadId && node.threadId !== child.threadId)!;
  demoSpace.nodes = {
    [root.threadId]: { ...root, position: { x: 70, y: 270 } },
    [child.threadId]: { ...child, position: { x: 390, y: 115 } },
    [grandchild.threadId]: { ...grandchild, position: { x: 735, y: 40 }, title: "UI visual system", titleOrigin: "automatic", lastViewedTurnId: null },
    "synthetic-demo-navigation": { ...root, threadId: "synthetic-demo-navigation", parentThreadId: child.threadId, forkedAtTurnId: "turn-3", createdAt: Date.now() + 2, position: { x: 735, y: 286 }, title: "Navigation and command palette", titleOrigin: "automatic", lastViewedTurnId: null },
    "synthetic-demo-backend": { ...root, threadId: "synthetic-demo-backend", parentThreadId: root.threadId, forkedAtTurnId: "turn-2", createdAt: Date.now() + 3, position: { x: 390, y: 505 }, title: "Codex backend integration", titleOrigin: "automatic", lastViewedTurnId: null },
    "synthetic-demo-worktree": { ...root, threadId: "synthetic-demo-worktree", parentThreadId: "synthetic-demo-backend", forkedAtTurnId: "turn-2", createdAt: Date.now() + 4, position: { x: 735, y: 535 }, title: "Isolated worktree direction", titleOrigin: "automatic", lastViewedTurnId: null },
  };
  demoSpace.camera = { x: 20, y: 20, scale: 1 };
  await page.evaluate(async (state) => { await window.peel.saveState(state); location.reload(); }, demoState);
  await expect(page.locator(".overview-card")).toHaveCount(6);
  await expect(page.locator(".overview-edges path")).toHaveCount(5);
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await expect(page.locator(".overview-edges path.active")).toHaveCount(1);
  const worktreeCard = page.locator(".overview-card").filter({ hasText: "Isolated worktree direction" });
  await worktreeCard.hover();
  await expect(page.locator(".overview-edges path.active")).toHaveCount(2);
  await expect(worktreeCard.getByText("Branched from Codex backend integration", { exact: false })).toBeVisible();
  await page.screenshot({ path: join(desktopRoot, "test-results/ui-overview-6.png") });
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 720));
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1000);
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  const narrowOverviewFit = await page.locator(".overview-viewport").evaluate((viewport) => {
    const frame = viewport.getBoundingClientRect();
    const cards = [...document.querySelectorAll<HTMLElement>(".overview-card")].map((card) => card.getBoundingClientRect());
    const controls = document.querySelector<HTMLElement>(".zoom-controls")!.getBoundingClientRect();
    return {
      pageFits: document.documentElement.scrollWidth === window.innerWidth,
      cardsFit: cards.every((card) => card.left >= frame.left - 1 && card.top >= frame.top - 1 && card.right <= frame.right + 1 && card.bottom <= frame.bottom + 1),
      controlsFit: controls.left >= frame.left && controls.right <= frame.right && controls.top >= frame.top && controls.bottom <= frame.bottom,
      cardWidth: Math.min(...cards.map((card) => card.width)),
    };
  });
  expect(narrowOverviewFit).toMatchObject({ pageFits: true, cardsFit: true, controlsFit: true });
  expect(narrowOverviewFit.cardWidth).toBeGreaterThan(175);
  await page.screenshot({ path: join(desktopRoot, "test-results/ui-overview-6-narrow.png") });
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 960));
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1440);

  const scaleState = await page.evaluate(() => window.peel.bootstrap().then((payload) => payload.state));
  const scaleSpace = scaleState.spaces[firstSpaceId]!;
  const scaleRoot = scaleSpace.nodes[scaleSpace.rootThreadId]!;
  scaleSpace.nodes["synthetic-scale-45"] = { ...scaleRoot, threadId: "synthetic-scale-45", parentThreadId: scaleSpace.rootThreadId, forkedAtTurnId: "turn-2", createdAt: Date.now() + 45, position: suggestedChildPosition(scaleSpace, scaleSpace.rootThreadId), title: "Scale direction 45", titleOrigin: "automatic", lastViewedTurnId: null };
  for (let index = 0; Object.keys(scaleSpace.nodes).length < 49; index += 1) {
    const id = `synthetic-scale-${index}`;
    if (scaleSpace.nodes[id]) continue;
    scaleSpace.nodes[id] = { ...scaleRoot, threadId: id, parentThreadId: scaleSpace.rootThreadId, forkedAtTurnId: "turn-2", createdAt: Date.now() + index, position: suggestedChildPosition(scaleSpace, scaleSpace.rootThreadId), title: `Scale direction ${index}`, titleOrigin: "automatic", lastViewedTurnId: null };
  }
  scaleSpace.nodes["synthetic-failed"] = { ...scaleRoot, threadId: "synthetic-failed", parentThreadId: scaleSpace.rootThreadId, forkedAtTurnId: "turn-2", createdAt: Date.now() + 49, position: suggestedChildPosition(scaleSpace, scaleSpace.rootThreadId), title: "Failed direction", titleOrigin: "automatic", lastViewedTurnId: null };
  scaleSpace.camera = { x: 70, y: 60, scale: .42 };
  await page.evaluate(async (state) => { await window.peel.saveState(state); location.reload(); }, scaleState);
  await expect(page.locator(".overview-card")).toHaveCount(50);

  await app!.close();
  app = null;
  await launch();
  await expect(page.locator(".overview-card")).toHaveCount(50);
  await expect(page.getByText("Scale direction 45")).toBeAttached();
  await expect(page.locator(".status-dot.failed")).toBeAttached();
  await expect(page.locator(".overview-edges path")).toHaveCount(49);
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await page.waitForTimeout(100);
  const fitResult = await page.locator(".overview-viewport").evaluate((viewport) => {
    const frame = viewport.getBoundingClientRect();
    const cards = [...document.querySelectorAll<HTMLElement>(".overview-card")].map((card) => card.getBoundingClientRect());
    const svg = document.querySelector<SVGSVGElement>(".overview-edges")!;
    const viewBox = svg.viewBox.baseVal;
    const pathsFit = [...svg.querySelectorAll("path")].every((path) => {
      const box = path.getBBox();
      return box.x >= viewBox.x && box.y >= viewBox.y && box.x + box.width <= viewBox.x + viewBox.width && box.y + box.height <= viewBox.y + viewBox.height;
    });
    return {
      cardsFit: cards.every((card) => card.left >= frame.left - 1 && card.top >= frame.top - 1 && card.right <= frame.right + 1 && card.bottom <= frame.bottom + 1),
      pathsFit,
    };
  });
  expect(fitResult).toEqual({ cardsFit: true, pathsFit: true });
  await page.screenshot({ path: join(desktopRoot, "test-results/overview-50.png") });
  const lateCard = page.locator(".overview-card").filter({ hasText: "Scale direction 45" });
  await lateCard.getByRole("button", { name: "Open Scale direction 45" }).press("Enter");
  await expect(page.locator(".thread-name")).toHaveText("Scale direction 45");
  await page.locator(".segmented button").nth(1).click();
  await page.locator(".overview-card").filter({ has: page.getByRole("heading", { name: "Overview branch name", exact: true }) }).getByRole("button", { name: "Open Overview branch name" }).press("Enter");
  await expect(page.getByLabel("Message")).toHaveValue("Close-fast draft survives without waiting for debounce");
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(desktopRoot, "test-results/focus-restored.png") });
  await writeFile(join(repository, "DIFF_TEST.md"), "diff drawer exact file and patch\n");
  await page.getByRole("button", { name: /Diff/ }).click();
  await expect(page.getByText("Workspace changes")).toBeVisible();
  await expect(page.getByText("Compared with main", { exact: true })).toBeVisible();
  await expect(page.getByText("DIFF_TEST.md", { exact: true })).toBeVisible();
  await expect(page.locator(".diff-patch")).toContainText("diff drawer exact file and patch");
  await expect(page.getByRole("button", { name: "Open in Codex" })).toBeVisible();
  await page.screenshot({ path: join(desktopRoot, "test-results/ui-diff.png") });
  await page.locator(".diff-drawer").getByRole("button").first().click();
  await expect(page.getByLabel("Message")).toBeVisible();

  await page.locator(".space-sidebar").getByRole("button", { name: "Search Chats" }).click();
  await page.getByLabel("Search Codex Chats").fill("Catalog direction 69");
  await page.locator(".thread-result").filter({ hasText: "Catalog direction 69" }).click();
  const directDraft = page.getByLabel("Message");
  await directDraft.fill("A direct send survives a failed session resume");
  await page.locator('.composer input[type="file"]').setInputFiles(attachmentPath);
  const directEventsBefore = await readRpcEvents();
  await writeFile(join(repository, "fail-resume"), "1");
  await directDraft.press("Enter");
  await expect(page.getByRole("alert")).toContainText("could not be resumed");
  await expect(directDraft).toHaveValue("A direct send survives a failed session resume");
  await expect(page.locator(".attachment")).toContainText("Image");
  await directDraft.press("Enter");
  await expect(page.getByText("Command approval")).toBeVisible();
  await expect(directDraft).toHaveValue("");
  await expect(page.locator(".attachment")).toHaveCount(0);
  const directEvents = (await readRpcEvents()).slice(directEventsBefore.length);
  const directResumeIndex = directEvents.findIndex((event) => event.method === "thread/resume" && event.params?.threadId === "catalog-69");
  const directTurnIndex = directEvents.findIndex((event) => event.method === "turn/start" && event.params?.threadId === "catalog-69");
  expect(directResumeIndex).toBeGreaterThanOrEqual(0);
  expect(directTurnIndex).toBeGreaterThan(directResumeIndex);
  expect(directEvents.filter((event) => event.method === "turn/start" && event.params?.threadId === "catalog-69")).toHaveLength(1);
});
