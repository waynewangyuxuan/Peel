import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { AppServerClient } from "../src/client.js";
import type { AppServerMethod, RequestId } from "../src/protocol.js";
import type { AppServerTransport } from "../src/transport.js";
import { item, thread, turn } from "./fixtures.js";

class MockTransport extends EventEmitter {
  readonly initializeParams = {
    clientInfo: { name: "test", title: null, version: "1" },
    capabilities: { experimentalApi: false, requestAttestation: false },
  };
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{ id: RequestId; result?: unknown; error?: unknown }> = [];
  readonly results = new Map<string, unknown>();

  async request(method: AppServerMethod, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    const value = this.results.get(method);
    if (typeof value === "function") return await value(params);
    return value;
  }

  respond(id: RequestId, result: unknown): void {
    this.responses.push({ id, result });
  }

  respondError(id: RequestId, error: unknown): void {
    this.responses.push({ id, error });
  }
}

test("typed list/search/read/turn/name calls preserve Codex-owned thread identity", async () => {
  const transport = new MockTransport();
  const snapshot = thread("root", [turn("turn-1")]);
  transport.results.set("thread/list", { data: [snapshot], nextCursor: null, backwardsCursor: null });
  transport.results.set("thread/read", { thread: snapshot });
  transport.results.set("thread/resume", { thread: snapshot, model: "m", modelProvider: "p" });
  transport.results.set("turn/start", { turn: turn("turn-2", "inProgress") });
  transport.results.set("thread/name/set", {});
  const client = new AppServerClient(transport as unknown as AppServerTransport);

  assert.equal((await client.searchThreads("root")).data[0]?.id, "root");
  assert.equal((await client.readThread("root")).id, "root");
  assert.equal(
    await client.startTurn({ threadId: "root", input: [{ type: "text", text: "continue", text_elements: [] }] }),
    "turn-2",
  );
  await client.setThreadName("root", "Named root");
  assert.deepEqual(
    transport.calls.map((call) => call.method),
    ["thread/list", "thread/read", "thread/resume", "turn/start", "thread/name/set"],
  );
  assert.deepEqual(transport.calls[0]?.params, { searchTerm: "root" });
  assert.equal(client.reducer.getThread("root")?.thread.id, "root");
});

test("fork uses the exact completed turn and rejects known in-progress turns", async () => {
  const transport = new MockTransport();
  const snapshot = thread("root", [turn("done"), turn("active", "inProgress")]);
  transport.results.set("thread/read", { thread: snapshot });
  transport.results.set("thread/fork", { thread: thread("child"), model: "m", modelProvider: "p" });
  const client = new AppServerClient(transport as unknown as AppServerTransport);
  await client.readThread("root");

  await assert.rejects(client.forkThread({ threadId: "root", lastTurnId: "active" }), /in-progress/);
  const fork = await client.forkThread({ threadId: "root", lastTurnId: "done" });
  assert.equal(fork.thread.id, "child");
  assert.deepEqual(transport.calls.at(-1), {
    method: "thread/fork",
    params: { threadId: "root", lastTurnId: "done" },
  });
});

test("stream/status events reduce state and approvals use method-specific response shapes", async () => {
  const transport = new MockTransport();
  transport.results.set("thread/read", { thread: thread("root", [turn("active", "inProgress")]) });
  const client = new AppServerClient(transport as unknown as AppServerTransport);
  await client.readThread("root");
  let statusSeen = false;
  client.on("status", () => {
    statusSeen = true;
  });
  transport.emit("notification", {
    method: "item/started",
    params: { threadId: "root", turnId: "active", item: item("message") },
  });
  transport.emit("notification", {
    method: "item/agentMessage/delta",
    params: { threadId: "root", turnId: "active", itemId: "message", delta: "hello" },
  });
  transport.emit("notification", {
    method: "thread/status/changed",
    params: { threadId: "root", status: { type: "active", activeFlags: ["waitingOnApproval"] } },
  });
  assert.equal(statusSeen, true);
  assert.equal(client.reducer.getTurn("root", "active")?.items[0]?.streamedText, "hello");

  client.approveCommand(1, "acceptForSession");
  client.approveFileChange(2, "decline");
  client.grantPermissions(3, { network: true }, "turn", true);
  client.answerUserInput(4, { question: ["answer"] });
  assert.deepEqual(transport.responses, [
    { id: 1, result: { decision: "acceptForSession" } },
    { id: 2, result: { decision: "decline" } },
    { id: 3, result: { permissions: { network: true }, scope: "turn", strictAutoReview: true } },
    { id: 4, result: { answers: { question: ["answer"] } } },
  ]);
});

