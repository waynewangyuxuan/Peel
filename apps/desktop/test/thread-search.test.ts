import type { CodexThread, ThreadListResponse } from "@peel/codex-app-server";
import { describe, expect, it } from "vitest";

import { mergeThreadPage, threadMatches } from "../src/renderer/thread-search";

function thread(id: string, name = id): CodexThread {
  return { id, name, preview: `${name} preview`, cwd: `/repo/${id}`, createdAt: 1, updatedAt: 1, status: { type: "idle" }, turns: [] } as unknown as CodexThread;
}

function page(data: CodexThread[], nextCursor: string | null, backwardsCursor: string | null = null): ThreadListResponse {
  return { data, nextCursor, backwardsCursor };
}

describe("Thread Picker result helpers", () => {
  it("filters the warm page across title, preview, and cwd without case sensitivity", () => {
    expect(threadMatches(thread("one", "Spatial Map"), "spatial")).toBe(true);
    expect(threadMatches(thread("two", "Other"), "PREVIEW")).toBe(true);
    expect(threadMatches(thread("needle"), "/repo/needle")).toBe(true);
    expect(threadMatches(thread("other"), "missing")).toBe(false);
  });

  it("appends cursor pages without duplicating a repeated boundary Thread", () => {
    const first = page([thread("one"), thread("two", "stale")], "cursor-2", "back-0");
    const second = page([thread("two", "fresh"), thread("three")], "cursor-3", "back-1");
    expect(mergeThreadPage(first, second)).toEqual(page([
      thread("one"),
      thread("two", "fresh"),
      thread("three"),
    ], "cursor-3", "back-0"));
  });
});
