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
    access(join(resources, "Peel.png"), fsConstants.R_OK),
  ]);
  const plist = await readFile(join(bundle, "Contents/Info.plist"), "utf8");
  if (!plist.includes("NSMicrophoneUsageDescription") || !plist.includes("NSSpeechRecognitionUsageDescription")) {
    throw new Error("Packaged Info.plist is missing microphone or speech-recognition usage text");
  }
  const iconFile = plist.match(/<key>CFBundleIconFile<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  if (!iconFile) throw new Error("Packaged Info.plist does not declare CFBundleIconFile");
  await access(join(resources, iconFile), fsConstants.R_OK);
  const iconBytes = await readFile(join(resources, iconFile));
  if (iconBytes.subarray(0, 4).toString("ascii") !== "icns" || iconBytes.byteLength < 10_000) {
    throw new Error(`Packaged icon ${iconFile} is not a valid non-empty icns resource`);
  }
  const dockIcon = await readFile(join(resources, "Peel.png"));
  if (dockIcon.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || dockIcon.readUInt32BE(16) !== 1024 || dockIcon.readUInt32BE(20) !== 1024) {
    throw new Error("Packaged Dock icon is not the expected 1024px PNG");
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
  const packagedAppName = await application.evaluate(({ app }) => app.getName());
  if (packagedAppName !== "Peel") {
    await application.close();
    throw new Error(`Packaged application name is ${JSON.stringify(packagedAppName)} instead of Peel`);
  }
  let page = await application.firstWindow();
  await page.locator(".welcome").getByRole("button", { name: "Search Chats", exact: true }).click();
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
  process.stdout.write(`${JSON.stringify({ ok: true, bundle, appName: packagedAppName, restoredDraft: true, nativeVoiceHelper: true, nativeAppIcon: iconFile })}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
