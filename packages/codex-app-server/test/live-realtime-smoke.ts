import assert from "node:assert/strict";

import { AppServerClient } from "../src/client.js";
import type { AppServerNotification } from "../src/protocol.js";
import { AppServerTransport } from "../src/transport.js";

function waitFor(
  transport: AppServerTransport,
  method: string | string[],
  threadId: string,
  timeoutMs = 30_000,
): Promise<AppServerNotification> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${Array.isArray(method) ? method.join(" or ") : method}`));
    }, timeoutMs);
    const listener = (notification: AppServerNotification): void => {
      const params = notification.params as { threadId?: string };
      const methods = Array.isArray(method) ? method : [method];
      if (!methods.includes(notification.method) || params.threadId !== threadId) return;
      cleanup();
      resolve(notification);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      transport.off("notification", listener);
    };
    transport.on("notification", listener);
  });
}

async function main(): Promise<void> {
  if (process.env.PEEL_CODEX_REALTIME_SMOKE !== "1") {
    process.stdout.write("Skipped: set PEEL_CODEX_REALTIME_SMOKE=1 to run the isolated realtime smoke.\n");
    return;
  }
  const transport = new AppServerTransport({
    codexBinary: process.env.PEEL_CODEX_BINARY || "/opt/homebrew/bin/codex",
    reconnect: false,
    requestTimeoutMs: 30_000,
  });
  const client = new AppServerClient(transport);
  let threadId: string | null = null;
  const turnEvents: string[] = [];
  transport.on("notification", (notification: AppServerNotification) => {
    if (notification.method.startsWith("turn/") || notification.method.startsWith("item/")) {
      turnEvents.push(notification.method);
    }
  });
  try {
    const initialized = await client.connect();
    assert.equal(client.capabilities.featureStatus("realtime-voice"), "experimental-enabled");
    const created = await client.startThread({ ephemeral: true });
    threadId = created.thread.id;
    const started = waitFor(transport, ["thread/realtime/started", "thread/realtime/error"], threadId);
    await client.startRealtime({
      threadId,
      outputModality: "text",
      includeStartupContext: false,
      clientManagedHandoffs: true,
      codexResponsesAsItems: false,
      flushTranscriptTailOnSessionEnd: false,
      prompt: "Transcribe only. Do not answer or act.",
    });
    const startNotice = await started;
    if (startNotice.method === "thread/realtime/error") {
      const message = String((startNotice.params as { message?: unknown }).message ?? "");
      assert.match(message, /requires API key auth/i);
      const read = await client.readThread(threadId, false);
      assert.equal(read.turns.length, 0);
      assert.deepEqual(turnEvents, []);
      process.stdout.write(`${JSON.stringify({
        result: "passed",
        server: initialized.userAgent,
        engine: "native-fallback",
        runtimePreflight: "chatgpt-auth-rejected",
        rejection: message,
        experimentalApi: client.capabilities.snapshot().experimentalApi,
        turnsCreated: 0,
        turnEvents,
      })}\n`);
      return;
    }
    const closed = waitFor(transport, "thread/realtime/closed", threadId);
    await client.stopRealtime(threadId);
    await closed;
    const read = await client.readThread(threadId, false);
    assert.equal(read.turns.length, 0);
    assert.deepEqual(turnEvents, []);
    process.stdout.write(`${JSON.stringify({
      result: "passed",
      server: initialized.userAgent,
      engine: "codex-realtime",
      experimentalApi: client.capabilities.snapshot().experimentalApi,
      turnsCreated: 0,
      turnEvents,
    })}\n`);
  } finally {
    if (threadId) await client.deleteThread(threadId).catch(() => undefined);
    await transport.shutdown().catch(() => undefined);
  }
}

await main();
