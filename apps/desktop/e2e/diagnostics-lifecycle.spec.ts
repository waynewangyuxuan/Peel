import { _electron as electron, expect, test } from "@playwright/test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createSpace, emptyState } from "../src/shared/state";

const desktop = resolve(import.meta.dirname, "..");
const codexMock = join(desktop, "e2e/fixtures/codex");

test("global diagnostics close or fade while session history keeps scoped context", async () => {
  test.setTimeout(35_000);
  const scratch = await mkdtemp(join(tmpdir(), "peel-diagnostics-"));
  const userData = join(scratch, "data");
  await mkdir(userData);
  await chmod(codexMock, 0o755);
  const space = createSpace({ id: "thread-root", name: "Diagnostics conversation", preview: "", cwd: scratch, createdAt: 1 });
  space.nodes[space.rootThreadId]!.title = "Diagnostics conversation";
  await writeFile(join(userData, "peel-state.json"), JSON.stringify({
    ...emptyState(),
    spaces: { [space.id]: space },
    activeSpaceId: space.id,
    activeThreadId: space.rootThreadId,
    viewMode: "focus",
  }));
  const app = await electron.launch({
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
  try {
    const page = await app.firstWindow();
    await page.getByLabel("Message").fill("Exercise every server request route");
    await page.getByRole("button", { name: "Send", exact: true }).click();

    const globalWarnings = page.locator(".host-diagnostic.warning");
    const globalError = page.locator(".host-diagnostic.error");
    await expect(globalWarnings).toHaveCount(2);
    await expect(globalError).toContainText("Codex host requires attention");
    const configWarning = globalWarnings.filter({ hasText: "Codex configuration notice" });
    await configWarning.getByRole("button", { name: "Dismiss Codex notice" }).click();
    await expect(configWarning).toHaveCount(0);

    await page.getByRole("button", { name: /Diagnostics history, 5 items/ }).click();
    const drawer = page.getByRole("dialog", { name: "Codex diagnostics history" });
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".diagnostic-history-item")).toHaveCount(5);
    await expect(drawer.locator(".diagnostic-history-item").first()).toContainText("Codex host requires attention");
    await expect(drawer).toContainText("Diagnostics conversation · thread-root");
    await expect(drawer).toContainText("Global");
    await expect(drawer).toContainText("Full-history hydration is deprecated");
    await expect(drawer).not.toContainText("/private/fixture/config.toml");
    await expect(drawer.locator("time").first()).not.toHaveText("");
    await page.getByRole("button", { name: "Close Diagnostics" }).click();

    await expect(globalWarnings).toHaveCount(0, { timeout: 10_000 });
    await expect(globalError).toBeVisible();
    await globalError.getByRole("button", { name: "Dismiss Codex error" }).click();
    await expect(page.locator(".host-diagnostics")).toHaveCount(0);
    await expect(page.locator(".topbar")).toBeVisible();

    await page.getByRole("button", { name: /Diagnostics history, 5 items/ }).click();
    await expect(page.getByRole("dialog", { name: "Codex diagnostics history" }).locator(".diagnostic-history-item")).toHaveCount(5);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Codex diagnostics history" })).toHaveCount(0);
  } finally {
    await app.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
