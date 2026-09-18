import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { EventEmitter } from "node:events";

import {
  AppServerClient,
  AppServerRpcError,
  AppServerTransport,
  serverRequestRoute,
  type AppServerNotification,
  type AppServerServerRequest,
  type JsonObject,
  type ThreadListResponse,
} from "@peel/codex-app-server";
import { GitWorkspaceAdapter, GitWorkspaceError } from "@peel/git-workspace";

import {
  THREAD_SEARCH_CACHE_TTL_MS,
  THREAD_SEARCH_PAGE_SIZE,
  type BootstrapPayload,
  type CodexNotice,
  type CommitForkInput,
  type CommitForkResult,
  type PeelState,
  type SearchThreadsInput,
  type SendTurnInput,
  type ServerRequestResponseInput,
  type StartNewChatInput,
  type StartSpaceInput,
  type ThreadSnapshot,
} from "../shared/contracts";
import { automaticTitle, createSpace, temporaryTitle } from "../shared/state";
import { StateStore } from "./state-store";
import { RealtimeDictationService } from "./realtime-dictation-service";

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
  readonly dictation: RealtimeDictationService;
  readonly git = new GitWorkspaceAdapter();
  readonly #store: StateStore;
  readonly #worktreesRoot: string;
  readonly #automaticTitles = new Map<string, PendingAutomaticTitle>();
  readonly #titleQueues = new Map<string, Promise<void>>();
  readonly #threadPages = new Map<string, CachedThreadPage>();
  readonly #threadPageRequests = new Map<string, Promise<ThreadListResponse>>();
  readonly #pendingServerRequests = new Map<string, AppServerServerRequest>();
  readonly #notices = new Map<string, CodexNotice>();
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
    this.dictation = new RealtimeDictationService(this.client);
    this.client.on("notification", (notification: AppServerNotification) => {
      this.#handleRequestResolution(notification);
      this.#recordNotice(notification);
      const threadId = typeof notification.params.threadId === "string" ? notification.params.threadId : null;
      const snapshotStarted = performance.now();
      const reduced = threadId ? this.client.getThreadState(threadId) : null;
      const snapshotConstructionMs = performance.now() - snapshotStarted;
      this.emit("notification", {
        notification,
        snapshot: reduced ? {
          thread: reduced.thread,
          reduced,
          performance: {
            source: "notification",
            threadReadMs: null,
            snapshotConstructionMs,
            sentAtEpochMs: Date.now(),
          },
        } : null,
      });
      void this.#handleAutomaticTitle(notification);
    });
    this.client.on("serverRequest", (request: AppServerServerRequest) => this.#handleServerRequest(request));
    this.transport.on("ready", () => {
      this.#setConnection(true, null);
      this.#warmRecentThreads();
    });
    this.transport.on("disconnected", (error: Error) => {
      this.#clearPendingRequests();
      this.#setConnection(false, error.message);
    });
    this.transport.on("failed", (error: Error) => {
      this.#clearPendingRequests();
      this.#setConnection(false, error.message);
    });
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
    await this.dictation.cancelAll();
    await this.transport.shutdown();
  }

  async bootstrap(): Promise<BootstrapPayload> {
    return {
      state: await this.#store.load(),
      connected: this.#connected,
      connectionError: this.#connectionError,
      capabilities: this.client.capabilities.snapshot() as unknown as Record<string, unknown>,
      pendingRequests: [...this.#pendingServerRequests.values()],
      notices: [...this.#notices.values()],
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
    const request = (term ? this.client.searchThreads(term, {
      cursor,
      limit: THREAD_SEARCH_PAGE_SIZE,
      sortKey: "updated_at",
      sortDirection: "desc",
    }) : this.client.listThreads({
      cursor,
      limit: THREAD_SEARCH_PAGE_SIZE,
      sortKey: "updated_at",
      sortDirection: "desc",
    })).then((response) => {
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
    const readStarted = performance.now();
    const thread = await this.client.readThread(threadId, true);
    const threadReadMs = performance.now() - readStarted;
    const snapshotStarted = performance.now();
    const reduced = this.client.getThreadState(threadId);
    const snapshotConstructionMs = performance.now() - snapshotStarted;
    return {
      thread,
      reduced,
      performance: {
        source: "read",
        threadReadMs,
        snapshotConstructionMs,
        sentAtEpochMs: Date.now(),
      },
    };
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
    if (input.name?.trim()) {
      space.name = input.name.trim();
      space.nameOrigin = "manual";
    }
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
    const space = Object.values(state.spaces).find((candidate) => candidate.nodes[input.threadId]);
    const node = space?.nodes[input.threadId];
    const prompt = input.input.find((candidate) => candidate.type === "text")?.text;
    if (node?.titleOrigin === "temporary" && prompt?.trim()) {
      this.#automaticTitles.set(input.threadId, { prompt, firstTurnId: turnId });
      const title = temporaryTitle(prompt, "New Chat");
      try {
        await this.#store.mutate((latest) => {
          const target = space ? latest.spaces[space.id] : null;
          const current = target?.nodes[input.threadId];
          if (!target || !current || current.titleOrigin !== "temporary") return latest;
          current.title = title;
          if (target.rootThreadId === input.threadId && target.nameOrigin === "default") target.name = title;
          target.updatedAt = Date.now();
          return latest;
        });
      } catch (error) {
        this.emit("titleError", { threadId: input.threadId, error: messageOf(error) });
      }
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
        const space = state.spaces[spaceId]!;
        if (space.rootThreadId === threadId && space.nameOrigin === "default") space.name = normalized;
        space.updatedAt = Date.now();
        return state;
      });
    });
  }

  respondServerRequest(input: ServerRequestResponseInput): void {
    const key = requestKey(input.id);
    const request = this.#pendingServerRequests.get(key);
    if (!request) return;
    const route = serverRequestRoute(request.method);
    if (route === "command-approval" && input.kind === "command") {
      const params = recordOf(request.params);
      if (input.decision === "acceptProposedExecpolicyAmendment") {
        const amendment = params.proposedExecpolicyAmendment;
        if (!isRecord(amendment)) throw new Error("This command request has no proposed exec policy amendment");
        this.client.approveCommand(input.id, { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment as JsonObject } });
      } else if (isRecord(input.decision) && typeof input.decision.applyProposedNetworkPolicyAmendment === "number") {
        const amendments = params.proposedNetworkPolicyAmendments;
        const amendment = Array.isArray(amendments) ? amendments[input.decision.applyProposedNetworkPolicyAmendment] : null;
        if (!isRecord(amendment)) throw new Error("This command request has no matching network policy amendment");
        this.client.approveCommand(input.id, { applyNetworkPolicyAmendment: { network_policy_amendment: amendment as JsonObject } });
      } else {
        this.client.approveCommand(input.id, input.decision);
      }
    } else if (route === "file-change-approval" && input.kind === "file-change") {
      this.client.approveFileChange(input.id, input.decision);
    } else if (route === "user-input" && input.kind === "user-input") {
      validateUserInputAnswers(request, input.answers);
      this.client.answerUserInput(input.id, input.answers);
    } else if (route === "permissions" && input.kind === "permissions") {
      const requested = recordOf(request.params).permissions;
      const permissions = input.decision === "grant" && isRecord(requested)
        ? grantedPermissions(requested)
        : {};
      this.client.grantPermissions(input.id, permissions, input.scope);
    } else if (route === "mcp-elicitation" && input.kind === "mcp-elicitation") {
      const content = input.action === "accept" ? input.content ?? null : null;
      validateMcpElicitationContent(request, input.action, content);
      this.client.respondMcpElicitation(input.id, input.action, content);
    } else {
      throw new Error(`Response kind ${input.kind} does not match ${request.method}`);
    }
    this.#pendingServerRequests.delete(key);
    this.#emitPendingRequests();
  }

  #handleServerRequest(request: AppServerServerRequest): void {
    const route = serverRequestRoute(request.method);
    if (route.startsWith("unsupported-")) {
      this.client.rejectServerRequest(request.id, -32601, `Peel does not support the ${request.method} host capability`, {
        kind: "unsupported_host_capability",
        method: request.method,
      });
      return;
    }
    this.#pendingServerRequests.set(requestKey(request.id), request);
    this.#emitPendingRequests();
  }

  #handleRequestResolution(notification: AppServerNotification): void {
    if (notification.method !== "serverRequest/resolved") return;
    const requestId = recordOf(notification.params).requestId;
    if (typeof requestId !== "number" && typeof requestId !== "string") return;
    if (this.#pendingServerRequests.delete(requestKey(requestId))) this.#emitPendingRequests();
  }

  #clearPendingRequests(): void {
    if (this.#pendingServerRequests.size === 0) return;
    this.#pendingServerRequests.clear();
    this.#emitPendingRequests();
  }

  #emitPendingRequests(): void {
    this.emit("pendingRequests", [...this.#pendingServerRequests.values()]);
  }

  #recordNotice(notification: AppServerNotification): void {
    const notice = noticeFromNotification(notification, this.#now());
    if (!notice) return;
    this.#notices.set(notice.id, notice);
    while (this.#notices.size > 50) this.#notices.delete(this.#notices.keys().next().value as string);
    this.emit("notices", [...this.#notices.values()]);
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
            const target = latest.spaces[space.id]!;
            if (target.rootThreadId === threadId && target.nameOrigin === "default") target.name = title;
            target.updatedAt = Date.now();
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

function requestKey(id: number | string): string {
  return `${typeof id}:${String(id)}`;
}

function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateUserInputAnswers(request: AppServerServerRequest, answers: Record<string, string[]>): void {
  const questions = recordOf(request.params).questions;
  if (!Array.isArray(questions)) throw new Error("The user-input request has no valid questions");
  const questionIds = questions
    .map((question) => isRecord(question) && typeof question.id === "string" ? question.id : null)
    .filter((id): id is string => Boolean(id));
  if (questionIds.length !== questions.length) throw new Error("The user-input request contains an invalid question");
  for (const id of questionIds) {
    const values = answers[id];
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error("Answer every Codex question before continuing");
    }
  }
  if (Object.keys(answers).some((id) => !questionIds.includes(id))) throw new Error("The response contains an unknown Codex question");
}

function validateMcpElicitationContent(
  request: AppServerServerRequest,
  action: "accept" | "decline" | "cancel",
  content: unknown,
): void {
  if (action !== "accept") return;
  const params = recordOf(request.params);
  if (params.mode === "url") {
    if (content !== null) throw new Error("URL elicitation acceptance cannot include form content");
    return;
  }
  const schema = recordOf(params.requestedSchema);
  if (params.mode === "openai/form" || params.mode === "openaiForm") {
    if (!matchesJsonSchema(content, schema)) throw new Error("The MCP response does not match its requested schema");
    return;
  }
  const fields = recordOf(schema.properties);
  if (!isRecord(content)) throw new Error("MCP form content must be an object");
  const response = content;
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : [];
  for (const name of required) {
    if (!(name in response)) throw new Error(`Complete the required MCP field: ${name}`);
  }
  for (const [name, value] of Object.entries(response)) {
    if (!(name in fields)) throw new Error(`The MCP response contains an unknown field: ${name}`);
    const field = recordOf(fields[name]);
    const type = field.type;
    const choices = mcpFieldChoices(field);
    const valid = type === "boolean"
      ? typeof value === "boolean"
      : type === "number" || type === "integer"
        ? typeof value === "number" && Number.isFinite(value) && (type !== "integer" || Number.isInteger(value))
        : type === "array"
          ? Array.isArray(value) && value.every((entry) => typeof entry === "string" && (choices.length === 0 || choices.includes(entry)))
          : choices.length > 0
            ? typeof value === "string" && choices.includes(value)
          : typeof value === "string";
    if (!valid) throw new Error(`The MCP field ${name} does not match its requested type`);
    if (typeof value === "number" && typeof field.minimum === "number" && value < field.minimum) throw new Error(`The MCP field ${name} is below its minimum`);
    if (typeof value === "number" && typeof field.maximum === "number" && value > field.maximum) throw new Error(`The MCP field ${name} is above its maximum`);
    if (typeof value === "string" && typeof field.minLength === "number" && value.length < field.minLength) throw new Error(`The MCP field ${name} is too short`);
    if (typeof value === "string" && typeof field.maxLength === "number" && value.length > field.maxLength) throw new Error(`The MCP field ${name} is too long`);
  }
}

function mcpFieldChoices(field: Record<string, unknown>): string[] {
  if (Array.isArray(field.enum)) return field.enum.filter((value): value is string => typeof value === "string");
  const items = recordOf(field.items);
  if (Array.isArray(items.enum)) return items.enum.filter((value): value is string => typeof value === "string");
  const oneOf = Array.isArray(field.oneOf) ? field.oneOf : Array.isArray(items.oneOf) ? items.oneOf : [];
  return oneOf.filter(isRecord).flatMap((option) => typeof option.const === "string" ? [option.const] : []);
}

function grantedPermissions(requested: Record<string, unknown>): JsonObject {
  const granted: JsonObject = {};
  if (isRecord(requested.network)) granted.network = requested.network as JsonObject;
  if (isRecord(requested.fileSystem)) granted.fileSystem = requested.fileSystem as JsonObject;
  return granted;
}

function matchesJsonSchema(value: unknown, schema: Record<string, unknown>): boolean {
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEqual(candidate, value))) return false;
  if ("const" in schema && !jsonEqual(schema.const, value)) return false;
  if (Array.isArray(schema.allOf) && !schema.allOf.every((candidate) => matchesJsonSchema(value, recordOf(candidate)))) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((candidate) => matchesJsonSchema(value, recordOf(candidate)))) return false;
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((candidate) => matchesJsonSchema(value, recordOf(candidate))).length !== 1) return false;
  const allowedTypes = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  if (allowedTypes.length > 0 && !allowedTypes.some((type) => matchesJsonType(value, type))) return false;
  if (isRecord(value)) {
    const properties = recordOf(schema.properties);
    const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
    if (required.some((name) => !(name in value))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some((name) => !(name in properties))) return false;
    for (const [name, fieldValue] of Object.entries(value)) {
      if (name in properties && !matchesJsonSchema(fieldValue, recordOf(properties[name]))) return false;
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    const items = recordOf(schema.items);
    if (Object.keys(items).length > 0 && !value.every((item) => matchesJsonSchema(item, items))) return false;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) return false;
      } catch {
        return false;
      }
    }
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
  }
  return true;
}

