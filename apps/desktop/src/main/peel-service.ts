import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { EventEmitter } from "node:events";

import {
  AppServerClient,
  AppServerRpcError,
  AppServerTransport,
  type AppServerNotification,
  type AppServerServerRequest,
  type ThreadListResponse,
} from "@peel/codex-app-server";
import { GitWorkspaceAdapter, GitWorkspaceError } from "@peel/git-workspace";

import {
  THREAD_SEARCH_CACHE_TTL_MS,
  THREAD_SEARCH_PAGE_SIZE,
  type ApprovalDecisionInput,
  type BootstrapPayload,
  type CommitForkInput,
  type CommitForkResult,
  type PeelState,
  type SearchThreadsInput,
  type SendTurnInput,
  type StartNewChatInput,
  type StartSpaceInput,
  type ThreadSnapshot,
} from "../shared/contracts";
import { automaticTitle, createSpace } from "../shared/state";
import { StateStore } from "./state-store";

interface PendingAutomaticTitle {
  prompt: string;
  firstTurnId: string;
}

interface CachedThreadPage {
  expiresAt: number;
  response: ThreadListResponse;
}

export class PeelService extends EventEmitter {
  readonly transport: AppServerTransport;
  readonly client: AppServerClient;
  readonly git = new GitWorkspaceAdapter();
  readonly #store: StateStore;
  readonly #worktreesRoot: string;
  readonly #automaticTitles = new Map<string, PendingAutomaticTitle>();
  readonly #titleQueues = new Map<string, Promise<void>>();
  readonly #threadPages = new Map<string, CachedThreadPage>();
  readonly #threadPageRequests = new Map<string, Promise<ThreadListResponse>>();
  readonly #now: () => number;
  #threadCacheVersion = 0;
  #connected = false;
  #connectionError: string | null = null;

