import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { EventEmitter } from "node:events";

import {
  AppServerClient,
  AppServerTransport,
  type AppServerNotification,
  type AppServerServerRequest,
  type ThreadListResponse,
} from "@peel/codex-app-server";
import { GitWorkspaceAdapter, GitWorkspaceError } from "@peel/git-workspace";

import type {
  ApprovalDecisionInput,
  BootstrapPayload,
  CommitForkInput,
  CommitForkResult,
  PeelState,
  SendTurnInput,
  StartSpaceInput,
  ThreadSnapshot,
} from "../shared/contracts";
import { automaticTitle, createSpace } from "../shared/state";
import { StateStore } from "./state-store";

interface PendingAutomaticTitle {
  prompt: string;
  firstTurnId: string;
}

export class PeelService extends EventEmitter {
  readonly transport: AppServerTransport;
  readonly client: AppServerClient;
  readonly git = new GitWorkspaceAdapter();
  readonly #store: StateStore;
  readonly #worktreesRoot: string;
  readonly #automaticTitles = new Map<string, PendingAutomaticTitle>();
  #connected = false;
  #connectionError: string | null = null;

  constructor(userDataPath: string, options: { codexBinary?: string } = {}) {
    super();
    this.#store = new StateStore(userDataPath);
    this.#worktreesRoot = join(userDataPath, "Worktrees");
    this.transport = new AppServerTransport({ reconnect: true, ...(options.codexBinary ? { codexBinary: options.codexBinary } : {}) });
    this.client = new AppServerClient(this.transport);
    this.client.on("notification", (notification: AppServerNotification) => {
      this.emit("notification", notification);
      void this.#handleAutomaticTitle(notification);
    });
    this.client.on("serverRequest", (request: AppServerServerRequest) => this.emit("serverRequest", request));
    this.transport.on("ready", () => this.#setConnection(true, null));
    this.transport.on("disconnected", (error: Error) => this.#setConnection(false, error.message));
    this.transport.on("failed", (error: Error) => this.#setConnection(false, error.message));
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
      this.#setConnection(true, null);
    } catch (error) {
      this.#setConnection(false, messageOf(error));
    }
  }

  async shutdown(): Promise<void> {
    await this.transport.shutdown();
  }

  async bootstrap(): Promise<BootstrapPayload> {
    return {
      state: await this.#store.load(),
      connected: this.#connected,
      connectionError: this.#connectionError,
      capabilities: this.client.capabilities.snapshot() as unknown as Record<string, unknown>,
    };
  }

  async searchThreads(term: string): Promise<ThreadListResponse> {
    this.#requireConnection();
    return await this.client.searchThreads(term, { limit: 50, sortKey: "updated_at", sortDirection: "desc" });
  }

  async readThread(threadId: string): Promise<ThreadSnapshot> {
    this.#requireConnection();
    const thread = await this.client.readThread(threadId, true);
    return { thread, reduced: this.client.getThreadState(threadId) };
  }

  async startSpace(input: StartSpaceInput): Promise<PeelState> {
    const thread = await this.client.readThread(input.threadId, true);
    const space = createSpace(thread);
    if (input.name?.trim()) space.name = input.name.trim();
    return await this.#store.mutate((state) => {
      state.spaces[space.id] = space;
      state.activeSpaceId = space.id;
      state.activeThreadId = thread.id;
      state.viewMode = "focus";
      return state;
    });
  }

  async saveState(state: PeelState): Promise<PeelState> {
    return await this.#store.save(state);
  }

  async sendTurn(input: SendTurnInput): Promise<{ turnId: string }> {
    this.#requireConnection();
    const turnId = await this.client.startTurn({
      threadId: input.threadId,
      input: input.input,
      ...(input.cwd ? { cwd: input.cwd } : {}),
    });
    const state = await this.#store.load();
    const node = Object.values(state.spaces).flatMap((space) => Object.values(space.nodes)).find((candidate) => candidate.threadId === input.threadId);
    const prompt = input.input.find((candidate) => candidate.type === "text")?.text;
    if (node?.titleOrigin === "temporary" && prompt?.trim()) {
      this.#automaticTitles.set(input.threadId, { prompt, firstTurnId: turnId });
    }
    return { turnId };
  }

