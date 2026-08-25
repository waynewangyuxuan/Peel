import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = process.env.PEEL_CODEX_BINARY || "/opt/homebrew/bin/codex";
const generated = mkdtempSync(join(tmpdir(), "peel-appserver-schema-"));
const methods = [
  "initialize",
  "thread/list",
  "thread/read",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/name/set",
  "thread/delete",
  "turn/start",
  "turn/interrupt",
];
const notifications = [
  "thread/status/changed",
  "thread/name/updated",
  "turn/started",
  "turn/completed",
  "turn/diff/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
];

try {
  execFileSync(binary, ["app-server", "generate-ts", "--out", generated], { stdio: "pipe" });
  const clientRequest = readFileSync(join(generated, "ClientRequest.ts"), "utf8");
  const serverNotification = readFileSync(join(generated, "ServerNotification.ts"), "utf8");
  for (const method of methods) assert.match(clientRequest, new RegExp(`"method": "${method.replace("/", "\\/")}"`));
  for (const method of notifications) {
    assert.match(serverNotification, new RegExp(`"method": "${method.replace("/", "\\/")}"`));
  }
  process.stdout.write(
    `${JSON.stringify({ schema: "compatible", binary, methods: methods.length, notifications: notifications.length })}\n`,
  );
} finally {
  rmSync(generated, { recursive: true, force: true });
}