test("ready after interruption resumes loaded threads before rebuilding instead of keeping a shadow transcript", async () => {
  const transport = new MockTransport();
  let snapshot = thread("root", [turn("before")]);
  transport.results.set("thread/read", () => ({ thread: snapshot }));
  transport.results.set("thread/resume", () => ({ thread: snapshot }));
  const client = new AppServerClient(transport as unknown as AppServerTransport);
  await client.resumeThread("root");
  snapshot = thread("root", [turn("before"), turn("after")]);
  transport.emit("disconnected", new Error("fixture disconnect"));
  transport.emit("ready", {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.reducer.getThread("root")?.turns.length, 2);
  assert.equal(transport.calls.filter((call) => call.method === "thread/read").length, 0);
  assert.equal(transport.calls.filter((call) => call.method === "thread/resume").length, 2);
});

test("stored Threads resume once before turn/start and resume again after thread/closed", async () => {
  const transport = new MockTransport();
  const snapshot = thread("stored", [turn("before")]);
  let releaseResume!: () => void;
  const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
  transport.results.set("thread/read", { thread: snapshot });
  transport.results.set("thread/resume", async () => {
    await resumeGate;
    return { thread: snapshot };
  });
  let nextTurn = 1;
  transport.results.set("turn/start", () => ({ turn: turn(`continued-${nextTurn++}`, "inProgress") }));
  const client = new AppServerClient(transport as unknown as AppServerTransport);
  await client.readThread("stored");

  const first = client.startTurn({ threadId: "stored", input: [{ type: "text", text: "one", text_elements: [] }] });
  const second = client.startTurn({ threadId: "stored", input: [{ type: "text", text: "two", text_elements: [] }] });
  assert.equal(transport.calls.filter((call) => call.method === "thread/resume").length, 1);
  assert.equal(transport.calls.filter((call) => call.method === "turn/start").length, 0);
  releaseResume();
  assert.deepEqual(await Promise.all([first, second]), ["continued-1", "continued-2"]);
  assert.equal(transport.calls.filter((call) => call.method === "thread/resume").length, 1);
  assert.equal(transport.calls.filter((call) => call.method === "turn/start").length, 2);

  transport.emit("notification", { method: "thread/closed", params: { threadId: "stored" } });
  await client.startTurn({ threadId: "stored", input: [{ type: "text", text: "three", text_elements: [] }] });
  assert.equal(transport.calls.filter((call) => call.method === "thread/resume").length, 2);
  assert.equal(transport.calls.filter((call) => call.method === "turn/start").length, 3);
});

test("new and forked Threads start turns without an unnecessary resume", async () => {
  const transport = new MockTransport();
  transport.results.set("thread/start", { thread: thread("new"), model: "m", modelProvider: "p" });
  transport.results.set("thread/fork", { thread: thread("child"), model: "m", modelProvider: "p" });
  transport.results.set("turn/start", { turn: turn("active", "inProgress") });
  const client = new AppServerClient(transport as unknown as AppServerTransport);

  await client.startThread({});
  await client.startTurn({ threadId: "new", input: [{ type: "text", text: "new", text_elements: [] }] });
  await client.forkThread({ threadId: "new" });
  await client.startTurn({ threadId: "child", input: [{ type: "text", text: "child", text_elements: [] }] });
  assert.equal(transport.calls.filter((call) => call.method === "thread/resume").length, 0);
});

test("typed realtime calls preserve exact transcript-only request and PCM metadata", async () => {
  const transport = new MockTransport();
  transport.results.set("thread/realtime/start", {});
  transport.results.set("thread/realtime/appendAudio", {});
  transport.results.set("thread/realtime/stop", {});
  const client = new AppServerClient(transport as unknown as AppServerTransport);
  await client.startRealtime({
    threadId: "root",
    outputModality: "text",
    includeStartupContext: false,
    clientManagedHandoffs: true,
  });
  await client.appendRealtimeAudio("root", {
    data: "BQYH",
    sampleRate: 16_000,
    numChannels: 1,
    samplesPerChannel: 3,
    itemId: null,
  });
  await client.stopRealtime("root");
  assert.deepEqual(transport.calls.slice(-3), [
    {
      method: "thread/realtime/start",
      params: {
        threadId: "root",
        outputModality: "text",
        includeStartupContext: false,
        clientManagedHandoffs: true,
      },
    },
    {
      method: "thread/realtime/appendAudio",
      params: {
        threadId: "root",
        audio: { data: "BQYH", sampleRate: 16_000, numChannels: 1, samplesPerChannel: 3, itemId: null },
      },
    },
    { method: "thread/realtime/stop", params: { threadId: "root" } },
  ]);
  assert.equal(transport.calls.some((call) => call.method === "turn/start"), false);
});

test("capability gate is bound to the transport handshake flag", () => {
  const transport = new MockTransport();
  Object.defineProperty(transport, "initializeParams", {
    value: {
      clientInfo: { name: "test", title: null, version: "1" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    },
  });
  const client = new AppServerClient(transport as unknown as AppServerTransport);
  assert.equal(client.capabilities.snapshot().experimentalApi, false);
  assert.equal(client.capabilities.featureStatus("project-association"), "unavailable");
});