function matchesJsonType(value: unknown, type: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return type === typeof value;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function noticeFromNotification(notification: AppServerNotification, createdAt: number): CodexNotice | null {
  const params = recordOf(notification.params);
  let kind: CodexNotice["kind"];
  let message: string;
  let threadId = typeof params.threadId === "string" ? params.threadId : null;
  let turnId: string | null = null;
  let willRetry = false;
  if (notification.method === "error") {
    kind = "error";
    const error = recordOf(params.error);
    message = typeof error.message === "string" ? error.message : "Codex reported a Turn error";
    turnId = typeof params.turnId === "string" ? params.turnId : null;
    willRetry = params.willRetry === true;
  } else if (notification.method === "warning" || notification.method === "guardianWarning") {
    kind = "warning";
    message = typeof params.message === "string" ? params.message : "Codex reported a warning";
  } else if (notification.method === "configWarning" || notification.method === "deprecationNotice") {
    kind = "warning";
    threadId = null;
    message = [params.summary, params.details].filter((part): part is string => typeof part === "string" && Boolean(part.trim())).join(" — ") || "Codex reported a warning";
  } else {
    return null;
  }
  const safeMessage = message.replace(/\s+/g, " ").trim().slice(0, 1_000);
  return {
    id: [notification.method, threadId ?? "global", turnId ?? "thread", safeMessage].join(":"),
    kind,
    threadId,
    turnId,
    message: safeMessage,
    willRetry,
    createdAt,
  };
}
