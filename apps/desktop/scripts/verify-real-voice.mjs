import { chromium } from "playwright";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const bundle = join(desktopRoot, "out/Peel-darwin-arm64/Peel.app");
const fixture = join(desktopRoot, "e2e/fixtures/codex");
const scratch = await mkdtemp(join(tmpdir(), "peel-real-voice-"));
const userData = join(scratch, "user-data");
const aiff = join(scratch, "phrase.aiff");
const wav = join(scratch, "phrase.wav");
const tccLogPath = join(scratch, "tcc.log");
const phrase = "Peel voice check is working";
const initialDraft = "Existing draft remains.";
const port = await freePort();
let browser;

try {
  await exec("/usr/bin/say", ["-v", "Samantha", "-o", aiff, phrase]);
  await exec("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", aiff, wav]);
  await exec("/usr/bin/open", [
    "-n",
    bundle,
    "--args",
    `--remote-debugging-port=${port}`,
    "--peel-user-data-path", userData,
    "--peel-codex-binary", fixture,
    "--peel-test-tmpdir", scratch,
    "--peel-test-quit-after-voice",
  ]);

  const endpoint = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      browser = await chromium.connectOverCDP(endpoint);
      break;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  if (!browser) throw new Error("Packaged Peel did not expose its verification endpoint");
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent("page");
  const searchChats = page.locator(".welcome").getByRole("button", { name: "Search Chats", exact: true });
  await searchChats.waitFor({ state: "visible", timeout: 20_000 });
  await page.waitForFunction(() => {
    const button = document.querySelector(".welcome .secondary-button");
    return button instanceof HTMLButtonElement && !button.disabled;
  }, undefined, { timeout: 20_000 });
  await searchChats.click();
  await page.locator(".thread-result").first().click();

  const draft = page.getByLabel("Message");
  await draft.fill(initialDraft);
  const rpcLogPath = join(scratch, "peel-mock-rpc.jsonl");
  const turnsBefore = countTurns(await readFile(rpcLogPath, "utf8"));
  const audio = [...await readFile(wav)];
  await page.evaluate(async (bytes) => {
    const context = new AudioContext();
    const decoded = await context.decodeAudioData(Uint8Array.from(bytes).buffer);
    const destination = context.createMediaStreamDestination();
    const source = context.createBufferSource();
    source.buffer = decoded;
    source.connect(destination);
    let scheduled = false;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        if (!scheduled) {
          scheduled = true;
          setTimeout(() => source.start(), 500);
        }
        return destination.stream;
      },
    });
  }, audio);

  await page.getByTitle("Dictate into draft").click();
  await page.getByTitle("Stop dictation").waitFor({ state: "visible" });
  await page.waitForTimeout(4_000);
  await page.getByTitle("Stop dictation").click();
  await page.waitForFunction((before) => {
    const value = document.querySelector("textarea")?.value ?? "";
    return value !== before || Boolean(document.querySelector(".composer-error"));
  }, initialDraft, { timeout: 60_000 });

  const value = await draft.inputValue();
  const errors = await page.locator(".composer-error").allTextContents();
  const turnsAfter = countTurns(await readFile(rpcLogPath, "utf8"));
  const { stdout: tccLog } = await exec("/usr/bin/log", [
    "show", "--last", "3m", "--style", "compact", "--predicate",
    '(process == "peel-speech") OR ((process == "tccd") AND (eventMessage CONTAINS[c] "com.peel.desktop" OR eventMessage CONTAINS[c] "peel-speech"))',
  ], { maxBuffer: 8 * 1024 * 1024 });
  await writeFile(tccLogPath, tccLog);
  const tccSubjectIsPeel = tccLog.includes("subject=com.peel.desktop");
  const responsibleIsPeel = tccLog.includes(`responsible_path=${bundle}/Contents/MacOS/Peel`);
  const responsibleIsChatGpt = tccLog.includes("responsible_path=/Applications/ChatGPT.app");
  const ok = value.toLowerCase().includes("peel voice check")
    && value.startsWith(initialDraft)
    && turnsAfter === turnsBefore
    && errors.length === 0
    && tccSubjectIsPeel
    && responsibleIsPeel
    && !responsibleIsChatGpt;
  const result = { ok, phrase, value, errors, turnsBefore, turnsAfter, tccSubjectIsPeel, responsibleIsPeel, responsibleIsChatGpt, scratch, tccLogPath };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!ok) process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  if (!process.env.KEEP_PEEL_VOICE_SCRATCH) await rm(scratch, { recursive: true, force: true });
}

function countTurns(content) {
  return content.match(/"method":"turn\/start"/g)?.length ?? 0;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const selectedPort = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolvePromise, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolvePromise()));
  return selectedPort;
}
