import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createSpace, emptyState } from "../src/shared/state";

const threadId = "a3d8be2d-7fb5-4f7b-9c31-9d8f517f248a";

test("Open Codex targets the exact desktop conversation and reports dispatch failure", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "peel-open-codex-"));
  const desktop = resolve(import.meta.dirname, "..");
  const userData = join(scratch, "data");
  await mkdir(userData);
  const space = createSpace({ id: threadId, name: "Deep link fixture", preview: "", cwd: scratch, createdAt: 1 });
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
      PEEL_CODEX_BINARY: join(desktop, "e2e/fixtures/codex"),
      TMPDIR: scratch,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  try {
    await app.evaluate(({ shell }) => {
      const audit = { urls: [] as string[] };
      (globalThis as typeof globalThis & { peelOpenExternalAudit: typeof audit }).peelOpenExternalAudit = audit;
      Object.defineProperty(shell, "openExternal", {
        configurable: true,
        value: async (url: string) => { audit.urls.push(url); },
      });
    });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Open Codex", exact: true }).click();
    await expect.poll(async () => await app.evaluate(() =>
      (globalThis as typeof globalThis & { peelOpenExternalAudit: { urls: string[] } }).peelOpenExternalAudit.urls
    )).toEqual([`codex://threads/${threadId}`]);

    await page.evaluate(() => {
      const link = document.createElement("a");
      link.href = "https://example.com/safe-markdown-link";
      link.target = "_blank";
      document.body.append(link);
      link.click();
      link.remove();
    });
    await expect.poll(async () => await app.evaluate(() =>
      (globalThis as typeof globalThis & { peelOpenExternalAudit: { urls: string[] } }).peelOpenExternalAudit.urls
    )).toEqual([
      `codex://threads/${threadId}`,
      "https://example.com/safe-markdown-link",
    ]);

    await app.evaluate(({ shell }) => {
      Object.defineProperty(shell, "openExternal", {
        configurable: true,
        value: async () => { throw new Error("No registered handler"); },
      });
    });
    await page.getByRole("button", { name: "Open Codex", exact: true }).click();
    await expect(page.locator(".toast")).toContainText("Make sure the desktop app is installed");
    await expect(page.getByRole("button", { name: "Current Thread: Deep link fixture. Double-click to rename.", exact: true })).toBeVisible();
  } finally {
    await app.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
