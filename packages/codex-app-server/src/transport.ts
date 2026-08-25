import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { delimiter, isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";

import type {
  AppServerMethod,
  AppServerNotification,
  AppServerServerRequest,
  InitializeParams,
  InitializeResponse,
  MethodParams,
  MethodResult,
  RequestId,
  RpcErrorShape,
} from "./protocol.js";

export type TransportState =
  | "idle"
  | "starting"
  | "ready"
  | "reconnecting"
  | "stopping"
  | "stopped"
  | "failed";

export interface ProcessLike extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
}

export type ProcessFactory = (binary: string, args: string[], env: NodeJS.ProcessEnv) => ProcessLike;

export interface TransportOptions {
  codexBinary?: string;
  env?: NodeJS.ProcessEnv;
  initialize?: Partial<InitializeParams>;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  reconnect?: boolean;
  reconnectDelayMs?: number;
  processFactory?: ProcessFactory;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
  timer: NodeJS.Timeout;
  removeAbort?: () => void;
}

interface RpcResponse {
  id: RequestId;
  result?: unknown;
  error?: RpcErrorShape;
}

export class AppServerRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: RpcErrorShape) {
    super(error.message);
    this.name = "AppServerRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

export class AppServerDisconnectedError extends Error {
  constructor(message = "Codex App Server disconnected") {
    super(message);
    this.name = "AppServerDisconnectedError";
  }
}

export class AppServerRequestAbortedError extends Error {
  constructor(method: string) {
    super(`Request aborted locally: ${method}`);
    this.name = "AppServerRequestAbortedError";
  }
}

const DEFAULT_INITIALIZE: InitializeParams = {
  clientInfo: { name: "peel", title: "Peel", version: "0.1.0" },
  capabilities: {
    experimentalApi: false,
    requestAttestation: false,
  },
};

const SAFE_ENV_KEYS = [
  "HOME",
  "CODEX_HOME",
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "USER",
  "LOGNAME",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
] as const;

export function allowlistedEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCodexBinary(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error("codexBinary must be an absolute path");
    if (!(await executable(explicit))) throw new Error(`Codex binary is not executable: ${explicit}`);
    return explicit;
  }

