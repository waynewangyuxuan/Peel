import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import type { CodexThread, CodexTurn, ThreadItem } from "../src/protocol.js";
import type { ProcessLike } from "../src/transport.js";

export class FakeProcess extends EventEmitter implements ProcessLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: Record<string, unknown>[] = [];

  constructor(autoInitialize = true) {
    super();
    let buffer = "";
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line) as Record<string, unknown>;
        this.writes.push(message);
        if (autoInitialize && message.method === "initialize") {
          queueMicrotask(() =>
            this.send({
              id: message.id,
              result: {
                userAgent: "codex-test",
                codexHome: "/tmp/codex-test",
                platformFamily: "unix",
                platformOs: "macos",
              },
            }),
          );
        }
      }
    });
  }

  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    queueMicrotask(() => this.emit("exit", 0, signal));
    return true;
  }
}

export function item(id: string, type = "agentMessage", extra: Record<string, unknown> = {}): ThreadItem {
  return { id, type, ...extra };
}

export function turn(
  id: string,
  status: CodexTurn["status"] = "completed",
  items: ThreadItem[] = [],
): CodexTurn {
  return {
    id,
    status,
    items,
    error: null,
    startedAt: 1,
    completedAt: status === "inProgress" ? null : 2,
    durationMs: status === "inProgress" ? null : 1,
  };
}

export function thread(id = "thread-1", turns: CodexTurn[] = []): CodexThread {
  return {
    id,
    sessionId: `session-${id}`,
    forkedFromId: null,
    parentThreadId: null,
    preview: "fixture",
    ephemeral: false,
    projectId: null,
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: "idle" },
    path: null,
    cwd: "/tmp/peel-fixture",
    cliVersion: "0.149.0",
    source: "fixture",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns,
  };
}
