import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("development launch presents Peel's native and renderer identity", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "peel-native-identity-"));
  const desktop = resolve(import.meta.dirname, "..");
  const application = await electron.launch({
    args: [desktop],
    env: {
      ...process.env,
      PEEL_RENDERER_URL: "",
      PEEL_USER_DATA_PATH: join(scratch, "user-data"),
      PEEL_CODEX_BINARY: join(desktop, "e2e/fixtures/codex"),
      TMPDIR: scratch,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });

  try {
    const identity = await application.evaluate(({ app }) => ({
      isPackaged: app.isPackaged,
      name: app.getName(),
    }));
    expect(identity).toEqual({ isPackaged: false, name: "Peel" });

    const page = await application.firstWindow();
    await expect(page.locator(".peel-mark").first()).toBeVisible();
    await expect(page.getByText("Peel", { exact: true }).first()).toBeVisible();
  } finally {
    await application.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
