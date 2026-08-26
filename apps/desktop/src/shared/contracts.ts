import type {
  AppServerNotification,
  AppServerServerRequest,
  CodexThread,
  ReducedThread,
  ThreadListResponse,
  UserInput,
} from "@peel/codex-app-server";
import type { WorkspaceContext, WorkspaceDiffSummary } from "@peel/git-workspace";

export type ViewMode = "focus" | "overview";
export type TitleOrigin = "temporary" | "automatic" | "manual";
export type NodeStatus = "idle" | "active" | "waiting" | "error";

export interface Point {
  x: number;
  y: number;
}

export interface CameraState extends Point {
  scale: number;
}

export interface SpaceNode {
  threadId: string;
  parentThreadId: string | null;
  forkedAtTurnId: string | null;
  createdAt: number;
  position: Point;
  title: string;
  titleOrigin: TitleOrigin;
  cwd: string;
  worktreeName: string | null;
  lastViewedTurnId: string | null;
}

export interface SpaceRecord {
  id: string;
  name: string;
  rootThreadId: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  nodes: Record<string, SpaceNode>;
  camera: CameraState;
}

export interface ThreadViewState {
  draft: string;
  scrollTop: number;
}

export interface PeelState {
  version: 1;
  activeSpaceId: string | null;
  activeThreadId: string | null;
  viewMode: ViewMode;
  spaces: Record<string, SpaceRecord>;
  threadViews: Record<string, ThreadViewState>;
}

export interface ForkDraft {
  pendingForkId: string;
  parentThreadId: string;
  forkedAtTurnId: string;
  createdAt: number;
  position: Point;
  prompt: string;
  createWorktree: boolean;
  preparedWorktree?: { cwd: string; name: string };
  preparedFork?: { threadId: string; cwd: string; worktreeName: string | null };
}

export interface ThreadSnapshot {
  thread: CodexThread;
  reduced: ReducedThread | null;
}

export interface BootstrapPayload {
  state: PeelState;
  connected: boolean;
  connectionError: string | null;
  capabilities: Record<string, unknown>;
}

export interface StartSpaceInput {
  threadId: string;
  name?: string;
}

export interface CommitForkInput {
  spaceId: string;
  draft: ForkDraft;
  input: UserInput[];
}

export interface CommitForkSuccess {
  ok: true;
  threadId: string;
  turnId: string;
  cwd: string;
  worktreeName: string | null;
  persistenceWarning?: string;
}

export interface CommitForkFailure {
  ok: false;
  stage: "worktree" | "fork" | "turn" | "persist";
  message: string;
  retryable: boolean;
  prompt: string;
  pendingForkId: string;
  recoverableArtifacts: Array<{ kind: string; name?: string; path?: string }>;
  childThreadId?: string;
  preparedWorktree?: { cwd: string; name: string };
  preparedFork?: { threadId: string; cwd: string; worktreeName: string | null };
}

export type CommitForkResult = CommitForkSuccess | CommitForkFailure;

export interface SendTurnInput {
  threadId: string;
  input: UserInput[];
  cwd?: string;
}

export interface ApprovalDecisionInput {
  id: number | string;
  method: string;
  decision: "accept" | "acceptForSession" | "decline" | "cancel";
}

export interface OpenTargetInput {
  kind: "worktree" | "editor" | "codex";
  cwd: string;
  threadId?: string;
  path?: string;
}

export interface VoiceTranscription {
  text: string;
  isFinal: true;
}

export const THREAD_SEARCH_PAGE_SIZE = 30;
export const THREAD_SEARCH_CACHE_TTL_MS = 15_000;

export interface SearchThreadsInput {
  term: string;
  cursor?: string | null;
}

export interface PeelApi {
  bootstrap(): Promise<BootstrapPayload>;
  searchThreads(input: SearchThreadsInput): Promise<ThreadListResponse>;
  readThread(threadId: string): Promise<ThreadSnapshot>;
  startSpace(input: StartSpaceInput): Promise<PeelState>;
  saveState(state: PeelState): Promise<PeelState>;
  sendTurn(input: SendTurnInput): Promise<{ turnId: string }>;
  commitFork(input: CommitForkInput): Promise<CommitForkResult>;
  setThreadName(threadId: string, name: string, spaceId: string): Promise<PeelState>;
  getWorkspace(cwd: string): Promise<WorkspaceContext>;
  getDiff(cwd: string): Promise<{ summary: WorkspaceDiffSummary; patch: string }>;
  openTarget(input: OpenTargetInput): Promise<void>;
  copyText(text: string): Promise<void>;
  transcribeWav(bytes: ArrayBuffer): Promise<VoiceTranscription>;
  decideApproval(input: ApprovalDecisionInput): Promise<void>;
  onCodexNotification(listener: (notification: AppServerNotification) => void): () => void;
  onServerRequest(listener: (request: AppServerServerRequest) => void): () => void;
  onConnection(listener: (payload: { connected: boolean; error: string | null }) => void): () => void;
  onFlushRequest(listener: () => Promise<void>): () => void;
}

export const IPC = {
  bootstrap: "peel:bootstrap",
  searchThreads: "peel:threads:search",
  readThread: "peel:thread:read",
  startSpace: "peel:space:start",
  saveState: "peel:state:save",
  sendTurn: "peel:turn:send",
  commitFork: "peel:fork:commit",
  setThreadName: "peel:thread:name",
  getWorkspace: "peel:workspace:inspect",
  getDiff: "peel:workspace:diff",
  openTarget: "peel:open",
  copyText: "peel:clipboard:write",
  transcribeWav: "peel:voice:transcribe",
  decideApproval: "peel:approval:decide",
  codexNotification: "peel:event:codex",
  serverRequest: "peel:event:server-request",
  connection: "peel:event:connection",
  flushRequest: "peel:event:flush-request",
  flushComplete: "peel:event:flush-complete",
} as const;
