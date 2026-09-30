import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createSpace, emptyState } from "../src/shared/state";

const desktop = resolve(import.meta.dirname, "..");
const codexMock = join(desktop, "e2e/fixtures/codex");

test("every ordinary Overview region opens its node and only Parent returns to the branch point", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "peel-overview-entry-"));
  const userData = join(scratch, "data");
  await mkdir(userData);
  await chmod(codexMock, 0o755);
  const space = createSpace({ id: "thread-root", name: "Root conversation", preview: "", cwd: scratch, createdAt: 1 });
  const root = space.nodes[space.rootThreadId]!;
  root.title = "Root conversation";
  root.position = { x: 0, y: 120 };
  space.nodes["synthetic-1"] = {
    ...root,
    threadId: "synthetic-1",
    parentThreadId: root.threadId,
    forkedAtTurnId: "turn-2",
    title: "Child alpha",
    createdAt: 2,
    position: { x: 380, y: 0 },
  };
  space.nodes["synthetic-2"] = {
    ...root,
    threadId: "synthetic-2",
    parentThreadId: root.threadId,
    forkedAtTurnId: "turn-2",
    title: "Sibling beta",
    createdAt: 3,
    position: { x: 380, y: 250 },
  };
  space.camera = { x: 70, y: 80, scale: .9 };
  await writeFile(join(userData, "peel-state.json"), JSON.stringify({
    ...emptyState(),
    spaces: { [space.id]: space },
    activeSpaceId: space.id,
    activeThreadId: root.threadId,
    viewMode: "overview",
  }));

  const launch = async (): Promise<ElectronApplication> => await electron.launch({
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
  let app: ElectronApplication | null = null;
  try {
    app = await launch();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1200, 760));
    let page = await app.firstWindow();
    const overview = page.getByRole("button", { name: "Overview", exact: true });
    const child = () => page.locator(".overview-card").filter({ has: page.getByRole("heading", { name: "Child alpha", exact: true }) });

    await child().locator("h3").click();
    await expect(page.locator(".thread-name")).toHaveText("Child alpha");

    await overview.click();
    await child().locator(".card-origin-copy").click();
    await expect(page.locator(".overview-shell")).toHaveCount(0);
    await expect(page.locator(".thread-name")).toHaveText("Child alpha");

    await overview.click();
    await child().getByText("Latest result", { exact: true }).click();
    await expect(page.locator(".thread-name")).toHaveText("Child alpha");
    await expect(page.locator('.turn.highlighted[data-turn-id="turn-2"]')).toBeVisible();

    await overview.click();
    await child().getByRole("button", { name: "Open parent Root conversation at branch point", exact: true }).click();
    await expect(page.locator(".thread-name")).toHaveText("Root conversation");
    await expect(page.locator('.turn.highlighted[data-turn-id="turn-2"]')).toBeVisible();

    await overview.click();
    await writeFile(join(scratch, "delay-read-synthetic-1"), "1");
    await child().locator(".card-status-group").click();
    await expect(page.locator(".thread-name")).toHaveText("Child alpha");
    await page.locator(".lineage-tree button").filter({ hasText: "Sibling beta" }).click();
    await page.waitForTimeout(420);
    await expect(page.locator(".thread-name")).toHaveText("Sibling beta");

    await overview.click();
    const rootCard = page.locator(".overview-card").filter({ has: page.getByRole("heading", { name: "Root conversation", exact: true }) });
    const box = (await rootCard.boundingBox())!;
    await page.mouse.move(box.x + 22, box.y + 22);
    await page.mouse.down();
    await page.mouse.move(box.x + 48, box.y + 44, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator(".overview-shell")).toBeVisible();

    await child().getByRole("button", { name: "Open Child alpha", exact: true }).press("Enter");
    await expect(page.locator(".thread-name")).toHaveText("Child alpha");
    await page.waitForTimeout(450);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator(".thread-name")).toHaveText("Child alpha");
  } finally {
    await app?.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
