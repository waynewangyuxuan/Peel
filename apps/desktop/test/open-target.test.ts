import { describe, expect, it, vi } from "vitest";

import { codexThreadDeepLink, openTarget, type OpenTargetDependencies } from "../src/main/open-target";

function dependencies(overrides: Partial<OpenTargetDependencies> = {}): OpenTargetDependencies {
  return {
    exists: vi.fn(() => false),
    openExternal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => ""),
    ...overrides,
  };
}

describe("openTarget", () => {
  it("opens the exact Codex conversation through the registered desktop protocol", async () => {
    const deps = dependencies();
    const threadId = "A3D8BE2D-7FB5-4F7B-9C31-9D8F517F248A";

    await openTarget({ kind: "codex", cwd: "/workspace", threadId }, deps);

    expect(deps.openExternal).toHaveBeenCalledOnce();
    expect(deps.openExternal).toHaveBeenCalledWith(`codex://threads/${threadId}`);
    expect(deps.openPath).not.toHaveBeenCalled();
  });

  it("rejects missing and malformed thread IDs before dispatch", async () => {
    const deps = dependencies();
    expect(() => codexThreadDeepLink("thread/with?unsafe=parts")).toThrow("invalid Thread ID");
    await expect(openTarget({ kind: "codex", cwd: "/workspace" }, deps)).rejects.toThrow("invalid Thread ID");
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it("turns an unavailable protocol handler into a recoverable error", async () => {
    const deps = dependencies({ openExternal: vi.fn(async () => { throw new Error("No handler"); }) });

    await expect(openTarget({
      kind: "codex",
      cwd: "/workspace",
      threadId: "a3d8be2d-7fb5-4f7b-9c31-9d8f517f248a",
    }, deps)).rejects.toThrow("Make sure the desktop app is installed");
  });

  it("preserves file, editor, and worktree path dispatch", async () => {
    const openPath = vi.fn(async () => "");
    const deps = dependencies({
      exists: vi.fn((path) => path === "/workspace/file.ts"),
      openPath,
    });

    await openTarget({ kind: "editor", cwd: "/workspace", path: "/workspace/file.ts" }, deps);
    await openTarget({ kind: "worktree", cwd: "/workspace", path: "/missing" }, deps);

    expect(openPath).toHaveBeenNthCalledWith(1, "/workspace/file.ts");
    expect(openPath).toHaveBeenNthCalledWith(2, "/workspace");
    expect(deps.openExternal).not.toHaveBeenCalled();
  });
});
