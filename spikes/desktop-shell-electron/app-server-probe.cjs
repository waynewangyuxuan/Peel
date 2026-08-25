const { spawn } = require("node:child_process");
const { accessSync, constants } = require("node:fs");
const { createInterface } = require("node:readline");

const DEFAULT_TIMEOUT_MS = 10_000;
const ENV_ALLOWLIST = [
  "CODEX_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "USER",
];

function isExecutable(path) {
  if (!path) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCodexBinary(env = process.env) {
  const candidates = [
    env.PEEL_CODEX_BIN,
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
  const pathCandidates = (env.PATH || "")
    .split(":")
    .filter(Boolean)
    .map((directory) => `${directory}/codex`);

  const resolved = [...candidates, ...pathCandidates].find(isExecutable);
  if (!resolved) {
    throw new Error(
      "Codex executable not found. Set PEEL_CODEX_BIN to an absolute executable path.",
    );
  }
  return resolved;
}

function buildCodexEnvironment(env = process.env) {
  return Object.fromEntries(
    ENV_ALLOWLIST.filter((name) => typeof env[name] === "string").map((name) => [
      name,
      env[name],
    ]),
  );
}

function runAppServerHandshake({
  cwd,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const startedAt = Date.now();
  const codexBinary = resolveCodexBinary(env);
  const child = spawn(codexBinary, ["app-server", "--stdio"], {
    cwd,
    env: buildCodexEnvironment(env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  let settled = false;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      lines.close();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const timeout = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `Codex App Server initialize timed out after ${timeoutMs}ms${
              stderr ? `: ${stderr.trim()}` : ""
            }`,
          ),
        ),
      );
    }, timeoutMs);

    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== 0) return;
      if (message.error) {
        finish(() => reject(new Error(`Codex App Server initialize failed: ${line}`)));
        return;
      }

      child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      const result = {
        ok: true,
        codexBinary,
        elapsedMs: Date.now() - startedAt,
        serverInfo: message.result?.serverInfo || null,
        userAgent: message.result?.userAgent || null,
      };
      finish(() => resolve(result));
    });

    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(() =>
          reject(
            new Error(
              `Codex App Server exited before initialize completed (${code ?? signal})${
                stderr ? `: ${stderr.trim()}` : ""
              }`,
            ),
          ),
        );
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        method: "initialize",
        id: 0,
        params: {
          clientInfo: {
            name: "peel_desktop_shell_spike",
            title: "Peel Desktop Shell Spike",
            version: "0.0.0",
          },
        },
      })}\n`,
    );
  });
}

module.exports = {
  buildCodexEnvironment,
  resolveCodexBinary,
  runAppServerHandshake,
};

if (require.main === module) {
  const asJson = process.argv.includes("--json");
  runAppServerHandshake({ cwd: process.cwd() })
    .then((result) => {
      process.stdout.write(
        asJson ? `${JSON.stringify(result)}\n` : `Codex App Server ready in ${result.elapsedMs}ms\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}

