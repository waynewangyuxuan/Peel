import assert from "node:assert/strict";
import test from "node:test";

import { AppServerReducer } from "../src/reducer.js";
import { item, thread, turn } from "./fixtures.js";

test("rebuild derives aggregate diff from authoritative thread snapshot", () => {
  const reducer = new AppServerReducer();
  reducer.rebuild(
    thread("t", [
      turn("turn-1", "completed", [
        item("file-1", "fileChange", { changes: [{ path: "a.ts", diff: "@@ -1 +1 @@\n-old\n+new" }] }),
      ]),
    ]),
  );
  assert.match(reducer.getTurn("t", "turn-1")?.aggregateDiff ?? "", /\+new/);
  assert.equal(reducer.latestCompletedTurn("t")?.turn.id, "turn-1");
});

test("completed item is authoritative over duplicate and out-of-order deltas", () => {
  const reducer = new AppServerReducer();
  reducer.rebuild(thread("t", [turn("turn-1", "inProgress")]));
  const started = {
    method: "item/started",
    emittedAtMs: 10,
    params: { threadId: "t", turnId: "turn-1", item: item("message-1") },
  };
  assert.equal(reducer.apply(started), true);
  assert.equal(reducer.apply(started), false);
  assert.equal(
    reducer.apply({
      method: "item/agentMessage/delta",
      emittedAtMs: 11,
      params: { threadId: "t", turnId: "turn-1", itemId: "message-1", delta: "partial" },
    }),
    true,
  );
  assert.equal(
    reducer.apply({
      method: "item/completed",
      emittedAtMs: 12,
      params: { threadId: "t", turnId: "turn-1", item: item("message-1", "agentMessage", { text: "final" }) },
    }),
    true,
  );
  assert.equal(
    reducer.apply({
      method: "item/agentMessage/delta",
      emittedAtMs: 11,
      params: { threadId: "t", turnId: "turn-1", itemId: "message-1", delta: "stale" },
    }),
    false,
  );
  const reduced = reducer.getTurn("t", "turn-1");
  assert.equal(reduced?.items[0]?.completed, true);
  assert.equal(reduced?.items[0]?.streamedText, "");
  assert.equal(reduced?.items[0]?.item.text, "final");
});

test("turn completion and latest aggregate diff become authoritative", () => {
  const reducer = new AppServerReducer();
  reducer.rebuild(thread("t", [turn("turn-1", "inProgress")]));
  reducer.apply({
    method: "turn/diff/updated",
    emittedAtMs: 20,
    params: { threadId: "t", turnId: "turn-1", diff: "latest diff" },
  });
  reducer.apply({
    method: "turn/completed",
    emittedAtMs: 30,
    params: { threadId: "t", turn: turn("turn-1", "completed") },
  });
  assert.equal(reducer.getTurn("t", "turn-1")?.completed, true);
  assert.equal(reducer.getTurn("t", "turn-1")?.aggregateDiff, "latest diff");
  assert.equal(
    reducer.apply({
      method: "turn/started",
      emittedAtMs: 15,
      params: { threadId: "t", turn: turn("turn-1", "inProgress") },
    }),
    false,
  );
});

test("status and name notifications update deterministic derived state", () => {
  const reducer = new AppServerReducer();
  reducer.rebuild(thread("t"));
  reducer.apply({
    method: "thread/status/changed",
    emittedAtMs: 1,
    params: { threadId: "t", status: { type: "active", activeFlags: ["waitingOnApproval"] } },
  });
  reducer.apply({ method: "thread/name/updated", emittedAtMs: 2, params: { threadId: "t", name: "Branch" } });
  assert.deepEqual(reducer.getThread("t")?.status, {
    type: "active",
    activeFlags: ["waitingOnApproval"],
  });
  assert.equal(reducer.getThread("t")?.name, "Branch");
});

test("subagent facts stay attached to parent activity instead of becoming tree state", () => {
  const reducer = new AppServerReducer();
  reducer.rebuild(
    thread("parent", [
      turn("turn-1", "completed", [
        item("collab-1", "collabAgentToolCall", {
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "parent",
          receiverThreadIds: ["agent-child"],
          prompt: "Inspect the adapter",
          agentsStates: { "agent-child": { status: "completed", message: "done" } },
        }),
      ]),
    ]),
  );
  const activities = reducer.getSubagentActivities("parent");
  assert.equal(activities.length, 1);
  assert.equal(activities[0]?.type, "collabAgentToolCall");
  assert.deepEqual(activities[0]?.receiverThreadIds, ["agent-child"]);
});
