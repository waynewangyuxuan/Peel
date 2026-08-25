import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { PeelState } from "../shared/contracts";
import { emptyState, normalizeState } from "../shared/state";

export class StateStore {
  readonly path: string;
  #queue = Promise.resolve();

  constructor(userDataPath: string) {
    this.path = join(userDataPath, "peel-state.json");
  }

  async load(): Promise<PeelState> {
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
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    });
    this.#queue = task.catch(() => undefined);
    await task;
    return normalized;
  }

  async mutate(mutator: (state: PeelState) => PeelState | void): Promise<PeelState> {
    const current = await this.load();
    const result = mutator(structuredClone(current)) ?? current;
    return await this.save(result);
  }
}
