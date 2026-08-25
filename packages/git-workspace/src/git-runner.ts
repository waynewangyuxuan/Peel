import { spawn } from "node:child_process";

export interface GitRunOptions {
  cwd: string;
  allowedExitCodes?: readonly number[];
  signal?: AbortSignal;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitRunner {
  run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult>;
}

export class GitCommandError extends Error {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(
    message: string,
    details: { args: readonly string[]; cwd: string; exitCode: number | null; stderr: string },
  ) {
    super(message);
    this.name = "GitCommandError";
    this.args = details.args;
    this.cwd = details.cwd;
    this.exitCode = details.exitCode;
    this.stderr = details.stderr;
  }
}

export class LocalGitRunner implements GitRunner {
  async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
    return await new Promise<GitRunResult>((resolve, reject) => {
      const child = spawn("git", [...args], {
        cwd: options.cwd,
        env: gitEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        signal: options.signal,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        reject(
          new GitCommandError(`Could not run git ${args[0] ?? ""}: ${error.message}`, {
            args,
            cwd: options.cwd,
            exitCode: null,
            stderr,
          }),
        );
      });
      child.once("exit", (code) => {
        const exitCode = code ?? -1;
        const allowed = options.allowedExitCodes ?? [0];
        if (!allowed.includes(exitCode)) {
          reject(
            new GitCommandError(`git ${args[0] ?? ""} exited with ${exitCode}`, {
              args,
              cwd: options.cwd,
              exitCode,
              stderr,
            }),
          );
          return;
        }
        resolve({ stdout, stderr, exitCode });
      });
    });
  }
}

function gitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keys = ["HOME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME"];
  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
  };
  for (const key of keys) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}
