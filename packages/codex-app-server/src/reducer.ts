import type { AppServerNotification, CodexThread, CodexTurn, ThreadItem, ThreadStatus } from "./protocol.js";

interface ItemState {
  item: ThreadItem;
  completed: boolean;
  textDeltas: string[];
  reasoningSummarySections: Map<number, string[]>;
  reasoningContentSections: Map<number, string[]>;
  commandOutputDeltas: string[];
  legacyFileChangeOutputDeltas: string[];
  lastEmittedAtMs: number;
}

interface TurnState {
  turn: CodexTurn;
  completed: boolean;
  items: Map<string, ItemState>;
  aggregateDiff: string;
  lastEmittedAtMs: number;
}

interface ThreadState {
  thread: CodexThread;
  turns: Map<string, TurnState>;
  status: ThreadStatus;
  name: string | null;
  lastEmittedByEntity: Map<string, number>;
  fingerprints: Set<string>;
}

export interface ReducedItem {
  item: ThreadItem;
  completed: boolean;
  streamedText: string;
  streamedReasoningContent: string;
  streamedReasoningSummarySections: string[];
}

export interface ReducedTurn {
  turn: CodexTurn;
  completed: boolean;
  items: ReducedItem[];
  aggregateDiff: string;
}

export interface ReducedThread {
  thread: CodexThread;
  status: ThreadStatus;
  name: string | null;
  turns: ReducedTurn[];
}

function timestamp(notification: AppServerNotification): number {
  return notification.emittedAtMs ?? Date.now();
}

function fingerprint(notification: AppServerNotification): string {
  return `${notification.method}:${notification.emittedAtMs ?? "none"}:${JSON.stringify(notification.params)}`;
}

function reconstructDiff(turn: CodexTurn): string {
  const diffs: string[] = [];
  for (const item of turn.items) {
    if (item.type !== "fileChange" || !Array.isArray(item.changes)) continue;
    for (const change of item.changes) {
      if (typeof change === "object" && change !== null && typeof (change as { diff?: unknown }).diff === "string") {
        diffs.push((change as { diff: string }).diff);
      }
    }
  }
  return diffs.join("\n");
}

function turnState(turn: CodexTurn): TurnState {
  return {
    turn: structuredClone(turn),
    completed: turn.status !== "inProgress",
    items: new Map(
      turn.items.map((item) => [
        item.id,
        itemState(item, true, 0),
      ]),
    ),
    aggregateDiff: reconstructDiff(turn),
    lastEmittedAtMs: 0,
  };
}

function threadIdOf(params: Record<string, unknown>): string | null {
  return typeof params.threadId === "string" ? params.threadId : null;
}

function turnIdOf(params: Record<string, unknown>): string | null {
  return typeof params.turnId === "string" ? params.turnId : null;
}

export class AppServerReducer {
  readonly #threads = new Map<string, ThreadState>();

