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
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      fail(new Error("Dictation timed out after 45 seconds. Your existing draft was left unchanged."));
    }, 45_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => {
      fail(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout || "{}") as VoiceHelperResponse;
        if ((code !== 0 || signal) && parsed.ok !== false) {
          if (signal === "SIGABRT") {
            reject(new Error("macOS blocked Speech Recognition for this launch. Open the packaged Peel app directly and try again; your existing draft was left unchanged."));
            return;
          }
          const termination = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
          reject(new Error(stderr.trim() || `Speech recognition stopped unexpectedly (${termination}). Your existing draft was left unchanged.`));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new Error(stderr.trim() || "Speech helper returned an invalid response"));
      }
    });
  });
}
