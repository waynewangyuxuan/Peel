import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = process.env.PEEL_CODEX_BINARY || "/opt/homebrew/bin/codex";
const generated = mkdtempSync(join(tmpdir(), "peel-appserver-schema-"));
const experimentalGenerated = mkdtempSync(join(tmpdir(), "peel-appserver-schema-experimental-"));
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
const realtimeMethods = [
  "thread/realtime/start",
  "thread/realtime/appendAudio",
  "thread/realtime/stop",
];
const realtimeNotifications = [
  "thread/realtime/started",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/error",
  "thread/realtime/closed",
];

try {
  execFileSync(binary, ["app-server", "generate-ts", "--out", generated], { stdio: "pipe" });
  execFileSync(binary, ["app-server", "generate-ts", "--experimental", "--out", experimentalGenerated], { stdio: "pipe" });
  const clientRequest = readFileSync(join(generated, "ClientRequest.ts"), "utf8");
  const serverNotification = readFileSync(join(generated, "ServerNotification.ts"), "utf8");
  const experimentalClientRequest = readFileSync(join(experimentalGenerated, "ClientRequest.ts"), "utf8");
  const experimentalServerNotification = readFileSync(join(experimentalGenerated, "ServerNotification.ts"), "utf8");
  for (const method of methods) assert.match(clientRequest, new RegExp(`"method": "${method.replace("/", "\\/")}"`));
  for (const method of notifications) {
    assert.match(serverNotification, new RegExp(`"method": "${method.replace("/", "\\/")}"`));
  }
  for (const method of realtimeMethods) assert.match(experimentalClientRequest, new RegExp(`"method": "${method.replace("/", "\\/")}"`));
  for (const method of realtimeNotifications) assert.match(experimentalServerNotification, new RegExp(`"method": "${method.replace("/", "\\/")}"`));
  process.stdout.write(
    `${JSON.stringify({ schema: "compatible", binary, methods: methods.length, notifications: notifications.length, realtimeMethods: realtimeMethods.length, realtimeNotifications: realtimeNotifications.length })}\n`,
  );
} finally {
  rmSync(generated, { recursive: true, force: true });
  rmSync(experimentalGenerated, { recursive: true, force: true });
}
