import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { VoiceService } from "../src/main/voice-service";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function helper(response: object): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "peel-voice-helper-"));
  directories.push(directory);
  const path = join(directory, "helper");
  await writeFile(path, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${JSON.stringify(response)}\n`)});\n`);
  await chmod(path, 0o755);
  return path;
}

async function rawHelper(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "peel-voice-helper-"));
  directories.push(directory);
  const path = join(directory, "helper");
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("VoiceService native boundary", () => {
  it("returns a final transcript without owning or sending the editable draft", async () => {
    const service = new VoiceService(await helper({ ok: true, text: "editable transcript" }));
    await expect(service.transcribe(new Uint8Array(48))).resolves.toEqual({ text: "editable transcript", isFinal: true });
  });

  it("surfaces recognizer failure without a replacement transcript", async () => {
    const service = new VoiceService(await helper({ ok: false, error: "recognizer interrupted", code: "recognition-error" }));
    await expect(service.transcribe(new Uint8Array(48))).rejects.toThrow("recognizer interrupted");
  });

  it("rejects an unusable capture before invoking native recognition", async () => {
    const service = new VoiceService("/does/not/exist");
    await expect(service.transcribe(new Uint8Array(43))).rejects.toThrow("did not contain usable audio");
  });

  it("turns a macOS privacy abort into an actionable independent-launch error", async () => {
    const service = new VoiceService(await rawHelper('process.kill(process.pid, "SIGABRT");'));
    await expect(service.transcribe(new Uint8Array(48))).rejects.toThrow("Open the packaged Peel app directly");
  });

  it("reports non-privacy termination signals without hiding the signal", async () => {
    const service = new VoiceService(await rawHelper('process.kill(process.pid, "SIGTERM");'));
    await expect(service.transcribe(new Uint8Array(48))).rejects.toThrow("signal SIGTERM");
  });
});
