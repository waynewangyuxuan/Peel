import { _electron as electron } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const executable = join(desktopRoot, "out/Peel-darwin-arm64/Peel.app/Contents/MacOS/Peel");
const scratch = await mkdtemp(join(tmpdir(), "peel-live-codex-"));
let application;
try {
  application = await electron.launch({
    executablePath: executable,
    env: { ...process.env, PEEL_USER_DATA_PATH: join(scratch, "user-data"), ELECTRON_DISABLE_SECURITY_WARNINGS: "true" },
  });
  const page = await application.firstWindow();
  const choose = page.getByRole("button", { name: /Choose a Codex Chat/ });
  await choose.waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes("Choose a Codex Chat"));
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 20_000 });
  await choose.click();
  await page.locator(".thread-results button").first().waitFor({ state: "visible", timeout: 20_000 });
  const threadCount = await page.locator(".thread-results button").count();
  process.stdout.write(`${JSON.stringify({ ok: true, connectedToLocalCodex: true, listedThreads: threadCount })}\n`);
} finally {
  await application?.close();
  await rm(scratch, { recursive: true, force: true });
}
