import type { AppServerNotification, CodexThread, CodexTurn, ReducedThread, ThreadItem } from "@peel/codex-app-server";
import { describe, expect, it } from "vitest";

import type { ThreadSnapshot } from "../src/shared/contracts";
import { turnViewPropsEqual } from "../src/renderer/Transcript";
import { reconcileThreadSnapshot } from "../src/renderer/thread-snapshot";

describe("renderer Thread snapshot reconciliation", () => {
  it("keeps settled Turns and Items stable while replacing only the live delta target", () => {
    const previous = snapshot();
    const incoming = structuredClone(previous);
    incoming.reduced!.turns[1]!.items[1]!.streamedText = "next token";
    const notification = {
      method: "item/agentMessage/delta",
      params: { threadId: "thread", turnId: "live", itemId: "live-agent", delta: "next token" },
    } as AppServerNotification;

    const reconciled = reconcileThreadSnapshot(previous, incoming, notification);

    expect(reconciled.thread.turns[0]).toBe(previous.thread.turns[0]);
    expect(reconciled.reduced!.turns[0]).toBe(previous.reduced!.turns[0]);
    expect(reconciled.thread.turns[1]).not.toBe(previous.thread.turns[1]);
    expect(reconciled.reduced!.turns[1]).not.toBe(previous.reduced!.turns[1]);
    expect(reconciled.reduced!.turns[1]!.items[0]).toBe(previous.reduced!.turns[1]!.items[0]);
    expect(reconciled.reduced!.turns[1]!.items[1]).not.toBe(previous.reduced!.turns[1]!.items[1]);
    expect(reconciled.reduced!.turns[1]!.items[1]!.streamedText).toBe("next token");
  });

  it("updates Thread metadata without invalidating any Turn", () => {
    const previous = snapshot();
    const incoming = structuredClone(previous);
    incoming.thread.name = "Renamed";
    incoming.reduced!.name = "Renamed";
    const notification = {
      method: "thread/name/updated",
      params: { threadId: "thread", name: "Renamed" },
    } as AppServerNotification;

    const reconciled = reconcileThreadSnapshot(previous, incoming, notification);

    expect(reconciled.thread.name).toBe("Renamed");
    expect(reconciled.thread.turns[0]).toBe(previous.thread.turns[0]);
    expect(reconciled.thread.turns[1]).toBe(previous.thread.turns[1]);
    expect(reconciled.reduced!.turns[0]).toBe(previous.reduced!.turns[0]);
    expect(reconciled.reduced!.turns[1]).toBe(previous.reduced!.turns[1]);
  });

  it("compares authoritative read refreshes so missed changes cannot stay stale", () => {
    const previous = snapshot();
    const incoming = structuredClone(previous);
    incoming.thread.turns[0]!.items[1]!.text = "refreshed answer";
    incoming.reduced!.turns[0]!.turn.items[1]!.text = "refreshed answer";
    incoming.reduced!.turns[0]!.items[1]!.item.text = "refreshed answer";

    const reconciled = reconcileThreadSnapshot(previous, incoming, null);

    expect(reconciled.thread.turns[0]).not.toBe(previous.thread.turns[0]);
    expect(reconciled.thread.turns[0]!.items[0]).toBe(previous.thread.turns[0]!.items[0]);
    expect(reconciled.thread.turns[0]!.items[1]).not.toBe(previous.thread.turns[0]!.items[1]);
    expect(reconciled.thread.turns[0]!.items[1]!.text).toBe("refreshed answer");
    expect(reconciled.thread.turns[1]).toBe(previous.thread.turns[1]);
  });

  it("retains the full-snapshot path as an explicit benchmark baseline", () => {
    const previous = snapshot();
    const incoming = structuredClone(previous);
    expect(reconcileThreadSnapshot(previous, incoming, null, "baseline")).toBe(incoming);
  });

  it("invalidates only a Turn whose request or notice payload actually changed", () => {
    const current = snapshot();
    const base = {
      turn: current.thread.turns[0]!,
      reduced: current.reduced!.turns[0]!,
      highlighted: false,
      requests: [{ id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: "settled", command: "npm test" } }],
      notices: [{ id: "notice", kind: "warning", threadId: "thread", turnId: "settled", message: "Review", willRetry: false, createdAt: 1 }],
      onBranch: () => undefined,
      onOpenCodex: () => undefined,
      onRequestResponse: async () => undefined,
    } as Parameters<typeof turnViewPropsEqual>[0];
    const equivalent = {
      ...base,
      requests: structuredClone(base.requests),
      notices: structuredClone(base.notices),
    };
    expect(turnViewPropsEqual(base, equivalent)).toBe(true);
    expect(turnViewPropsEqual(base, {
      ...equivalent,
      notices: [{ ...equivalent.notices[0]!, message: "Latest payload" }],
    })).toBe(false);
    expect(turnViewPropsEqual(base, {
      ...equivalent,
      requests: [{ ...equivalent.requests[0]!, params: { ...equivalent.requests[0]!.params, command: "npm run build" } }],
    })).toBe(false);
  });
});

function snapshot(): ThreadSnapshot {
  const settled = turn("settled", "completed", "Settled answer");
  const live = turn("live", "inProgress", "");
  const thread = {
    id: "thread",
    name: "Thread",
    cwd: "/tmp/project",
    status: { type: "active", activeFlags: [] },
    turns: [settled, live],
  } as unknown as CodexThread;
  const reduced = {
    thread,
    name: thread.name,
    status: thread.status,
    turns: thread.turns.map((value) => ({
      turn: value,
      completed: value.status !== "inProgress",
      aggregateDiff: "",
      items: value.items.map((entry) => ({
        item: entry,
        completed: value.status !== "inProgress" || entry.type === "userMessage",
        streamedText: "",
        streamedReasoningContent: "",
        streamedReasoningSummarySections: [],
      })),
    })),
  } as ReducedThread;
  return { thread, reduced };
}

function turn(id: string, status: CodexTurn["status"], answer: string): CodexTurn {
  return {
    id,
    status,
    error: null,
    items: [
      { id: `${id}-user`, type: "userMessage", text: `Prompt ${id}` } as unknown as ThreadItem,
      { id: `${id}-agent`, type: "agentMessage", text: answer } as unknown as ThreadItem,
    ],
  } as unknown as CodexTurn;
}
