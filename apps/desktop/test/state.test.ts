import { describe, expect, it } from "vitest";

import { automaticTitle, createSpace, emptyState, normalizeState, suggestedChildPosition, temporaryTitle } from "../src/shared/state";

describe("Peel state model", () => {
  it("creates exactly one root from an existing Thread without Project coupling", () => {
    const space = createSpace({
      id: "thread-root",
      name: null,
      preview: "Explore the spatial model",
      cwd: "/tmp/repo",
      createdAt: 100,
    });
    expect(space.rootThreadId).toBe("thread-root");
    expect(space.nameOrigin).toBe("default");
    expect(Object.keys(space.nodes)).toEqual(["thread-root"]);
    expect(space.nodes["thread-root"]).toMatchObject({ parentThreadId: null, forkedAtTurnId: null });
    expect(space).not.toHaveProperty("projectId");
  });

  it("preserves old node positions when allocating many children", () => {
    const space = createSpace({ id: "root", name: "Root", preview: "", cwd: "/repo", createdAt: 1 });
    const rootBefore = structuredClone(space.nodes.root!.position);
    for (let index = 0; index < 50; index += 1) {
      const id = `child-${index}`;
      space.nodes[id] = {
        threadId: id,
        parentThreadId: "root",
        forkedAtTurnId: `turn-${index}`,
        createdAt: index + 2,
        position: suggestedChildPosition(space, "root"),
        title: id,
        titleOrigin: "automatic",
        cwd: "/repo",
        worktreeName: null,
        lastViewedTurnId: null,
      };
    }
    expect(space.nodes.root!.position).toEqual(rootBefore);
    expect(new Set(Object.values(space.nodes).map((node) => `${node.position.x}:${node.position.y}`)).size).toBe(51);
    const nodes = Object.values(space.nodes);
    for (const node of nodes) {
      for (const other of nodes) {
        if (node.threadId === other.threadId) continue;
        expect(Math.abs(node.position.x - other.position.x) >= 294 || Math.abs(node.position.y - other.position.y) >= 205).toBe(true);
      }
    }
    expect(Math.max(...nodes.map((node) => node.position.x)) - Math.min(...nodes.map((node) => node.position.x))).toBeLessThan(3_000);
    expect(Math.max(...nodes.map((node) => node.position.y)) - Math.min(...nodes.map((node) => node.position.y))).toBeLessThan(2_000);
  });

  it("uses deterministic temporary and automatic titles", () => {
    expect(temporaryTitle("  A   very long prompt that needs a compact title for navigation  ")).toBe("A very long prompt that needs a c…");
    expect(automaticTitle("## Build the Focus view. Then validate it")).toBe("Build the Focus view");
  });

  it("rejects unrelated persisted shapes instead of partially trusting them", () => {
    expect(normalizeState({ version: 2, spaces: {}, threadViews: {} })).toEqual(emptyState());
  });

  it("preserves valid Turn scroll anchors and drops malformed anchors", () => {
    const state = emptyState();
    state.threadViews.valid = { draft: "kept", scrollTop: 912, scrollAnchor: { turnId: "turn-211", offset: -24.5 } };
    state.threadViews.invalid = { draft: "still kept", scrollTop: 24, scrollAnchor: { turnId: "turn-2", offset: Number.NaN } };

    const normalized = normalizeState(state);

    expect(normalized.threadViews.valid).toEqual({
      draft: "kept",
      scrollTop: 912,
      scrollAnchor: { turnId: "turn-211", offset: -24.5 },
    });
    expect(normalized.threadViews.invalid).toEqual({ draft: "still kept", scrollTop: 24 });
  });

  it("repairs only legacy New Chat names and preserves every other legacy Space label", () => {
    const following = createSpace({ id: "following-root", name: null, preview: "", cwd: "/repo", createdAt: 1 });
    following.name = "New Chat";
    following.nodes[following.rootThreadId]!.title = "Useful recovered root title";
    delete (following as { nameOrigin?: unknown }).nameOrigin;
    const preserved = createSpace({ id: "preserved-root", name: null, preview: "", cwd: "/repo", createdAt: 2 });
    preserved.name = "My deliberate legacy label";
    preserved.nodes[preserved.rootThreadId]!.title = "A newer Root title";
    delete (preserved as { nameOrigin?: unknown }).nameOrigin;
    const state = emptyState();
    state.spaces[following.id] = following;
    state.spaces[preserved.id] = preserved;

    const normalized = normalizeState(state);

    expect(normalized.spaces[following.id]).toMatchObject({ name: "Useful recovered root title", nameOrigin: "default" });
    expect(normalized.spaces[preserved.id]).toMatchObject({ name: "My deliberate legacy label", nameOrigin: "manual" });
  });

  it("drops a persisted Forest or cycle instead of weakening the single-root Fork invariant", () => {
    const space = createSpace({ id: "root", name: "Root", preview: "", cwd: "/repo", createdAt: 1 });
    space.nodes.unrelated = { ...space.nodes.root!, threadId: "unrelated" };
    const state = emptyState();
    state.spaces[space.id] = space;
    state.activeSpaceId = space.id;
    expect(normalizeState(state).spaces).toEqual({});

    space.nodes.unrelated = { ...space.nodes.root!, threadId: "unrelated", parentThreadId: "unrelated", forkedAtTurnId: "turn" };
    expect(normalizeState(state).spaces).toEqual({});
  });
});