  const candidates = [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    ...(env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((entry) => `${entry}/codex`),
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (await executable(candidate)) return candidate;
  }
  throw new Error("Could not locate an executable Codex binary");
}

function defaultProcessFactory(binary: string, args: string[], env: NodeJS.ProcessEnv): ProcessLike {
  return spawn(binary, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

function mergeInitialize(overrides: Partial<InitializeParams> | undefined): InitializeParams {
  return {
    clientInfo: { ...DEFAULT_INITIALIZE.clientInfo, ...overrides?.clientInfo },
    capabilities: overrides?.capabilities
      ? { ...DEFAULT_INITIALIZE.capabilities, ...overrides.capabilities }
      : DEFAULT_INITIALIZE.capabilities,
  };
}

export class AppServerTransport extends EventEmitter {
  readonly #options: Required<
    Pick<TransportOptions, "requestTimeoutMs" | "shutdownTimeoutMs" | "reconnect" | "reconnectDelayMs">
  > &
    TransportOptions;
  readonly #pending = new Map<RequestId, PendingRequest>();
  #process: ProcessLike | null = null;
  #state: TransportState = "idle";
  #nextId = 1;
  #buffer = "";
  #binary: string | null = null;
  #intentionalStop = false;
  #reconnectTimer: NodeJS.Timeout | null = null;

  constructor(options: TransportOptions = {}) {
    super();
    this.#options = {
      requestTimeoutMs: 30_000,
      shutdownTimeoutMs: 2_000,
      reconnect: true,
      reconnectDelayMs: 250,
      ...options,
    };
  }

  get state(): TransportState {
    return this.#state;
  }

  get initializeParams(): InitializeParams {
    return mergeInitialize(this.#options.initialize);
  }

  get binaryPath(): string | null {
    return this.#binary;
  }

  async connect(): Promise<InitializeResponse> {
    if (this.#state === "ready") throw new Error("Codex App Server is already connected");
    if (this.#state === "starting" || this.#state === "reconnecting") {
      return await new Promise<InitializeResponse>((resolve, reject) => {
        const onReady = (response: InitializeResponse): void => {
          cleanup();
          resolve(response);
        };
        const onFailed = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const cleanup = (): void => {
          this.off("ready", onReady);
          this.off("failed", onFailed);
        };
        this.once("ready", onReady);
        this.once("failed", onFailed);
      });
    }

    this.#intentionalStop = false;
    this.#setState("starting");
    try {
      this.#binary ??= await resolveCodexBinary(this.#options.codexBinary, this.#options.env);
      return await this.#spawnAndInitialize();
    } catch (error) {
      this.#setState("failed");
      this.emit("failed", error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async request<M extends AppServerMethod>(
    method: M,
    params: MethodParams<M>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<MethodResult<M>> {
    return (await this.requestRaw(method, params, options)) as MethodResult<M>;
  }

  async requestRaw(
    method: string,
    params: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (this.#state !== "ready" && method !== "initialize") {
      throw new AppServerDisconnectedError(`Cannot call ${method} while transport is ${this.#state}`);
    }
    if (!this.#process) throw new AppServerDisconnectedError();
    if (options.signal?.aborted) throw new AppServerRequestAbortedError(method);

    const id = this.#nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs;
      const timer = setTimeout(() => {
        this.#settlePending(id, new Error(`Request timed out after ${timeoutMs} ms: ${method}`));
      }, timeoutMs);
      const pending: PendingRequest = { method, resolve, reject, timer };
      if (options.signal) {
        const onAbort = (): void => this.#settlePending(id, new AppServerRequestAbortedError(method));
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
      }
      this.#pending.set(id, pending);
      this.#write({ id, method, params });
    });
  }

  notify(method: string, params: unknown = {}): void {
    if (!this.#process) throw new AppServerDisconnectedError();
    this.#write({ method, params });
  }

  respond(id: RequestId, result: unknown): void {
    if (this.#state !== "ready" || !this.#process) throw new AppServerDisconnectedError();
    this.#write({ id, result });
  }

  respondError(id: RequestId, error: RpcErrorShape): void {
    if (this.#state !== "ready" || !this.#process) throw new AppServerDisconnectedError();
    this.#write({ id, error });
  }

  async shutdown(): Promise<void> {
    this.#intentionalStop = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#setState("stopping");
    const child = this.#process;
    if (!child) {
      this.#setState("stopped");
      return;
    }

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        resolve();
      };
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish();
      }, this.#options.shutdownTimeoutMs);
      child.once("exit", finish);
      child.kill("SIGTERM");
    });
    this.#rejectAll(new AppServerDisconnectedError("Codex App Server was shut down"));
    this.#process = null;
    this.#setState("stopped");
  }

  async #spawnAndInitialize(): Promise<InitializeResponse> {
    const factory = this.#options.processFactory ?? defaultProcessFactory;
    const child = factory(
      this.#binary ?? (() => { throw new Error("Codex binary was not resolved"); })(),
      ["app-server", "--stdio"],
      allowlistedEnvironment(this.#options.env),
    );
    this.#process = child;
    this.#buffer = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#consume(chunk));
    child.stderr.on("data", (chunk: string) => this.emit("stderr", chunk));
    child.once("error", (error) => this.#handleExit(error));
    child.once("exit", (code, signal) => {
      this.#handleExit(
        new AppServerDisconnectedError(
          `Codex App Server exited (${code === null ? "no code" : code}${signal ? `, ${signal}` : ""})`,
        ),
      );
    });

    const response = (await this.requestRaw("initialize", this.initializeParams)) as InitializeResponse;
    this.notify("initialized", {});
    this.#setState("ready");
    this.emit("ready", response);
    return response;
  }

  #write(message: unknown): void {
    const serialized = `${JSON.stringify(message)}\n`;
    this.#process?.stdin.write(serialized, (error?: Error | null) => {
      if (error) this.emit("protocolError", error);
    });
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      try {
        this.#route(JSON.parse(line) as Record<string, unknown>);
      } catch (error) {
        this.emit("protocolError", error instanceof Error ? error : new Error(String(error)), line);
      }
    }
  }

  #route(message: Record<string, unknown>): void {
    if ((typeof message.id === "number" || typeof message.id === "string") && "method" in message) {
      this.emit("serverRequest", message as unknown as AppServerServerRequest);
      return;
    }
    if ((typeof message.id === "number" || typeof message.id === "string") && ("result" in message || "error" in message)) {
      const response = message as unknown as RpcResponse;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      if (response.error) this.#settlePending(response.id, new AppServerRpcError(response.error));
      else this.#settlePending(response.id, undefined, response.result);
      return;
    }
    if (typeof message.method === "string") {
      this.emit("notification", message as unknown as AppServerNotification);
      return;
    }
    this.emit("protocolError", new Error("Unrecognized App Server message"), message);
  }

  #settlePending(id: RequestId, error?: unknown, value?: unknown): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.removeAbort?.();
    if (error !== undefined) pending.reject(error);
    else pending.resolve(value);
  }

  #rejectAll(error: Error): void {
    for (const id of [...this.#pending.keys()]) this.#settlePending(id, error);
  }

  #handleExit(error: Error): void {
    if (!this.#process) return;
    this.#process = null;
    this.#rejectAll(error);
    if (this.#intentionalStop) return;
    this.emit("disconnected", error);
    if (!this.#options.reconnect) {
      this.#setState("failed");
      this.emit("failed", error);
      return;
    }
    this.#setState("reconnecting");
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#spawnAndInitialize().catch((reconnectError: unknown) => {
        const normalized = reconnectError instanceof Error ? reconnectError : new Error(String(reconnectError));
        this.#setState("failed");
        this.emit("failed", normalized);
      });
    }, this.#options.reconnectDelayMs);
  }

  #setState(state: TransportState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.emit("state", state);
  }
}
