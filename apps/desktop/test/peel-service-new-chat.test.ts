import type { CodexThread, ThreadListResponse } from "@peel/codex-app-server";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PeelService } from "../src/main/peel-service";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

function emptyThread(id: string, cwd: string): CodexThread {
  return {
    id,
    sessionId: `session-${id}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    projectId: null,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: "idle" },
    path: null,
    cwd,
    cliVersion: "test",
    source: "test",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
  };
}

function noThreads(): ThreadListResponse {
  return { data: [], nextCursor: null, backwardsCursor: null };
}

describe("PeelService new Chat entry", () => {
  it("starts and persists a real empty Thread directly without another discovery request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "peel-new-chat-test-"));
    directories.push(directory);
    const service = new PeelService(directory);
    const search = vi.spyOn(service.client, "searchThreads").mockResolvedValue(noThreads());
    const thread = emptyThread("fresh-thread", "/repo/current");
    const start = vi.spyOn(service.client, "startThread").mockResolvedValue({ thread } as never);
    service.transport.emit("ready", {});
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));

    const state = await service.startNewChat({ cwd: "/repo/current" });

    expect(start).toHaveBeenCalledWith({ cwd: "/repo/current" });
    expect(search).toHaveBeenCalledTimes(1);
    expect(state.activeThreadId).toBe(thread.id);
    expect(state.activeSpaceId).not.toBeNull();
    const space = state.spaces[state.activeSpaceId!]!;
    expect(space.name).toBe("New Chat");
    expect(space.rootThreadId).toBe(thread.id);
    expect(Object.keys(space.nodes)).toEqual([thread.id]);
  });

  it("removes the remote empty Thread and leaves Peel unchanged when persistence fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "peel-new-chat-failure-test-"));
    directories.push(directory);
    const marker = join(directory, "fail-persist");
    const service = new PeelService(directory, { stateFailureMarker: marker });
    vi.spyOn(service.client, "searchThreads").mockResolvedValue(noThreads());
    const thread = emptyThread("failed-fresh-thread", "/repo/current");
    vi.spyOn(service.client, "startThread").mockResolvedValue({ thread } as never);
    const remove = vi.spyOn(service.client, "deleteThread").mockResolvedValue(undefined);
    service.transport.emit("ready", {});
    await writeFile(marker, "1");

    await expect(service.startNewChat({ cwd: "/repo/current" })).rejects.toThrow("nothing was added");
    expect(remove).toHaveBeenCalledWith(thread.id);
    const state = await service.bootstrap();
    expect(state.state.activeSpaceId).toBeNull();
    expect(state.state.spaces).toEqual({});
  });
});
