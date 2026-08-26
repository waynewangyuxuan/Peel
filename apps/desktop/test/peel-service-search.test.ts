import type { CodexThread, ThreadListResponse } from "@peel/codex-app-server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PeelService } from "../src/main/peel-service";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

function page(id: string, nextCursor: string | null = null): ThreadListResponse {
  return {
    data: [{
      id,
      name: id,
      preview: id,
      cwd: "/repo",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      turns: [],
    } as unknown as CodexThread],
    nextCursor,
    backwardsCursor: null,
  };
}

describe("PeelService Thread discovery cache", () => {
  it("warms without blocking, shares in-flight work, honors the exact TTL, and forwards cursors in 30-item pages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "peel-search-test-"));
    directories.push(directory);
    let now = 0;
    const service = new PeelService(directory, { now: () => now });
    let resolveWarm!: (response: ThreadListResponse) => void;
    const warmResponse = new Promise<ThreadListResponse>((resolve) => { resolveWarm = resolve; });
    const search = vi.spyOn(service.client, "searchThreads")
      .mockImplementationOnce(async () => await warmResponse)
      .mockResolvedValue(page("fresh"));

    service.transport.emit("ready", {});
    expect(search).toHaveBeenCalledTimes(1);
    const first = service.searchThreads({ term: "" });
    const concurrent = service.searchThreads({ term: "" });
    expect(search).toHaveBeenCalledTimes(1);
    resolveWarm(page("warm", "cursor-1"));
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      page("warm", "cursor-1"),
      page("warm", "cursor-1"),
    ]);

    now = 14_999;
    await expect(service.searchThreads({ term: "" })).resolves.toEqual(page("warm", "cursor-1"));
    expect(search).toHaveBeenCalledTimes(1);

    now = 15_000;
    await expect(service.searchThreads({ term: "" })).resolves.toEqual(page("fresh"));
    expect(search).toHaveBeenCalledTimes(2);

    await service.searchThreads({ term: "  Needle  ", cursor: "cursor-1" });
    expect(search).toHaveBeenLastCalledWith("Needle", {
      cursor: "cursor-1",
      limit: 30,
      sortKey: "updated_at",
      sortDirection: "desc",
    });
  });
});
