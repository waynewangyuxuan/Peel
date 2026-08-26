export interface NonGitContext {
  gitBacked: false;
  requestedCwd: string;
  resolvedCwd: string | null;
  reason: "path-unavailable" | "not-a-worktree";
}

export interface GitContext {
  gitBacked: true;
  requestedCwd: string;
  resolvedCwd: string;
  worktreeRoot: string;
  mainWorktreeRoot: string;
  commonGitDir: string;
  gitDir: string;
  isLinkedWorktree: boolean;
  branch: string | null;
  head: string;
  dirty: boolean;
}

export type WorkspaceContext = NonGitContext | GitContext;

export type WorkspaceFailureStage =
  | "resolve-cwd"
  | "validate-repository"
  | "validate-target-parent"
  | "allocate-identity"
  | "create-worktree"
  | "inspect-created-worktree"
  | "read-diff";

export interface RecoverableArtifact {
  kind: "branch" | "worktree" | "directory";
  name?: string;
  path?: string;
}

export interface WorkspaceFailureDetails {
  code: string;
  stage: WorkspaceFailureStage;
  retryable: boolean;
  pendingForkId: string | null;
  currentWorkspaceCwd: string | null;
  attemptedBranch: string | null;
  attemptedPath: string | null;
  artifacts: RecoverableArtifact[];
  cause: string;
}

export interface CreateWorktreeInput {
  repositoryCwd: string;
  targetParent: string;
  forkIdentity: string;
  pendingForkId: string;
  baseRef?: string;
}

export interface CreatedWorktree {
  cwd: string;
  branch: string;
  mainWorktreeRoot: string;
  pendingForkId: string;
  retryWith: CreateWorktreeInput;
  currentWorkspaceCwd: string;
}

export type ChangedFileStatus =
  | "untracked"
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "unmerged"
  | "unknown";

export interface ChangedFileSummary {
  path: string;
  previousPath: string | null;
  status: ChangedFileStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface WorkspaceDiffSummary {
  cwd: string;
  baseBranch: string;
  baseCommit: string;
  changedFileCount: number;
  additions: number;
  deletions: number;
  binaryFileCount: number;
  files: ChangedFileSummary[];
}

export interface WorkspaceOpenTargets {
  worktree: { kind: "worktree"; path: string };
  editor: { kind: "editor"; cwd: string; path: string | null };
  codex: { kind: "codex"; cwd: string; threadId: string | null };
}
