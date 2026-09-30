import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const desktop = resolve(import.meta.dirname, "..");
const codexMock = join(desktop, "e2e/fixtures/codex");

test("branded first frame stays usable while Codex initialization is delayed or fails", async () => {
  test.setTimeout(30_000);
  await chmod(codexMock, 0o755);

  const delayed = await mkdtemp(join(tmpdir(), "peel-startup-delayed-"));
  await writeFile(join(delayed, "delay-initialize"), "1");
  let application: ElectronApplication | null = null;
  try {
    application = await launch(delayed, { PEEL_STARTUP_TEST_HYDRATION_DELAY_MS: "650" });
    const page = await application.firstWindow();
    const launchShell = page.locator("[data-peel-launch-shell]");
    await expect(launchShell).toBeVisible();
    await expect(launchShell.locator(".static-launch-mark")).toBeVisible();
    await expect.poll(async () => application!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(true);
    await expect.poll(async () => (await readFile(join(delayed, "peel-mock-rpc.jsonl"), "utf8")).includes('"method":"initialize"')).toBe(true);
    await expect(page.locator(".welcome")).toBeVisible();
    const search = page.getByRole("button", { name: "Search Chats", exact: true }).last();
    await expect(search).toBeDisabled();
    await expect(search).toBeEnabled({ timeout: 5_000 });
    await application.close();
    application = null;

    const failed = await mkdtemp(join(tmpdir(), "peel-startup-failed-"));
    try {
      await writeFile(join(failed, "fail-initialize"), "1");
      application = await launch(failed);
      const failedPage = await application.firstWindow();
      await expect(failedPage.locator(".welcome")).toBeVisible();
      await expect(failedPage.getByText("Mock Codex initialization failed", { exact: false })).toBeVisible();
      await expect(failedPage.getByRole("button", { name: "New Chat", exact: true }).last()).toBeDisabled();
    } finally {
      await application?.close();
      application = null;
      await rm(failed, { recursive: true, force: true });
    }
  } finally {
    await application?.close();
    await rm(delayed, { recursive: true, force: true });
  }
});

async function launch(scratch: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<ElectronApplication> {
  return await electron.launch({
    args: [desktop],
    env: {
      ...process.env,
      PEEL_RENDERER_URL: "",
      PEEL_USER_DATA_PATH: join(scratch, "data"),
      PEEL_CODEX_BINARY: codexMock,
      TMPDIR: scratch,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      ...extraEnv,
    },
  });
}
