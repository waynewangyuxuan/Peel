/**
 * Peel's deliberately small structural view of the Codex App Server 0.149
 * schema. The live schema check guards method drift; unknown Item fields and
 * types remain lossless instead of being discarded by the adapter.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type RequestId = number | string;

export type ThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";
export type ThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: ThreadActiveFlag[] };

export type TurnStatus = "inProgress" | "completed" | "failed" | "interrupted";

export interface ThreadItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

export interface CodexTurn {
  id: string;
  items: ThreadItem[];
  itemsView?: unknown;
  status: TurnStatus | string;
  error: unknown | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export interface CodexThread {
  id: string;
  sessionId: string;
  forkedFromId: string | null;
  parentThreadId: string | null;
  preview: string;
  ephemeral: boolean;
  projectId: string | null;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
  status: ThreadStatus;
  path: string | null;
  cwd: string;
  cliVersion: string;
  source: unknown;
  threadSource: unknown | null;
  agentNickname: string | null;
  agentRole: string | null;
  gitInfo: unknown | null;
  name: string | null;
  turns: CodexTurn[];
  [key: string]: unknown;
}

export type UserInput =
  | { type: "text"; text: string; text_elements: unknown[] }
  | { type: "image"; url: string; detail?: string }
  | { type: "localImage"; path: string; detail?: string }
  | { type: "audio"; url: string }
  | { type: "localAudio"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export interface ThreadListParams {
  cursor?: string | null;
  limit?: number | null;
  sortKey?: string | null;
  sortDirection?: "asc" | "desc" | null;
  modelProviders?: string[] | null;
  sourceKinds?: string[] | null;
  archived?: boolean | null;
  sectionId?: string | null;
  cwd?: string | string[] | null;
  useStateDbOnly?: boolean;
  searchTerm?: string | null;
}

export interface ThreadListResponse {
  data: CodexThread[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface ThreadStartParams {
  model?: string | null;
  modelProvider?: string | null;
  serviceTier?: string | null;
  cwd?: string | null;
  approvalPolicy?: "untrusted" | "on-request" | "never" | JsonObject | null;
  approvalsReviewer?: string | null;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access" | null;
  config?: JsonObject | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
  personality?: string | null;
  [key: string]: unknown;
}

export interface ThreadStartResponse {
  thread: CodexThread;
  model: string;
  modelProvider: string;
  serviceTier: string | null;
  cwd: string;
  instructionSources: string[];
  approvalPolicy: unknown;
  approvalsReviewer: unknown;
  sandbox: unknown;
  reasoningEffort: unknown | null;
}

export interface ThreadForkParams extends ThreadStartParams {
  threadId: string;
  lastTurnId?: string | null;
}

export interface ThreadResumeParams extends ThreadStartParams {
  threadId: string;
}

export interface TurnStartParams {
  threadId: string;
  clientUserMessageId?: string | null;
  input: UserInput[];
  cwd?: string | null;
  approvalPolicy?: "untrusted" | "on-request" | "never" | JsonObject | null;
  approvalsReviewer?: string | null;
  sandboxPolicy?: JsonObject | null;
  model?: string | null;
  serviceTier?: string | null;
  effort?: string | null;
  summary?: string | null;
  personality?: string | null;
  outputSchema?: JsonValue | null;
}

export interface RealtimeAudioChunk {
  data: string;
  sampleRate: number;
  numChannels: number;
  samplesPerChannel: number | null;
  itemId: string | null;
}

export interface ThreadRealtimeStartParams {
  threadId: string;
  clientManagedHandoffs?: boolean | null;
  flushTranscriptTailOnSessionEnd?: boolean | null;
  codexResponsesAsItems?: boolean | null;
  outputModality: "text" | "audio";
  includeStartupContext?: boolean | null;
  realtimeStartInstructions?: string | null;
  realtimeEndInstructions?: string | null;
  prompt?: string | null;
  version?: "v1" | "v2" | "v3" | null;
}

export interface ThreadRealtimeTranscriptDelta {
  threadId: string;
  role: string;
  delta: string;
}

export interface ThreadRealtimeTranscriptDone {
  threadId: string;
  role: string;
  text: string;
}

export interface InitializeParams {
  clientInfo: { name: string; title: string | null; version: string };
  capabilities: {
    experimentalApi: boolean;
    requestAttestation: boolean;
    optOutNotificationMethods?: string[] | null;
    extensions?: Record<string, JsonValue> | null;
  } | null;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export interface AppServerMethodMap {
  initialize: { params: InitializeParams; result: InitializeResponse };
  "thread/list": { params: ThreadListParams; result: ThreadListResponse };
  "thread/read": {
    params: { threadId: string; includeTurns?: boolean };
    result: { thread: CodexThread };
  };
  "thread/start": { params: ThreadStartParams; result: ThreadStartResponse };
  "thread/resume": { params: ThreadResumeParams; result: ThreadStartResponse };
  "thread/fork": { params: ThreadForkParams; result: ThreadStartResponse };
  "thread/name/set": {
    params: { threadId: string; name: string };
    result: Record<string, never>;
  };
  "thread/delete": {
    params: { threadId: string };
    result: Record<string, never>;
  };
  "turn/start": { params: TurnStartParams; result: { turn: CodexTurn } };
  "turn/interrupt": {
    params: { threadId: string; turnId: string };
    result: Record<string, never>;
  };
  "thread/realtime/start": {
    params: ThreadRealtimeStartParams;
    result: Record<string, never>;
  };
  "thread/realtime/appendAudio": {
    params: { threadId: string; audio: RealtimeAudioChunk };
    result: Record<string, never>;
  };
  "thread/realtime/stop": {
    params: { threadId: string };
    result: Record<string, never>;
  };
}

export type AppServerMethod = keyof AppServerMethodMap;
export type MethodParams<M extends AppServerMethod> = AppServerMethodMap[M]["params"];
export type MethodResult<M extends AppServerMethod> = AppServerMethodMap[M]["result"];

export interface AppServerNotification<P = Record<string, unknown>> {
  method: string;
  params: P;
  emittedAtMs?: number;
}

export interface AppServerServerRequest<P = Record<string, unknown>> {
  id: RequestId;
  method: string;
  params: P;
}

export interface RpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

export type CommandApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel"
  | JsonObject;
export type FileChangeApprovalDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";
