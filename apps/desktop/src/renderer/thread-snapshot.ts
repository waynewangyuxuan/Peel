import type { AppServerNotification, CodexTurn, ReducedItem, ReducedTurn } from "@peel/codex-app-server";

import type { ThreadSnapshot } from "../shared/contracts";

export type TranscriptSnapshotMode = "optimized" | "baseline";

interface SnapshotChange {
  known: boolean;
  turnId: string | null;
  itemId: string | null;
}

/**
 * IPC necessarily gives the renderer a fresh object graph for every App Server
 * notification. Reconcile that graph at the renderer boundary so React can use
 * referential identity as the invalidation contract for settled transcript rows.
 */
export function reconcileThreadSnapshot(
  previous: ThreadSnapshot | undefined,
  incoming: ThreadSnapshot,
  notification: AppServerNotification | null,
  mode: TranscriptSnapshotMode = "optimized",
): ThreadSnapshot {
  if (mode === "baseline" || !previous || previous.thread.id !== incoming.thread.id) return incoming;

  const change = snapshotChange(notification);
  const previousTurns = new Map(previous.thread.turns.map((turn) => [turn.id, turn]));
  const turns = incoming.thread.turns.map((turn) => {
    const prior = previousTurns.get(turn.id);
    if (!prior) return turn;
    if (change.known && change.turnId !== turn.id) return prior;
    if (!change.known && structurallyEqual(prior, turn)) return prior;
    return reconcileTurn(prior, turn, change);
  });
  const thread = { ...incoming.thread, turns };

  if (!incoming.reduced) return { ...incoming, thread, reduced: null };
  if (!previous.reduced) return { ...incoming, thread, reduced: { ...incoming.reduced, thread } };

  const rawTurns = new Map(turns.map((turn) => [turn.id, turn]));
  const previousReducedTurns = new Map(previous.reduced.turns.map((turn) => [turn.turn.id, turn]));
  const reducedTurns = incoming.reduced.turns.map((turn) => {
    const prior = previousReducedTurns.get(turn.turn.id);
    const rawTurn = rawTurns.get(turn.turn.id) ?? turn.turn;
    if (!prior) return { ...turn, turn: rawTurn };
    if (change.known && change.turnId !== turn.turn.id) return prior;
    if (!change.known && structurallyEqual(prior, turn)) return prior;
    return reconcileReducedTurn(prior, turn, rawTurn, change);
  });

  return {
    ...incoming,
    thread,
    reduced: {
      ...incoming.reduced,
      thread,
      turns: reducedTurns,
    },
  };
}

function reconcileTurn(previous: CodexTurn, incoming: CodexTurn, change: SnapshotChange): CodexTurn {
  const previousItems = new Map(previous.items.map((item) => [item.id, item]));
  const items = incoming.items.map((item) => {
    const prior = previousItems.get(item.id);
    if (!prior) return item;
    if (change.itemId === item.id) return item;
    return structurallyEqual(prior, item) ? prior : item;
  });
  return { ...incoming, items };
}

function reconcileReducedTurn(
  previous: ReducedTurn,
  incoming: ReducedTurn,
  rawTurn: CodexTurn,
  change: SnapshotChange,
): ReducedTurn {
  const previousItems = new Map(previous.items.map((item) => [item.item.id, item]));
  const items = incoming.items.map((item) => {
    const prior = previousItems.get(item.item.id);
    if (!prior) return item;
    if (change.itemId === item.item.id) return item;
    return structurallyEqual(prior, item) ? prior : item;
  });
  return { ...incoming, turn: rawTurn, items };
}

function snapshotChange(notification: AppServerNotification | null): SnapshotChange {
  if (!notification) return { known: false, turnId: null, itemId: null };
  const params = notification.params as Record<string, unknown>;
  const turn = recordOf(params.turn);
  const item = recordOf(params.item);
  return {
    known: true,
    turnId: typeof params.turnId === "string" ? params.turnId : typeof turn.id === "string" ? turn.id : null,
    itemId: typeof params.itemId === "string" ? params.itemId : typeof item.id === "string" ? item.id : null,
  };
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function structurallyEqual(left: CodexTurn | ReducedTurn | ReducedItem | object, right: CodexTurn | ReducedTurn | ReducedItem | object): boolean {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
