import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { StateStore } from "../src/main/state-store";
import { emptyState } from "../src/shared/state";

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
});
