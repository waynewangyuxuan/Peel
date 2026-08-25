import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { StateStore } from "../src/main/state-store";
import { createSpace, emptyState } from "../src/shared/state";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

describe("StateStore", () => {
  it("round-trips drafts, scroll, camera, and node positions with an atomic file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "peel-state-test-"));
    directories.push(directory);
    const store = new StateStore(directory);
    const state = emptyState();
    state.threadViews.thread = { draft: "do not lose this", scrollTop: 912 };
    await store.save(state);
    expect(await store.load()).toEqual(state);
    expect(JSON.parse(await readFile(store.path, "utf8"))).toEqual(state);
  });

  it("serializes overlapping saves so the last accepted state wins", async () => {
    const directory = await mkdtemp(join(tmpdir(), "peel-state-test-"));
    directories.push(directory);
    const store = new StateStore(directory);
    const first = emptyState();
    first.viewMode = "overview";
    const second = emptyState();
    second.threadViews.last = { draft: "last", scrollTop: 0 };
    await Promise.all([store.save(first), store.save(second)]);
    expect((await store.load()).threadViews.last?.draft).toBe("last");
  });

  it("serializes complete mutations and preserves service-owned nodes when a stale renderer save arrives", async () => {
    const directory = await mkdtemp(join(tmpdir(), "peel-state-test-"));
    directories.push(directory);
    const store = new StateStore(directory);
    const initial = emptyState();
    const space = createSpace({ id: "root", name: "Root", preview: "", cwd: "/repo", createdAt: 1 });
    initial.spaces[space.id] = space;
    initial.activeSpaceId = space.id;
    initial.activeThreadId = "root";
    await store.save(initial);
    const staleRenderer = structuredClone(initial);
    staleRenderer.threadViews.root = { draft: "new local draft", scrollTop: 40 };

    const addChild = store.mutate((state) => {
      state.spaces[space.id]!.nodes.child = {
        ...state.spaces[space.id]!.nodes.root!,
        threadId: "child",
        parentThreadId: "root",
        forkedAtTurnId: "turn-1",
        title: "Child",
      };
    });
    const renameRoot = store.mutate((state) => {
      state.spaces[space.id]!.nodes.root!.title = "Manual root";
      state.spaces[space.id]!.nodes.root!.titleOrigin = "manual";
    });
    const staleSave = store.save(staleRenderer);
    await Promise.all([addChild, renameRoot, staleSave]);

    const restored = await store.load();
    expect(restored.spaces[space.id]!.nodes.child?.parentThreadId).toBe("root");
    expect(restored.spaces[space.id]!.nodes.root).toMatchObject({ title: "Manual root", titleOrigin: "manual" });
    expect(restored.threadViews.root).toEqual({ draft: "new local draft", scrollTop: 40 });
  });
});
