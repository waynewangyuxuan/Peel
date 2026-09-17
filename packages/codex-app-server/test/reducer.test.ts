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

test("reconstructs item-specific live streams without flattening reasoning sections", () => {
  const reducer = new AppServerReducer();
  reducer.rebuild(thread("t", [turn("turn-1", "inProgress")]));
  const items = [
    item("message-1", "agentMessage"),
    item("plan-1", "plan"),
    item("reasoning-1", "reasoning"),
    item("command-1", "commandExecution", { command: "printf raw", status: "inProgress" }),
    item("file-1", "fileChange", { status: "inProgress" }),
  ];
  items.forEach((startedItem, index) => assert.equal(reducer.apply({
    method: "item/started",
    emittedAtMs: index + 1,
    params: { threadId: "t", turnId: "turn-1", item: startedItem },
  }), true));

  const notifications = [
    ["item/agentMessage/delta", 10, { itemId: "message-1", delta: "Hello **world**" }],
    ["item/plan/delta", 11, { itemId: "plan-1", delta: "- Inspect\n- Fix" }],
    ["item/reasoning/summaryPartAdded", 12, { itemId: "reasoning-1", summaryIndex: 0 }],
    ["item/reasoning/summaryTextDelta", 13, { itemId: "reasoning-1", summaryIndex: 0, delta: "First " }],
    ["item/reasoning/summaryTextDelta", 14, { itemId: "reasoning-1", summaryIndex: 0, delta: "summary" }],
    ["item/reasoning/summaryPartAdded", 15, { itemId: "reasoning-1", summaryIndex: 1 }],
    ["item/reasoning/summaryTextDelta", 16, { itemId: "reasoning-1", summaryIndex: 1, delta: "Second summary" }],
    ["item/reasoning/textDelta", 17, { itemId: "reasoning-1", contentIndex: 0, delta: "raw-a" }],
    ["item/reasoning/textDelta", 18, { itemId: "reasoning-1", contentIndex: 1, delta: "raw-b" }],
    ["item/commandExecution/outputDelta", 19, { itemId: "command-1", delta: "**not markdown**\n" }],
    ["item/commandExecution/outputDelta", 20, { itemId: "command-1", delta: "done" }],
    ["item/fileChange/outputDelta", 21, { itemId: "file-1", delta: "legacy patch output" }],
  ] as const;
  for (const [method, emittedAtMs, itemParams] of notifications) {
    assert.equal(reducer.apply({
      method,
      emittedAtMs,
      params: { threadId: "t", turnId: "turn-1", ...itemParams },
    }), true, method);
  }

  const reduced = reducer.getTurn("t", "turn-1");
  const byId = new Map(reduced?.items.map((reducedItem) => [reducedItem.item.id, reducedItem]));
  assert.equal(byId.get("message-1")?.streamedText, "Hello **world**");
  assert.equal(byId.get("plan-1")?.streamedText, "- Inspect\n- Fix");
  assert.deepEqual(byId.get("reasoning-1")?.streamedReasoningSummarySections, ["First summary", "Second summary"]);
  assert.equal(byId.get("reasoning-1")?.streamedText, "First summary\n\nSecond summary");
  assert.equal(byId.get("reasoning-1")?.streamedReasoningContent, "raw-a\n\nraw-b");
  assert.equal(byId.get("command-1")?.streamedText, "**not markdown**\ndone");
  assert.equal(byId.get("file-1")?.streamedText, "legacy patch output");
});

test("rejects mismatched, stale, duplicate, and post-completion item deltas", () => {
  const reducer = new AppServerReducer();
  reducer.rebuild(thread("t", [turn("turn-1", "inProgress")]));
  reducer.apply({
    method: "item/started",
    emittedAtMs: 10,
    params: { threadId: "t", turnId: "turn-1", item: item("command-1", "commandExecution") },
  });
  assert.equal(reducer.apply({
    method: "item/agentMessage/delta",
    emittedAtMs: 11,
    params: { threadId: "t", turnId: "turn-1", itemId: "command-1", delta: "wrong channel" },
  }), false);
  const valid = {
    method: "item/commandExecution/outputDelta",
    emittedAtMs: 12,
    params: { threadId: "t", turnId: "turn-1", itemId: "command-1", delta: "one" },
  };
  assert.equal(reducer.apply(valid), true);
  assert.equal(reducer.apply(valid), false);
  assert.equal(reducer.apply({ ...valid, emittedAtMs: 11, params: { ...valid.params, delta: "stale" } }), false);
  assert.equal(reducer.apply({
    method: "item/completed",
    emittedAtMs: 13,
    params: {
      threadId: "t",
      turnId: "turn-1",
      item: item("command-1", "commandExecution", { command: "printf final", aggregatedOutput: "final", status: "completed" }),
    },
  }), true);
  assert.equal(reducer.apply({ ...valid, emittedAtMs: 14, params: { ...valid.params, delta: "too late" } }), false);

  const reduced = reducer.getTurn("t", "turn-1")?.items[0];
  assert.equal(reduced?.completed, true);
  assert.equal(reduced?.streamedText, "");
  assert.equal(reduced?.streamedReasoningContent, "");
  assert.deepEqual(reduced?.streamedReasoningSummarySections, []);
  assert.equal(reduced?.item.aggregatedOutput, "final");
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

test("interrupted and failed turn snapshots replace provisional item streams", () => {
  for (const status of ["interrupted", "failed"] as const) {
    const reducer = new AppServerReducer();
    reducer.rebuild(thread("t", [turn("turn-1", "inProgress")]));
    reducer.apply({
      method: "item/started",
      emittedAtMs: 1,
      params: { threadId: "t", turnId: "turn-1", item: item("message-1") },
    });
    reducer.apply({
      method: "item/agentMessage/delta",
      emittedAtMs: 2,
      params: { threadId: "t", turnId: "turn-1", itemId: "message-1", delta: "provisional" },
    });
    reducer.apply({
      method: "turn/completed",
      emittedAtMs: 3,
      params: {
        threadId: "t",
        turn: turn("turn-1", status, [item("message-1", "agentMessage", { text: `${status} final` })]),
      },
    });
    const reduced = reducer.getTurn("t", "turn-1");
    assert.equal(reduced?.completed, true);
    assert.equal(reduced?.turn.status, status);
    assert.equal(reduced?.items[0]?.streamedText, "");
    assert.equal(reduced?.items[0]?.item.text, `${status} final`);
  }
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
