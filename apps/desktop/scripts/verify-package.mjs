import { _electron as electron } from "playwright";
import { access, chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const bundle = join(desktopRoot, "out/Peel-darwin-arm64/Peel.app");
const executable = join(bundle, "Contents/MacOS/Peel");
const resources = join(bundle, "Contents/Resources");
const helper = join(resources, "app.asar.unpacked/native/bin/peel-speech");
const fixture = join(desktopRoot, "e2e/fixtures/codex");
const rootTitle = "Review Inkstone Legacy product migration and narrative architecture across multiple directions";
const scratch = await mkdtemp(join(tmpdir(), "peel-package-smoke-"));
const userData = join(scratch, "user-data");

try {
  await Promise.all([
    access(executable, fsConstants.X_OK),
    access(join(resources, "app.asar"), fsConstants.R_OK),
    access(helper, fsConstants.X_OK),
  ]);
  const plist = await readFile(join(bundle, "Contents/Info.plist"), "utf8");
  if (!plist.includes("NSMicrophoneUsageDescription") || !plist.includes("NSSpeechRecognitionUsageDescription")) {
    throw new Error("Packaged Info.plist is missing microphone or speech-recognition usage text");
  }
  const helperBytes = await readFile(helper);
  if (!helperBytes.includes(Buffer.from("NSSpeechRecognitionUsageDescription")) || !helperBytes.includes(Buffer.from("com.peel.desktop.speech"))) {
    throw new Error("Native Speech helper is missing its embedded privacy declaration or bundle identity");
  }
  await chmod(fixture, 0o755);
  const env = {
    ...process.env,
    PEEL_CODEX_BINARY: fixture,
    PEEL_USER_DATA_PATH: userData,
    TMPDIR: scratch,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
  };

  let application = await electron.launch({ executablePath: executable, env });
  let page = await application.firstWindow();
  await page.getByRole("button", { name: /Choose a Codex Chat/ }).click();
  await page.getByText(rootTitle).last().click();
  await page.getByLabel("Message").fill("Packaged draft survives a full restart");
  await application.close();

  application = await electron.launch({ executablePath: executable, env });
  page = await application.firstWindow();
  const restored = await page.getByLabel("Message").inputValue();
  if (restored !== "Packaged draft survives a full restart") {
    await application.close();
    throw new Error(`Packaged restart lost draft state: ${JSON.stringify(restored)}`);
  }
  await application.close();
  process.stdout.write(`${JSON.stringify({ ok: true, bundle, restoredDraft: true, nativeVoiceHelper: true })}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