  rebuild(thread: CodexThread): void {
    this.#threads.set(thread.id, {
      thread: structuredClone(thread),
      turns: new Map(thread.turns.map((turn) => [turn.id, turnState(turn)])),
      status: structuredClone(thread.status),
      name: thread.name,
      lastEmittedByEntity: new Map(),
      fingerprints: new Set(),
    });
  }

  remove(threadId: string): void {
    this.#threads.delete(threadId);
  }

  apply(notification: AppServerNotification): boolean {
    const params = notification.params as Record<string, unknown>;
    const threadId = threadIdOf(params);
    if (!threadId) return false;
    const state = this.#threads.get(threadId);
    if (!state) return false;

    const fp = fingerprint(notification);
    if (state.fingerprints.has(fp)) return false;
    state.fingerprints.add(fp);
    if (state.fingerprints.size > 1_000) state.fingerprints.clear();

    const at = timestamp(notification);
    const orderKey = [
      notification.method,
      typeof params.turnId === "string" ? params.turnId : "",
      typeof params.itemId === "string"
        ? params.itemId
        : isItem(params.item)
          ? params.item.id
          : isTurn(params.turn)
            ? params.turn.id
            : "",
    ].join(":");
    const previous = state.lastEmittedByEntity.get(orderKey) ?? 0;
    if (notification.emittedAtMs !== undefined && at < previous) return false;
    state.lastEmittedByEntity.set(orderKey, at);

    switch (notification.method) {
      case "thread/status/changed": {
        if (!isThreadStatus(params.status)) return false;
        state.status = structuredClone(params.status);
        state.thread.status = structuredClone(params.status);
        return true;
      }
      case "thread/name/updated": {
        if (typeof params.name !== "string" && params.name !== null) return false;
        state.name = params.name;
        state.thread.name = params.name;
        return true;
      }
      case "turn/started":
      case "turn/completed": {
        if (!isTurn(params.turn)) return false;
        const completed = notification.method === "turn/completed" || params.turn.status !== "inProgress";
        const existing = state.turns.get(params.turn.id);
        if (existing?.completed && !completed) return false;
        const next = turnState(params.turn);
        next.completed = completed;
        next.lastEmittedAtMs = at;
        if (existing && !next.aggregateDiff) next.aggregateDiff = existing.aggregateDiff;
        state.turns.set(params.turn.id, next);
        upsertTurn(state.thread, next.turn);
        return true;
      }
      case "turn/diff/updated": {
        const turn = this.#turn(state, turnIdOf(params));
        if (!turn || typeof params.diff !== "string") return false;
        if (notification.emittedAtMs !== undefined && at < turn.lastEmittedAtMs) return false;
        turn.aggregateDiff = params.diff;
        turn.lastEmittedAtMs = at;
        return true;
      }
      case "item/started":
      case "item/completed": {
        const turn = this.#turn(state, turnIdOf(params));
        if (!turn || !isItem(params.item)) return false;
        const completed = notification.method === "item/completed";
        const existing = turn.items.get(params.item.id);
        if (existing?.completed && !completed) return false;
        turn.items.set(params.item.id, completed
          ? itemState(params.item, true, at)
          : existing
            ? { ...existing, item: structuredClone(params.item), completed: false, lastEmittedAtMs: at }
            : itemState(params.item, false, at));
        upsertItem(turn.turn, params.item);
        return true;
      }
      case "item/agentMessage/delta":
      case "item/plan/delta": {
        const expectedType = notification.method === "item/agentMessage/delta" ? "agentMessage" : "plan";
        const item = this.#streamingItem(state, params, at, expectedType);
        if (!item || typeof params.delta !== "string") return false;
        item.textDeltas.push(params.delta);
        item.lastEmittedAtMs = at;
        return true;
      }
      case "item/reasoning/summaryPartAdded": {
        const item = this.#streamingItem(state, params, at, "reasoning");
        if (!item || !isNonNegativeInteger(params.summaryIndex)) return false;
        ensureSection(item.reasoningSummarySections, params.summaryIndex);
        item.lastEmittedAtMs = at;
        return true;
      }
      case "item/reasoning/summaryTextDelta": {
        const item = this.#streamingItem(state, params, at, "reasoning");
        if (!item || typeof params.delta !== "string" || !isNonNegativeInteger(params.summaryIndex)) return false;
        ensureSection(item.reasoningSummarySections, params.summaryIndex).push(params.delta);
        item.lastEmittedAtMs = at;
        return true;
      }
      case "item/reasoning/textDelta": {
        const item = this.#streamingItem(state, params, at, "reasoning");
        if (!item || typeof params.delta !== "string" || !isNonNegativeInteger(params.contentIndex)) return false;
        ensureSection(item.reasoningContentSections, params.contentIndex).push(params.delta);
        item.lastEmittedAtMs = at;
        return true;
      }
      case "item/commandExecution/outputDelta": {
        const item = this.#streamingItem(state, params, at, "commandExecution");
        if (!item || typeof params.delta !== "string") return false;
        item.commandOutputDeltas.push(params.delta);
        item.lastEmittedAtMs = at;
        return true;
      }
      case "item/fileChange/outputDelta": {
        const item = this.#streamingItem(state, params, at, "fileChange");
        if (!item || typeof params.delta !== "string") return false;
        item.legacyFileChangeOutputDeltas.push(params.delta);
        item.lastEmittedAtMs = at;
        return true;
      }
      default: {
        if (!notification.method.startsWith("item/") || !notification.method.endsWith("/delta")) return false;
        const item = this.#streamingItem(state, params, at);
        if (!item) return false;
        const delta = typeof params.delta === "string" ? params.delta : JSON.stringify(params.delta ?? "");
        item.textDeltas.push(delta);
        item.lastEmittedAtMs = at;
        return true;
      }
    }
  }

  getThread(threadId: string): ReducedThread | null {
    const state = this.#threads.get(threadId);
    if (!state) return null;
    return {
      thread: structuredClone(state.thread),
      status: structuredClone(state.status),
      name: state.name,
      turns: [...state.turns.values()].map(toReducedTurn),
    };
  }

  getTurn(threadId: string, turnId: string): ReducedTurn | null {
    const state = this.#threads.get(threadId)?.turns.get(turnId);
    return state ? toReducedTurn(state) : null;
  }

  latestCompletedTurn(threadId: string): ReducedTurn | null {
    const turns = [...(this.#threads.get(threadId)?.turns.values() ?? [])];
    const completed = turns.filter((turn) => turn.completed);
    return completed.length ? toReducedTurn(completed[completed.length - 1]!) : null;
  }

  trackedThreadIds(): string[] {
    return [...this.#threads.keys()];
  }

  getSubagentActivities(threadId: string): ThreadItem[] {
    const thread = this.#threads.get(threadId);
    if (!thread) return [];
    return [...thread.turns.values()]
      .flatMap((turn) => [...turn.items.values()])
      .map((state) => state.item)
      .filter((item) => item.type === "collabAgentToolCall" || item.type === "subAgentActivity")
      .map((item) => structuredClone(item));
  }

  #turn(state: ThreadState, turnId: string | null): TurnState | null {
    return turnId ? (state.turns.get(turnId) ?? null) : null;
  }

  #streamingItem(
    state: ThreadState,
    params: Record<string, unknown>,
    at: number,
    expectedType?: string,
  ): ItemState | null {
    const turn = this.#turn(state, turnIdOf(params));
    const itemId = typeof params.itemId === "string" ? params.itemId : null;
    if (!turn || !itemId) return null;
    const item = turn.items.get(itemId);
    if (!item || item.completed || at < item.lastEmittedAtMs || (expectedType && item.item.type !== expectedType)) return null;
    return item;
  }
}

