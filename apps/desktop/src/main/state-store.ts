import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PeelState } from "../shared/contracts";
import { emptyState, normalizeState } from "../shared/state";

export class StateStore {
  readonly path: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(userDataPath: string, private readonly failureMarkerPath?: string) {
    this.path = join(userDataPath, "peel-state.json");
  }

  async load(): Promise<PeelState> {
    await this.#queue;
    return await this.#read();
  }

  async #read(): Promise<PeelState> {
    try {
      return normalizeState(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return emptyState();
      if (error instanceof SyntaxError) return emptyState();
      throw error;
    }
  }

  async save(next: PeelState): Promise<PeelState> {
    const normalized = normalizeState(next);
    const task = this.#queue.then(async () => {
      const merged = mergeRendererState(await this.#read(), normalized);
      await this.#write(merged);
      return merged;
    });
    this.#queue = task.catch(() => undefined);
    return await task;
  }

  async mutate(mutator: (state: PeelState) => PeelState | void): Promise<PeelState> {
    const task = this.#queue.then(async () => {
      const current = await this.#read();
      const draft = structuredClone(current);
      const result = normalizeState(mutator(draft) ?? draft);
      await this.#write(result);
      return result;
    });
    this.#queue = task.then(() => undefined, () => undefined);
    return await task;
  }

  async #write(state: PeelState): Promise<void> {
    if (this.failureMarkerPath && await access(this.failureMarkerPath).then(() => true, () => false)) {
      await unlink(this.failureMarkerPath);
      throw new Error("Forced state persistence failure for recovery testing");
    }
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}

function mergeRendererState(current: PeelState, incoming: PeelState): PeelState {
  const spaces = { ...current.spaces };
  for (const [spaceId, nextSpace] of Object.entries(incoming.spaces)) {
    const previous = current.spaces[spaceId];
    if (!previous) {
      spaces[spaceId] = nextSpace;
      continue;
    }
    const nodes = { ...previous.nodes };
    for (const [threadId, nextNode] of Object.entries(nextSpace.nodes)) {
      const priorNode = previous.nodes[threadId];
      if (!priorNode) {
        nodes[threadId] = nextNode;
        continue;
      }
      const originRank = { temporary: 0, automatic: 1, manual: 2 } as const;
      const keepPriorTitle = priorNode.titleOrigin === "manual" || originRank[priorNode.titleOrigin] > originRank[nextNode.titleOrigin];
      nodes[threadId] = {
        ...priorNode,
        position: nextNode.position,
        lastViewedTurnId: nextNode.lastViewedTurnId,
        ...(keepPriorTitle ? {} : { title: nextNode.title, titleOrigin: nextNode.titleOrigin }),
      };
    }
    spaces[spaceId] = {
      ...previous,
      name: nextSpace.name,
      archived: nextSpace.archived,
      updatedAt: Math.max(previous.updatedAt, nextSpace.updatedAt),
      nodes,
      camera: nextSpace.camera,
    };
  }
  const merged = normalizeState({
    ...incoming,
    spaces,
    threadViews: { ...current.threadViews, ...incoming.threadViews },
  });
  return merged;
}