  async commitFork(input: CommitForkInput): Promise<CommitForkResult> {
    this.#requireConnection();
    const state = await this.#store.load();
    const space = state.spaces[input.spaceId];
    const parent = space?.nodes[input.draft.parentThreadId];
    if (!space || !parent) {
      return failure("persist", "The parent is no longer part of this Space", input, false);
    }

    let cwd = parent.cwd;
    let worktreeName: string | null = null;
    if (input.draft.preparedWorktree) {
      const prepared = await this.git.inspect(input.draft.preparedWorktree.cwd);
      const worktreesRoot = await realpath(this.#worktreesRoot).catch(() => this.#worktreesRoot);
      const preparedRelative = prepared.gitBacked ? relative(worktreesRoot, prepared.worktreeRoot) : "..";
      if (!prepared.gitBacked || !prepared.isLinkedWorktree || !preparedRelative || preparedRelative === ".." || preparedRelative.startsWith(`..${sep}`) || isAbsolute(preparedRelative)) {
        return failure("worktree", "The prepared Worktree is no longer available", input, true);
      }
      cwd = prepared.worktreeRoot;
      worktreeName = input.draft.preparedWorktree.name;
    } else if (input.draft.createWorktree) {
      try {
        await mkdir(this.#worktreesRoot, { recursive: true });
        const created = await this.git.createWorktree({
          repositoryCwd: parent.cwd,
          targetParent: this.#worktreesRoot,
          forkIdentity: input.draft.prompt,
          pendingForkId: input.draft.pendingForkId,
        });
        cwd = created.cwd;
        worktreeName = created.branch;
      } catch (error) {
        const details = error instanceof GitWorkspaceError ? error.details : null;
        return {
          ...failure("worktree", messageOf(error), input, true),
          recoverableArtifacts: details?.artifacts ?? [],
        };
      }
    }

    let childThreadId: string;
    try {
      const forked = await this.client.forkThread({
        threadId: parent.threadId,
        lastTurnId: input.draft.forkedAtTurnId,
        cwd,
      });
      childThreadId = forked.thread.id;
    } catch (error) {
      return {
        ...failure("fork", messageOf(error), input, true),
        ...(worktreeName ? {
          preparedWorktree: { cwd, name: worktreeName },
          recoverableArtifacts: [{ kind: "worktree", name: worktreeName, path: cwd }],
        } : {}),
      };
    }

    try {
      await this.#store.mutate((latest) => {
        const target = latest.spaces[input.spaceId];
        if (!target || !target.nodes[parent.threadId]) throw new Error("The Space changed while the Fork was being created");
        target.nodes[childThreadId] = {
          threadId: childThreadId,
          parentThreadId: parent.threadId,
          forkedAtTurnId: input.draft.forkedAtTurnId,
          createdAt: Date.now(),
          position: input.draft.position,
          title: automaticTitle(input.draft.prompt),
          titleOrigin: "temporary",
          cwd,
          worktreeName,
          lastViewedTurnId: null,
        };
        target.updatedAt = Date.now();
        latest.activeSpaceId = target.id;
        latest.activeThreadId = childThreadId;
        latest.viewMode = "focus";
        latest.threadViews[childThreadId] = { draft: input.draft.prompt, scrollTop: 0 };
        return latest;
      });
    } catch (error) {
      return { ...failure("persist", messageOf(error), input, true), childThreadId };
    }

    try {
      const turnId = await this.client.startTurn({ threadId: childThreadId, input: input.input, cwd });
      this.#automaticTitles.set(childThreadId, { prompt: input.draft.prompt, firstTurnId: turnId });
      await this.#store.mutate((latest) => {
        latest.threadViews[childThreadId] = { draft: "", scrollTop: 0 };
        return latest;
      });
      return { ok: true, threadId: childThreadId, turnId, cwd, worktreeName };
    } catch (error) {
      return { ...failure("turn", messageOf(error), input, true), childThreadId };
    }
  }

  async setThreadName(threadId: string, name: string, spaceId: string): Promise<PeelState> {
    const normalized = name.replace(/\s+/g, " ").trim();
    if (!normalized) throw new Error("A Thread name cannot be empty");
    await this.client.setThreadName(threadId, normalized);
    this.#automaticTitles.delete(threadId);
    return await this.#store.mutate((state) => {
      const node = state.spaces[spaceId]?.nodes[threadId];
      if (!node) throw new Error("Thread is not in the selected Space");
      node.title = normalized;
      node.titleOrigin = "manual";
      state.spaces[spaceId]!.updatedAt = Date.now();
      return state;
    });
  }

  decideApproval(input: ApprovalDecisionInput): void {
    if (input.method.includes("fileChange")) this.client.approveFileChange(input.id, input.decision);
    else this.client.approveCommand(input.id, input.decision);
  }

  async #handleAutomaticTitle(notification: AppServerNotification): Promise<void> {
    if (notification.method !== "turn/completed") return;
    const params = notification.params as Record<string, unknown>;
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    const turn = params.turn as { id?: unknown } | undefined;
    if (!threadId || typeof turn?.id !== "string") return;
    const pending = this.#automaticTitles.get(threadId);
    if (!pending || pending.firstTurnId !== turn.id) return;
    const state = await this.#store.load();
    const space = Object.values(state.spaces).find((candidate) => candidate.nodes[threadId]);
    const node = space?.nodes[threadId];
    if (!space || !node || node.titleOrigin !== "temporary") {
      this.#automaticTitles.delete(threadId);
      return;
    }
    const title = automaticTitle(pending.prompt);
    try {
      await this.client.setThreadName(threadId, title);
      await this.#store.mutate((latest) => {
        const current = latest.spaces[space.id]?.nodes[threadId];
        if (current?.titleOrigin === "temporary") {
          current.title = title;
          current.titleOrigin = "automatic";
        }
        return latest;
      });
      this.#automaticTitles.delete(threadId);
    } catch (error) {
      this.emit("titleError", { threadId, error: messageOf(error) });
    }
  }

  #requireConnection(): void {
    if (!this.#connected) throw new Error(this.#connectionError || "Codex App Server is not connected");
  }

  #setConnection(connected: boolean, error: string | null): void {
    this.#connected = connected;
    this.#connectionError = error;
    this.emit("connection", { connected, error });
  }
}

function failure(
  stage: "worktree" | "fork" | "turn" | "persist",
  message: string,
  input: CommitForkInput,
  retryable: boolean,
): Extract<CommitForkResult, { ok: false }> {
  return {
    ok: false,
    stage,
    message,
    retryable,
    prompt: input.draft.prompt,
    pendingForkId: input.draft.pendingForkId,
    recoverableArtifacts: [],
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
