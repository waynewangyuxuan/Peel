import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { automaticTitle, createSpace, emptyState, temporaryTitle } from "../src/shared/state";

const desktop = resolve(import.meta.dirname, "..");
const codexMock = join(desktop, "e2e/fixtures/codex");

test("default Space names follow the Root until a manual rename and survive migration plus restart", async ({}, testInfo) => {
  test.setTimeout(45_000);
  const scratch = await mkdtemp(join(tmpdir(), "peel-space-title-"));
  const userData = join(scratch, "data");
  await mkdir(userData);
  await chmod(codexMock, 0o755);
  let app: ElectronApplication | null = null;
  try {
    app = await launch(userData, scratch);
    let page = await app.firstWindow();
    const newChat = page.locator(".space-sidebar").getByRole("button", { name: "New Chat", exact: true });
    await expect(newChat).toBeEnabled();
    await newChat.click();
    let activeSpaceName = selectedSpaceName(page);
    await expect(activeSpaceName).toHaveText("New Chat");

    const firstPrompt = "Plan resilient sidebar titles carefully. Then verify restart.";
    await page.getByLabel("Message").fill(firstPrompt);
    await page.getByLabel("Message").press("Enter");
    await expect(activeSpaceName).toHaveText(temporaryTitle(firstPrompt, "New Chat"));
    await expect(activeSpaceName).toHaveText(automaticTitle(firstPrompt), { timeout: 3_000 });
    await expect(page.locator(".thread-name")).toHaveText(automaticTitle(firstPrompt));
    await page.screenshot({ path: testInfo.outputPath("default-space-follows-root.png") });

    const rootSpaceTitle = automaticTitle(firstPrompt);
    const forkPrompt = "Keep this Fork title independent from its Space.";
    await page.getByRole("button", { name: "Branch from here" }).last().click();
    await page.locator(".fork-surface textarea").fill(forkPrompt);
    await page.getByRole("button", { name: "Create & send" }).click();
    await expect(page.locator(".lineage-tree button")).toHaveCount(2);
    await expect(page.locator(".thread-name")).toHaveText(automaticTitle(forkPrompt), { timeout: 3_000 });
    await expect(activeSpaceName).toHaveText(rootSpaceTitle);
    await renameThread(page, "Manual Fork title");
    await expect(activeSpaceName).toHaveText(rootSpaceTitle);
    expect(await readFile(join(scratch, "peel-mock-rpc.jsonl"), "utf8")).toContain('"method":"thread/name/set","params":{"threadId":"thread-child-1","name":"Manual Fork title"}');
    await page.locator(".lineage-tree button").first().click();
    await expect(page.locator(".thread-name")).toHaveText(rootSpaceTitle);

    const nameSetsBeforeSpaceRename = (await readFile(join(scratch, "peel-mock-rpc.jsonl"), "utf8")).match(/"method":"thread\/name\/set"/g)?.length ?? 0;
    await renameSpace(page, "My research Space");
    await expect(activeSpaceName).toHaveText("My research Space");
    await page.waitForTimeout(100);
    expect((await readFile(join(scratch, "peel-mock-rpc.jsonl"), "utf8")).match(/"method":"thread\/name\/set"/g)?.length ?? 0).toBe(nameSetsBeforeSpaceRename);
    await renameThread(page, "Manual Root title");
    await expect(page.locator(".thread-name")).toHaveText("Manual Root title");
    await expect(activeSpaceName).toHaveText("My research Space");
    await expect.poll(async () => await activeSpaceState(page)).toMatchObject({
      name: "My research Space",
      nameOrigin: "manual",
      rootTitle: "Manual Root title",
      rootTitleOrigin: "manual",
    });

    await newChat.click();
    activeSpaceName = selectedSpaceName(page);
    await expect(activeSpaceName).toHaveText("New Chat");
    const secondPrompt = "Keep this delayed automatic title separate. Then finish.";
    await page.getByLabel("Message").fill(secondPrompt);
    await page.getByLabel("Message").press("Enter");
    await expect(activeSpaceName).toHaveText(temporaryTitle(secondPrompt, "New Chat"));
    await renameSpace(page, "Pinned before completion");
    await expect(page.locator(".thread-name")).toHaveText(automaticTitle(secondPrompt), { timeout: 3_000 });
    await expect(activeSpaceName).toHaveText("Pinned before completion");
    await page.screenshot({ path: testInfo.outputPath("manual-space-survives-automatic-title.png") });

    await app.close();
    app = await launch(userData, scratch);
    page = await app.firstWindow();
    activeSpaceName = selectedSpaceName(page);
    await expect(activeSpaceName).toHaveText("Pinned before completion");
    await expect.poll(async () => await activeSpaceState(page)).toMatchObject({ name: "Pinned before completion", nameOrigin: "manual" });
    await renameThread(page, "Root renamed after restart");
    await expect(activeSpaceName).toHaveText("Pinned before completion");

    await app.close();
    app = null;
    const legacyFollowing = createSpace({ id: "thread-root", name: null, preview: "", cwd: scratch, createdAt: 1 });
    legacyFollowing.name = "New Chat";
    legacyFollowing.nodes[legacyFollowing.rootThreadId]!.title = "Recovered legacy Root title";
    delete (legacyFollowing as { nameOrigin?: unknown }).nameOrigin;
    const legacyManual = createSpace({ id: "catalog-01", name: null, preview: "", cwd: scratch, createdAt: 2 });
    legacyManual.name = "Pinned legacy label";
    legacyManual.nodes[legacyManual.rootThreadId]!.title = "Different Root title";
    delete (legacyManual as { nameOrigin?: unknown }).nameOrigin;
    legacyFollowing.updatedAt = 10;
    legacyManual.updatedAt = 5;
    const legacyState = emptyState();
    legacyState.spaces = { [legacyFollowing.id]: legacyFollowing, [legacyManual.id]: legacyManual };
    legacyState.activeSpaceId = legacyFollowing.id;
    legacyState.activeThreadId = legacyFollowing.rootThreadId;
    await writeFile(join(userData, "peel-state.json"), `${JSON.stringify(legacyState, null, 2)}\n`);

    app = await launch(userData, scratch);
    page = await app.firstWindow();
    await expect(page.locator(".space-sidebar nav strong").filter({ hasText: "Recovered legacy Root title" })).toHaveCount(1);
    await expect(page.locator(".space-sidebar nav strong").filter({ hasText: "Pinned legacy label" })).toHaveCount(1);
    await expect.poll(async () => await page.evaluate(() => {
      return window.peel.bootstrap().then(({ state }) => Object.values(state.spaces).map((space) => ({ name: space.name, nameOrigin: space.nameOrigin })));
    })).toEqual(expect.arrayContaining([
      { name: "Recovered legacy Root title", nameOrigin: "default" },
      { name: "Pinned legacy label", nameOrigin: "manual" },
    ]));
    await page.getByRole("button", { name: "Overview", exact: true }).click();
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("legacy-space-title-repair.png") });
    await app.close();
    app = null;

    const persisted = JSON.parse(await readFile(join(userData, "peel-state.json"), "utf8")) as { spaces: Record<string, { name: string; nameOrigin?: string }> };
    expect(Object.values(persisted.spaces)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Recovered legacy Root title", nameOrigin: "default" }),
      expect.objectContaining({ name: "Pinned legacy label", nameOrigin: "manual" }),
    ]));
    app = await launch(userData, scratch);
    page = await app.firstWindow();
    await expect(page.locator(".space-sidebar nav strong").filter({ hasText: "Recovered legacy Root title" })).toHaveCount(1);
    await expect(page.locator(".space-sidebar nav strong").filter({ hasText: "Pinned legacy label" })).toHaveCount(1);
  } finally {
    await app?.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

async function launch(userData: string, scratch: string): Promise<ElectronApplication> {
  return await electron.launch({
    args: [desktop],
    env: {
      ...process.env,
      PEEL_RENDERER_URL: "",
      PEEL_USER_DATA_PATH: userData,
      PEEL_CODEX_BINARY: codexMock,
      TMPDIR: scratch,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
}

function selectedSpaceName(page: Page) {
  return page.locator('.space-sidebar nav button[aria-current="page"] .space-copy strong');
}

async function renameSpace(page: Page, name: string): Promise<void> {
  await page.locator(".space-name").dblclick();
  const input = page.locator(".topbar-title input");
  await input.fill(name);
  await input.press("Enter");
}

async function renameThread(page: Page, name: string): Promise<void> {
  await page.locator(".thread-name").dblclick();
  const input = page.locator(".topbar-title input");
  await input.fill(name);
  await input.press("Enter");
}

async function activeSpaceState(page: Page): Promise<{ name: string; nameOrigin: string; rootTitle: string; rootTitleOrigin: string }> {
  return await page.evaluate(async () => {
    const { state } = await window.peel.bootstrap();
    const space = state.spaces[state.activeSpaceId!]!;
    const root = space.nodes[space.rootThreadId]!;
    return { name: space.name, nameOrigin: space.nameOrigin, rootTitle: root.title, rootTitleOrigin: root.titleOrigin };
  });
}
