import type { PeelState, Point, SpaceNode, SpaceRecord, ThreadViewState } from "./contracts";

const CARD_WIDTH = 294;
const CARD_HEIGHT = 205;
const CARD_GAP_X = 88;
const CARD_GAP_Y = 38;

export function emptyState(): PeelState {
  return {
    version: 1,
    activeSpaceId: null,
    activeThreadId: null,
    viewMode: "focus",
    spaces: {},
    threadViews: {},
  };
}

export function temporaryTitle(prompt: string, fallback = "New direction"): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.length > 34 ? `${normalized.slice(0, 33).trimEnd()}…` : normalized;
}

export function automaticTitle(prompt: string): string {
  const normalized = prompt
    .replace(/[\r\n]+/g, " ")
    .replace(/^[\s#>*\-\d.)]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "Untitled thread";
  const firstClause = normalized.split(/[。！？.!?;；]/, 1)[0]?.trim() || normalized;
  return firstClause.length > 28 ? `${firstClause.slice(0, 27).trimEnd()}…` : firstClause;
}

export function createSpace(thread: {
  id: string;
  name: string | null;
  preview: string;
  cwd: string;
  createdAt: number;
}): SpaceRecord {
  const title = thread.name?.trim() || temporaryTitle(thread.preview, "New Chat");
  const root: SpaceNode = {
    threadId: thread.id,
    parentThreadId: null,
    forkedAtTurnId: null,
    createdAt: thread.createdAt || Date.now(),
    position: { x: 0, y: 0 },
    title,
    titleOrigin: thread.name?.trim() ? "manual" : "temporary",
    cwd: thread.cwd,
    worktreeName: null,
    lastViewedTurnId: null,
  };
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: title,
    rootThreadId: thread.id,
    archived: false,
    createdAt: now,
    updatedAt: now,
    nodes: { [thread.id]: root },
    camera: { x: 0, y: 0, scale: 0.86 },
  };
}

export function threadView(state: PeelState, threadId: string): ThreadViewState {
  return state.threadViews[threadId] ?? { draft: "", scrollTop: 0 };
}

export function suggestedChildPosition(space: SpaceRecord, parentThreadId: string): Point {
  const parent = space.nodes[parentThreadId];
  if (!parent) return { x: 0, y: 0 };
  const nodes = Object.values(space.nodes);
  const rowOffsets = [0, 1, -1, 2, -2, 3, -3, 4];
  for (let column = 1; column <= nodes.length + 1; column += 1) {
    for (const row of rowOffsets) {
      const candidate = {
        x: parent.position.x + column * (CARD_WIDTH + CARD_GAP_X),
        y: parent.position.y + row * (CARD_HEIGHT + CARD_GAP_Y),
      };
      const overlaps = nodes.some((node) =>
        Math.abs(node.position.x - candidate.x) < CARD_WIDTH + CARD_GAP_X / 2
        && Math.abs(node.position.y - candidate.y) < CARD_HEIGHT + CARD_GAP_Y / 2);
      if (!overlaps) return candidate;
    }
  }
  return { x: parent.position.x + (nodes.length + 2) * (CARD_WIDTH + CARD_GAP_X), y: parent.position.y };
}

export function normalizeState(candidate: unknown): PeelState {
  if (!candidate || typeof candidate !== "object") return emptyState();
  const state = candidate as Partial<PeelState>;
  if (state.version !== 1 || !state.spaces || !state.threadViews) return emptyState();
  const spaces = Object.fromEntries(Object.entries(state.spaces).filter(([, space]) => validSpace(space)));
  const activeSpaceId = typeof state.activeSpaceId === "string" && spaces[state.activeSpaceId] ? state.activeSpaceId : null;
  const activeThreadId = activeSpaceId && typeof state.activeThreadId === "string" && spaces[activeSpaceId]!.nodes[state.activeThreadId]
    ? state.activeThreadId
    : activeSpaceId ? spaces[activeSpaceId]!.rootThreadId : null;
  const threadViews = Object.fromEntries(Object.entries(state.threadViews).filter((entry): entry is [string, ThreadViewState] => {
    const value = entry[1];
    return Boolean(value && typeof value.draft === "string" && Number.isFinite(value.scrollTop) && value.scrollTop >= 0);
  }));
  return {
    version: 1,
    activeSpaceId,
    activeThreadId,
    viewMode: state.viewMode === "overview" ? "overview" : "focus",
    spaces,
    threadViews,
  };
}

function validSpace(value: unknown): value is SpaceRecord {
  if (!value || typeof value !== "object") return false;
  const space = value as Partial<SpaceRecord>;
  if (typeof space.id !== "string" || typeof space.name !== "string" || typeof space.rootThreadId !== "string" || !space.nodes || !space.camera) return false;
  const nodes = space.nodes as Record<string, SpaceNode>;
  const root = nodes[space.rootThreadId];
  if (!root || root.threadId !== space.rootThreadId || root.parentThreadId !== null || root.forkedAtTurnId !== null) return false;
  if (![space.camera.x, space.camera.y, space.camera.scale].every(Number.isFinite) || space.camera.scale < .08 || space.camera.scale > 2) return false;
  for (const [threadId, node] of Object.entries(nodes)) {
    if (!node || node.threadId !== threadId || typeof node.title !== "string" || typeof node.cwd !== "string") return false;
    if (![node.position?.x, node.position?.y].every(Number.isFinite)) return false;
    if (threadId !== space.rootThreadId && (typeof node.parentThreadId !== "string" || typeof node.forkedAtTurnId !== "string" || !nodes[node.parentThreadId])) return false;
    const seen = new Set<string>();
    let cursor: SpaceNode | undefined = node;
    while (cursor.parentThreadId !== null) {
      if (seen.has(cursor.threadId)) return false;
      seen.add(cursor.threadId);
      cursor = nodes[cursor.parentThreadId];
      if (!cursor) return false;
    }
    if (cursor.threadId !== space.rootThreadId) return false;
  }
  return Object.values(nodes).filter((node) => node.parentThreadId === null).length === 1;
}