function itemState(item: ThreadItem, completed: boolean, lastEmittedAtMs: number): ItemState {
  return {
    item: structuredClone(item),
    completed,
    textDeltas: [],
    reasoningSummarySections: new Map(),
    reasoningContentSections: new Map(),
    commandOutputDeltas: [],
    legacyFileChangeOutputDeltas: [],
    lastEmittedAtMs,
  };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function ensureSection(sections: Map<number, string[]>, index: number): string[] {
  const existing = sections.get(index);
  if (existing) return existing;
  const created: string[] = [];
  sections.set(index, created);
  return created;
}

function joinedSections(sections: Map<number, string[]>): string[] {
  const lastIndex = Math.max(-1, ...sections.keys());
  return Array.from({ length: lastIndex + 1 }, (_, index) => sections.get(index)?.join("") ?? "");
}

function isThreadStatus(value: unknown): value is ThreadStatus {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function isItem(value: unknown): value is ThreadItem {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function isTurn(value: unknown): value is CodexTurn {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    Array.isArray((value as { items?: unknown }).items)
  );
}

function upsertTurn(thread: CodexThread, turn: CodexTurn): void {
  const index = thread.turns.findIndex((candidate) => candidate.id === turn.id);
  if (index >= 0) thread.turns[index] = structuredClone(turn);
  else thread.turns.push(structuredClone(turn));
}

function upsertItem(turn: CodexTurn, item: ThreadItem): void {
  const index = turn.items.findIndex((candidate) => candidate.id === item.id);
  if (index >= 0) turn.items[index] = structuredClone(item);
  else turn.items.push(structuredClone(item));
}

function toReducedTurn(state: TurnState): ReducedTurn {
  return {
    turn: structuredClone(state.turn),
    completed: state.completed,
    items: [...state.items.values()].map((item) => {
      const summarySections = joinedSections(item.reasoningSummarySections);
      const contentSections = joinedSections(item.reasoningContentSections);
      const streamedText = item.item.type === "reasoning"
        ? summarySections.join("\n\n")
        : item.item.type === "commandExecution"
          ? item.commandOutputDeltas.join("")
          : item.item.type === "fileChange"
            ? item.legacyFileChangeOutputDeltas.join("")
            : item.textDeltas.join("");
      return {
        item: structuredClone(item.item),
        completed: item.completed,
        streamedText,
        streamedReasoningContent: contentSections.join("\n\n"),
        streamedReasoningSummarySections: summarySections,
      };
    }),
    aggregateDiff: state.aggregateDiff,
  };
}
