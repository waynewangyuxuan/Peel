import { EventEmitter } from "node:events";

import { CapabilityMatrix } from "./capabilities.js";
import type {
  AppServerNotification,
  AppServerServerRequest,
  AppServerMethod,
  CodexThread,
  FileChangeApprovalDecision,
  JsonObject,
  MethodParams,
  MethodResult,
  InitializeResponse,
  RequestId,
  ThreadForkParams,
  ThreadListParams,
  ThreadListResponse,
  ThreadStartParams,
  ThreadStartResponse,
  TurnStartParams,
  CommandApprovalDecision,
} from "./protocol.js";
import { AppServerReducer, type ReducedThread, type ReducedTurn } from "./reducer.js";
import { detectInstalledAppServerSchema } from "./schema.js";
import { AppServerRpcError, AppServerTransport } from "./transport.js";

export interface AppServerClientOptions {
  reducer?: AppServerReducer;
  schemaDetector?: typeof detectInstalledAppServerSchema;
}

export class AppServerClient extends EventEmitter {
  readonly transport: AppServerTransport;
  readonly reducer: AppServerReducer;
  readonly capabilities: CapabilityMatrix;
  readonly #tracked = new Set<string>();
  readonly #loaded = new Set<string>();
  readonly #resumeRequests = new Map<string, Promise<void>>();
  readonly #schemaDetector: typeof detectInstalledAppServerSchema;