  constructor(userDataPath: string, options: { codexBinary?: string; stateFailureMarker?: string; now?: () => number } = {}) {
    super();
    this.#store = new StateStore(userDataPath, options.stateFailureMarker);
    this.#worktreesRoot = join(userDataPath, "Worktrees");
    this.#now = options.now ?? Date.now;
    this.transport = new AppServerTransport({ reconnect: true, ...(options.codexBinary ? { codexBinary: options.codexBinary } : {}) });
    this.client = new AppServerClient(this.transport);
    this.client.on("notification", (notification: AppServerNotification) => {
      this.emit("notification", notification);
      void this.#handleAutomaticTitle(notification);
    });
    this.client.on("serverRequest", (request: AppServerServerRequest) => this.emit("serverRequest", request));
    this.transport.on("ready", () => {
      this.#setConnection(true, null);
      this.#warmRecentThreads();
    });
    this.transport.on("disconnected", (error: Error) => this.#setConnection(false, error.message));
    this.transport.on("failed", (error: Error) => this.#setConnection(false, error.message));
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect();
      this.#setConnection(true, null);
      this.#warmRecentThreads();
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

  async searchThreads(input: SearchThreadsInput): Promise<ThreadListResponse> {
    this.#requireConnection();
    const term = input.term.trim();
    const cursor = input.cursor ?? null;
    const key = JSON.stringify([term.toLocaleLowerCase(), cursor]);
    const cached = this.#threadPages.get(key);
    if (cached && cached.expiresAt > this.#now()) return cached.response;
    const pending = this.#threadPageRequests.get(key);
    if (pending) return await pending;
    const cacheVersion = this.#threadCacheVersion;
    const request = this.client.searchThreads(term, {
      cursor,
      limit: THREAD_SEARCH_PAGE_SIZE,
      sortKey: "updated_at",
      sortDirection: "desc",
    }).then((response) => {
      if (cacheVersion === this.#threadCacheVersion) {
        this.#threadPages.set(key, { expiresAt: this.#now() + THREAD_SEARCH_CACHE_TTL_MS, response });
      }
      return response;
    }).finally(() => {
      if (this.#threadPageRequests.get(key) === request) this.#threadPageRequests.delete(key);
    });
    this.#threadPageRequests.set(key, request);
    return await request;
  }

  #warmRecentThreads(): void {
    void this.searchThreads({ term: "" }).catch(() => undefined);
  }

  async readThread(threadId: string): Promise<ThreadSnapshot> {
    this.#requireConnection();
    const thread = await this.client.readThread(threadId, true);
    return { thread, reduced: this.client.getThreadState(threadId) };
  }

  async startNewChat(input: StartNewChatInput): Promise<PeelState> {
    this.#requireConnection();
    const response = await this.client.startThread(input.cwd ? { cwd: input.cwd } : {});
    this.#invalidateThreadCache();
    const space = createSpace(response.thread);
    try {
      return await this.#store.mutate((state) => {
        state.spaces[space.id] = space;
        state.activeSpaceId = space.id;
        state.activeThreadId = response.thread.id;
        state.viewMode = "focus";
        return state;
      });
    } catch (error) {
      const cleanedUp = await this.client.deleteThread(response.thread.id).then(() => true, () => false);
      throw new Error(cleanedUp
        ? "The new Chat could not be saved, so nothing was added. Try again."
        : "The Chat was created in Codex but could not be added to Peel. Find it with Search Chats, then try again.");
    }
  }

  #invalidateThreadCache(): void {
    this.#threadCacheVersion += 1;
    this.#threadPages.clear();
    this.#threadPageRequests.clear();
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
    let turnId: string;
    try {
      turnId = await this.client.startTurn({
        threadId: input.threadId,
        input: input.input,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      });
    } catch (error) {
      if (isUnavailableThread(error)) {
        throw new Error("This Codex Chat could not be resumed. Your message is still in the draft—retry, or open the Chat in Codex from the header.");
      }
      throw error;
    }
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

    let cwd = input.draft.preparedFork?.cwd ?? parent.cwd;
    let worktreeName: string | null = input.draft.preparedFork?.worktreeName ?? null;
    if (input.draft.preparedWorktree) {
      const prepared = await this.git.inspect(input.draft.preparedWorktree.cwd);
      const worktreesRoot = await realpath(this.#worktreesRoot).catch(() => this.#worktreesRoot);
      const preparedRelative = prepared.gitBacked ? relative(worktreesRoot, prepared.worktreeRoot) : "..";
      if (!prepared.gitBacked || !prepared.isLinkedWorktree || !preparedRelative || preparedRelative === ".." || preparedRelative.startsWith(`..${sep}`) || isAbsolute(preparedRelative)) {
        return failure("worktree", "The prepared Worktree is no longer available", input, true);
      }
      cwd = prepared.worktreeRoot;
      worktreeName = input.draft.preparedWorktree.name;
    }
    if (input.draft.preparedFork) {
      const preparedForkCwd = await realpath(input.draft.preparedFork.cwd).catch(() => input.draft.preparedFork!.cwd);
      const selectedCwd = await realpath(cwd).catch(() => cwd);
      if (preparedForkCwd !== selectedCwd || input.draft.preparedFork.worktreeName !== worktreeName) {
        return {
          ...failure("fork", "The prepared Fork no longer matches its execution location", input, true),
          preparedFork: input.draft.preparedFork,
          ...(input.draft.preparedWorktree ? { preparedWorktree: input.draft.preparedWorktree } : {}),
        };
      }
      try {
        await this.client.readThread(input.draft.preparedFork.threadId, false);
      } catch (error) {
        return {
          ...failure("fork", `The prepared Codex Fork is unavailable: ${messageOf(error)}`, input, true),
          preparedFork: input.draft.preparedFork,
          ...(input.draft.preparedWorktree ? { preparedWorktree: input.draft.preparedWorktree } : {}),
        };
      }
    } else if (!input.draft.preparedWorktree && input.draft.createWorktree) {
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

    let childThreadId = input.draft.preparedFork?.threadId;
    if (!childThreadId) {
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
      const preparedFork = { threadId: childThreadId, cwd, worktreeName };
      return {
        ...failure("persist", messageOf(error), input, true),
        childThreadId,
        preparedFork,
        ...(worktreeName ? {
          preparedWorktree: { cwd, name: worktreeName },
          recoverableArtifacts: [
            { kind: "thread", name: childThreadId },
            { kind: "worktree", name: worktreeName, path: cwd },
          ],
        } : { recoverableArtifacts: [{ kind: "thread", name: childThreadId }] }),
      };
    }

    let turnId: string;
    try {
      turnId = await this.client.startTurn({ threadId: childThreadId, input: input.input, cwd });
    } catch (error) {
      return { ...failure("turn", messageOf(error), input, true), childThreadId };
    }
    this.#automaticTitles.set(childThreadId, { prompt: input.draft.prompt, firstTurnId: turnId });
    try {
      await this.#store.mutate((latest) => {
        latest.threadViews[childThreadId] = { draft: "", scrollTop: 0 };
        return latest;
      });
      return { ok: true, threadId: childThreadId, turnId, cwd, worktreeName };
    } catch (error) {
      return { ok: true, threadId: childThreadId, turnId, cwd, worktreeName, persistenceWarning: messageOf(error) };
    }
  }

  async setThreadName(threadId: string, name: string, spaceId: string): Promise<PeelState> {
    const normalized = name.replace(/\s+/g, " ").trim();
    if (!normalized) throw new Error("A Thread name cannot be empty");
    return await this.#withTitleLock(threadId, async () => {
      this.#automaticTitles.delete(threadId);
      await this.client.setThreadName(threadId, normalized);
      return await this.#store.mutate((state) => {
        const node = state.spaces[spaceId]?.nodes[threadId];
        if (!node) throw new Error("Thread is not in the selected Space");
        node.title = normalized;
        node.titleOrigin = "manual";
        state.spaces[spaceId]!.updatedAt = Date.now();
        return state;
      });
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
    await this.#withTitleLock(threadId, async () => {
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
    });
  }

  async #withTitleLock<T>(threadId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#titleQueues.get(threadId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    const tail = run.then(() => undefined, () => undefined);
    this.#titleQueues.set(threadId, tail);
    try {
      return await run;
    } finally {
      if (this.#titleQueues.get(threadId) === tail) this.#titleQueues.delete(threadId);
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

function isUnavailableThread(error: unknown): boolean {
  return error instanceof AppServerRpcError
    && (error.code === -32600 || error.code === -32004)
    && /thread.*(?:not found|unknown)|unknown.*thread/i.test(error.message);
}
