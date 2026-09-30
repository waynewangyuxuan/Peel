import { describe, expect, it, vi } from "vitest";

import { OPEN_CODEX_FAILURE, openCodexInDesktop } from "../src/renderer/open-codex";

describe("openCodexInDesktop", () => {
  it("dispatches the current thread and keeps successful navigation quiet", async () => {
    const openTarget = vi.fn(async () => undefined);
    const result = await openCodexInDesktop(openTarget, {
      cwd: "/workspace",
      threadId: "a3d8be2d-7fb5-4f7b-9c31-9d8f517f248a",
    });

    expect(openTarget).toHaveBeenCalledWith({
      kind: "codex",
      cwd: "/workspace",
      threadId: "a3d8be2d-7fb5-4f7b-9c31-9d8f517f248a",
    });
    expect(result).toBeNull();
  });

  it("returns accessible feedback when the IPC dispatch is rejected", async () => {
    const openTarget = vi.fn(async () => { throw new Error("Error invoking remote method 'peel:open'"); });
    await expect(openCodexInDesktop(openTarget, {
      cwd: "/workspace",
      threadId: "a3d8be2d-7fb5-4f7b-9c31-9d8f517f248a",
    })).resolves.toBe(OPEN_CODEX_FAILURE);
  });
});