  constructor(transport: AppServerTransport, options: AppServerClientOptions = {}) {
    super();
    this.transport = transport;
    this.reducer = options.reducer ?? new AppServerReducer();
    this.#schemaDetector = options.schemaDetector ?? detectInstalledAppServerSchema;
    this.capabilities = new CapabilityMatrix({
      experimentalApi: transport.initializeParams.capabilities?.experimentalApi ?? false,
    });
    transport.on("notification", (notification: AppServerNotification) => {
      if (notification.method === "thread/closed" && typeof notification.params.threadId === "string") {
        this.#loaded.delete(notification.params.threadId);
      }
      this.reducer.apply(notification);
      this.emit("notification", notification);
      if (notification.method === "thread/status/changed") this.emit("status", notification.params);
    });
    transport.on("serverRequest", (request: AppServerServerRequest) => this.emit("serverRequest", request));
    transport.on("disconnected", () => this.#loaded.clear());
    transport.on("failed", () => this.#loaded.clear());
    transport.on("ready", () => {
      this.#loaded.clear();
      void this.#reconcileTracked();
    });
  }

  async connect(): Promise<InitializeResponse> {
    const initialized = await this.transport.connect();
    const binary = this.transport.binaryPath;
    if (!binary) throw new Error("Transport connected without a resolved Codex binary");
    try {
      this.capabilities.applySchemaDetection(await this.#schemaDetector(binary));
    } catch (error) {
      // Keep the declared stable contract usable, but expose the degraded
      // startup classification instead of silently pretending detection ran.
      this.capabilities.recordDetectionFallback(error);
    }
    return initialized;
  }

  async listThreads(params: ThreadListParams = {}): Promise<ThreadListResponse> {
    return await this.#call("thread/list", params);
  }

  async searchThreads(searchTerm: string, params: Omit<ThreadListParams, "searchTerm"> = {}): Promise<ThreadListResponse> {
    return await this.listThreads({ ...params, searchTerm });
  }

  async readThread(threadId: string, includeTurns = true): Promise<CodexThread> {
    const response = await this.#call("thread/read", { threadId, includeTurns });
    this.reducer.rebuild(response.thread);
    return response.thread;
  }

  async startThread(params: ThreadStartParams): Promise<ThreadStartResponse> {
    const response = await this.#call("thread/start", params);
    this.#tracked.add(response.thread.id);
    this.#loaded.add(response.thread.id);
    this.reducer.rebuild(response.thread);
    return response;
  }

  async resumeThread(threadId: string): Promise<ThreadStartResponse> {
    const response = await this.#call("thread/resume", { threadId });
    this.#tracked.add(threadId);
    this.#loaded.add(threadId);
    this.reducer.rebuild(response.thread);
    return response;
  }

  async forkThread(params: ThreadForkParams): Promise<ThreadStartResponse> {
    if (params.lastTurnId) {
      const known = this.reducer.getTurn(params.threadId, params.lastTurnId);
      if (known && !known.completed) throw new Error("Cannot fork from an in-progress turn");
    }
    const response = await this.#call("thread/fork", params);
    this.#tracked.add(response.thread.id);
    this.#loaded.add(response.thread.id);
    this.reducer.rebuild(response.thread);
    return response;
  }

  async setThreadName(threadId: string, name: string): Promise<void> {
    await this.#call("thread/name/set", { threadId, name });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.#call("thread/delete", { threadId });
    this.#tracked.delete(threadId);
    this.#loaded.delete(threadId);
    this.reducer.remove(threadId);
  }

  async startTurn(params: TurnStartParams): Promise<string> {
    await this.#ensureLoaded(params.threadId);
    const response = await this.#call("turn/start", params);
    return response.turn.id;
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.#call("turn/interrupt", { threadId, turnId });
  }

  subscribeStatus(listener: (params: Record<string, unknown>) => void): () => void {
    this.on("status", listener);
    return () => this.off("status", listener);
  }

  subscribeEvents(listener: (notification: AppServerNotification) => void): () => void {
    this.on("notification", listener);
    return () => this.off("notification", listener);
  }

  getThreadState(threadId: string): ReducedThread | null {
    return this.reducer.getThread(threadId);
  }

  getTurnState(threadId: string, turnId: string): ReducedTurn | null {
    return this.reducer.getTurn(threadId, turnId);
  }

  getAggregatedDiff(threadId: string, turnId: string): string | null {
    return this.reducer.getTurn(threadId, turnId)?.aggregateDiff ?? null;
  }

  approveCommand(id: RequestId, decision: CommandApprovalDecision): void {
    this.transport.respond(id, { decision });
  }

  approveFileChange(id: RequestId, decision: FileChangeApprovalDecision): void {
    this.transport.respond(id, { decision });
  }

  grantPermissions(
    id: RequestId,
    permissions: JsonObject,
    scope: "turn" | "session",
    strictAutoReview?: boolean,
  ): void {
    this.transport.respond(id, {
      permissions,
      scope,
      ...(strictAutoReview === undefined ? {} : { strictAutoReview }),
    });
  }

  answerUserInput(id: RequestId, answers: Record<string, string[]>): void {
    this.transport.respond(id, { answers });
  }

  rejectServerRequest(id: RequestId, code: number, message: string, data?: unknown): void {
    this.transport.respondError(id, { code, message, ...(data === undefined ? {} : { data }) });
  }

  async #call<M extends AppServerMethod>(
    method: M,
    params: MethodParams<M>,
  ): Promise<MethodResult<M>> {
    try {
      return await this.transport.request(method, params);
    } catch (error) {
      if (error instanceof AppServerRpcError) this.capabilities.observeRpcFailure(method, error);
      throw error;
    }
  }

  async #reconcileTracked(): Promise<void> {
    for (const threadId of this.#tracked) {
      try {
        await this.#ensureLoaded(threadId);
      } catch (error) {
        this.emit("reconcileError", threadId, error);
      }
    }
  }

  async #ensureLoaded(threadId: string): Promise<void> {
    if (this.#loaded.has(threadId)) return;
    const existing = this.#resumeRequests.get(threadId);
    if (existing) return await existing;
    const request = this.resumeThread(threadId).then(() => undefined);
    this.#resumeRequests.set(threadId, request);
    try {
      await request;
    } finally {
      if (this.#resumeRequests.get(threadId) === request) this.#resumeRequests.delete(threadId);
    }
  }
}
