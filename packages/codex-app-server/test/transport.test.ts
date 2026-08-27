import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  AppServerDisconnectedError,
  AppServerRequestAbortedError,
  AppServerRpcError,
  AppServerTransport,
  allowlistedEnvironment,
} from "../src/transport.js";
import { FakeProcess } from "./fixtures.js";

test("handshake, request correlation, notifications, server requests, and stderr", async () => {
  const child = new FakeProcess();
  let spawnedArgs: string[] = [];
  const transport = new AppServerTransport({
    codexBinary: "/bin/echo",
    reconnect: false,
    processFactory: (_binary, args) => {
      spawnedArgs = args;
      return child;
    },
  });
  const notifications: unknown[] = [];
  const serverRequests: unknown[] = [];
  const stderr: string[] = [];
  transport.on("notification", (value) => notifications.push(value));
  transport.on("serverRequest", (value) => serverRequests.push(value));
  transport.on("stderr", (value) => stderr.push(value));

  const initialized = await transport.connect();
  assert.equal(initialized.userAgent, "codex-test");
  assert.equal(transport.state, "ready");
  assert.equal(child.writes[1]?.method, "initialized");
  assert.deepEqual(spawnedArgs, ["app-server", "--stdio", "--enable", "realtime_conversation"]);
  assert.deepEqual((child.writes[0]?.params as { capabilities?: unknown }).capabilities, {
    experimentalApi: true,
    requestAttestation: false,
  });

  const pending = transport.request("thread/read", { threadId: "abc", includeTurns: true });
  const request = child.writes.find((message) => message.method === "thread/read");
  child.send({ id: request?.id, result: { thread: { id: "abc" } } });
  assert.deepEqual(await pending, { thread: { id: "abc" } });

  child.send({ method: "thread/status/changed", params: { threadId: "abc", status: { type: "idle" } } });
  child.send({ id: 90, method: "item/commandExecution/requestApproval", params: { threadId: "abc" } });
  child.stderr.write("diagnostic\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications.length, 1);
  assert.equal(serverRequests.length, 1);
  assert.match(stderr.join(""), /diagnostic/);

  transport.respond(90, { decision: "accept" });
  assert.deepEqual(child.writes.at(-1), { id: 90, result: { decision: "accept" } });
  await transport.shutdown();
  assert.equal(transport.state, "stopped");
});

test("RPC errors and local cancellation settle only the matching request", async () => {
  const child = new FakeProcess();
  const transport = new AppServerTransport({
    codexBinary: "/bin/echo",
    reconnect: false,
    processFactory: () => child,
  });
  await transport.connect();

  const missing = transport.request("thread/read", { threadId: "missing" });
  const missingRequest = child.writes.at(-1);
  child.send({ id: missingRequest?.id, error: { code: -32601, message: "not found" } });
  await assert.rejects(missing, (error: unknown) => error instanceof AppServerRpcError && error.code === -32601);

  const controller = new AbortController();
  const cancelled = transport.request("thread/list", {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, AppServerRequestAbortedError);
  await transport.shutdown();
});

test("unexpected exit rejects pending work, reconnects, and does not replay it", async () => {
  const children: FakeProcess[] = [];
  const transport = new AppServerTransport({
    codexBinary: "/bin/echo",
    reconnect: true,
    reconnectDelayMs: 1,
    processFactory: () => {
      const child = new FakeProcess();
      children.push(child);
      return child;
    },
  });
  await transport.connect();
  const pending = transport.request("thread/name/set", { threadId: "abc", name: "do-not-replay" });
  children[0]?.emit("exit", 1, null);
  await assert.rejects(pending, AppServerDisconnectedError);
  await once(transport, "ready");
  assert.equal(children.length, 2);
  assert.equal(children[1]?.writes.some((message) => message.method === "thread/name/set"), false);
  await transport.shutdown();
});

test("environment inheritance is allowlisted", () => {
  const result = allowlistedEnvironment({
    HOME: "/tmp/home",
    PATH: "/bin",
    OPENAI_API_KEY: "must-not-leak",
    RANDOM_SECRET: "must-not-leak",
  });
  assert.equal(result.HOME, "/tmp/home");
  assert.equal(result.PATH, "/bin");
  assert.equal(result.OPENAI_API_KEY, undefined);
  assert.equal(result.RANDOM_SECRET, undefined);
});
