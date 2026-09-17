import type { CodexThread, ThreadListResponse } from "@peel/codex-app-server";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PeelService } from "../src/main/peel-service";
import { automaticTitle, temporaryTitle } from "../src/shared/state";

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
    const list = vi.spyOn(service.client, "listThreads").mockResolvedValue(noThreads());
    const thread = emptyThread("fresh-thread", "/repo/current");
    const start = vi.spyOn(service.client, "startThread").mockResolvedValue({ thread } as never);
    service.transport.emit("ready", {});
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    const state = await service.startNewChat({ cwd: "/repo/current" });

    expect(start).toHaveBeenCalledWith({ cwd: "/repo/current" });
    expect(list).toHaveBeenCalledTimes(1);
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
    vi.spyOn(service.client, "listThreads").mockResolvedValue(noThreads());
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

  it("moves a default Space through temporary, automatic, and manual Root titles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "peel-new-chat-title-test-"));
    directories.push(directory);
    const service = new PeelService(directory);
    const thread = emptyThread("fresh-title-thread", "/repo/current");
    vi.spyOn(service.client, "listThreads").mockResolvedValue(noThreads());
    vi.spyOn(service.client, "startThread").mockResolvedValue({ thread } as never);
    vi.spyOn(service.client, "startTurn").mockResolvedValue("turn-first");
    const setThreadName = vi.spyOn(service.client, "setThreadName").mockResolvedValue(undefined);
    service.transport.emit("ready", {});
    const created = await service.startNewChat({ cwd: thread.cwd });
    const spaceId = created.activeSpaceId!;
    const prompt = "Plan resilient sidebar titles carefully. Then verify restart.";

    await service.sendTurn({ threadId: thread.id, cwd: thread.cwd, input: [{ type: "text", text: prompt, text_elements: [] }] });
    let stored = (await service.bootstrap()).state.spaces[spaceId]!;
    expect(stored.nodes[thread.id]).toMatchObject({ title: temporaryTitle(prompt, "New Chat"), titleOrigin: "temporary" });
    expect(stored).toMatchObject({ name: temporaryTitle(prompt, "New Chat"), nameOrigin: "default" });

    service.client.emit("notification", { method: "turn/completed", params: { threadId: thread.id, turn: { id: "turn-first" } } } as never);
    await vi.waitFor(async () => {
      stored = (await service.bootstrap()).state.spaces[spaceId]!;
      expect(stored.nodes[thread.id]).toMatchObject({ title: automaticTitle(prompt), titleOrigin: "automatic" });
      expect(stored.name).toBe(automaticTitle(prompt));
    });
    expect(setThreadName).toHaveBeenCalledWith(thread.id, automaticTitle(prompt));

    await service.setThreadName(thread.id, "Manual Root title", spaceId);
    stored = (await service.bootstrap()).state.spaces[spaceId]!;
    expect(stored.nodes[thread.id]).toMatchObject({ title: "Manual Root title", titleOrigin: "manual" });
    expect(stored).toMatchObject({ name: "Manual Root title", nameOrigin: "default" });
  });

  it("never lets later Root naming overwrite a manually renamed Space", async () => {
    const directory = await mkdtemp(join(tmpdir(), "peel-manual-space-title-test-"));
    directories.push(directory);
    const service = new PeelService(directory);
    const thread = emptyThread("protected-title-thread", "/repo/current");
    vi.spyOn(service.client, "listThreads").mockResolvedValue(noThreads());
    vi.spyOn(service.client, "startThread").mockResolvedValue({ thread } as never);
    vi.spyOn(service.client, "startTurn").mockResolvedValue("turn-protected");
    vi.spyOn(service.client, "setThreadName").mockResolvedValue(undefined);
    service.transport.emit("ready", {});
    const created = await service.startNewChat({ cwd: thread.cwd });
    const spaceId = created.activeSpaceId!;
    const protectedState = structuredClone(created);
    protectedState.spaces[spaceId]!.name = "My protected Space";
    protectedState.spaces[spaceId]!.nameOrigin = "manual";
    await service.saveState(protectedState);
    const prompt = "Generate an automatic Root title. Keep the Space name.";

    await service.sendTurn({ threadId: thread.id, cwd: thread.cwd, input: [{ type: "text", text: prompt, text_elements: [] }] });
    expect((await service.bootstrap()).state.spaces[spaceId]).toMatchObject({ name: "My protected Space", nameOrigin: "manual" });
    service.client.emit("notification", { method: "turn/completed", params: { threadId: thread.id, turn: { id: "turn-protected" } } } as never);
    await vi.waitFor(async () => {
      const stored = (await service.bootstrap()).state.spaces[spaceId]!;
      expect(stored.nodes[thread.id]?.titleOrigin).toBe("automatic");
      expect(stored.name).toBe("My protected Space");
    });

    await service.setThreadName(thread.id, "Later manual Root title", spaceId);
    expect((await service.bootstrap()).state.spaces[spaceId]).toMatchObject({ name: "My protected Space", nameOrigin: "manual" });
  });
});
