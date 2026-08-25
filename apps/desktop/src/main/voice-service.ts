import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

interface VoiceHelperResponse {
  ok: boolean;
  text?: string;
  error?: string;
  code?: string;
}

export class VoiceService {
  constructor(private readonly helperPath: string) {}

  async transcribe(bytes: Uint8Array): Promise<{ text: string; isFinal: true }> {
    if (bytes.byteLength < 44) throw new Error("The recording did not contain usable audio");
    const directory = await mkdtemp(join(tmpdir(), "peel-dictation-"));
    const audioPath = join(directory, "dictation.wav");
    try {
      await writeFile(audioPath, bytes, { mode: 0o600 });
      await chmod(this.helperPath, 0o755);
      const response = await runHelper(this.helperPath, audioPath);
      if (!response.ok) throw new Error(response.error || "Speech recognition failed");
      const text = response.text?.trim() ?? "";
      if (!text) throw new Error("No speech was recognized. Your existing draft was left unchanged.");
      return { text, isFinal: true };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function runHelper(helperPath: string, audioPath: string): Promise<VoiceHelperResponse> {
  return await new Promise((resolve, reject) => {
    const child = spawn(helperPath, [audioPath], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Dictation timed out after 45 seconds"));
    }, 45_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout || "{}") as VoiceHelperResponse;
        if (code !== 0 && parsed.ok !== false) {
          reject(new Error(stderr.trim() || `Speech helper exited with code ${code ?? "unknown"}`));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new Error(stderr.trim() || "Speech helper returned an invalid response"));
      }
    });
  });
}
