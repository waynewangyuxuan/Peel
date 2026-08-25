import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { GitCommandError, LocalGitRunner, type GitRunner } from "./git-runner.js";
import type {
  ChangedFileStatus,
  ChangedFileSummary,
  CreatedWorktree,
  CreateWorktreeInput,
  GitContext,
  RecoverableArtifact,
  WorkspaceContext,
  WorkspaceDiffSummary,
  WorkspaceFailureDetails,
  WorkspaceOpenTargets,
} from "./types.js";

export interface GitWorkspaceAdapterOptions {
  runner?: GitRunner;
}

export class GitWorkspaceError extends Error {
  readonly details: WorkspaceFailureDetails;

  constructor(details: WorkspaceFailureDetails) {
    super(`${details.stage}: ${details.cause}`);
    this.name = "GitWorkspaceError";
    this.details = details;
  }
}

interface PorcelainEntry {
  path: string;
  previousPath: string | null;
  status: ChangedFileStatus;
}

export class GitWorkspaceAdapter {
  readonly #runner: GitRunner;

  constructor(options: GitWorkspaceAdapterOptions = {}) {
    this.#runner = options.runner ?? new LocalGitRunner();
  }

  async inspect(cwd: string): Promise<WorkspaceContext> {
    const requestedCwd = cwd;
    let resolvedCwd: string;
    try {
      resolvedCwd = await realpath(resolve(cwd));
    } catch {
      return { gitBacked: false, requestedCwd, resolvedCwd: null, reason: "path-unavailable" };
    }

    let inside;
    try {
      inside = await this.#runner.run(["rev-parse", "--is-inside-work-tree"], {
        cwd: resolvedCwd,
        allowedExitCodes: [0, 128],
      });
    } catch (error) {
      throw workspaceError("validate-repository", "git-unavailable", error, {
        currentWorkspaceCwd: resolvedCwd,
      });
    }
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      return { gitBacked: false, requestedCwd, resolvedCwd, reason: "not-a-worktree" };
    }

    try {
      const [rootResult, commonResult, gitDirResult, branchResult, headResult, statusResult, worktreesResult] =
        await Promise.all([
          this.#runner.run(["rev-parse", "--show-toplevel"], { cwd: resolvedCwd }),
          this.#runner.run(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: resolvedCwd }),
          this.#runner.run(["rev-parse", "--path-format=absolute", "--git-dir"], { cwd: resolvedCwd }),
          this.#runner.run(["symbolic-ref", "--short", "-q", "HEAD"], {
            cwd: resolvedCwd,
            allowedExitCodes: [0, 1],
          }),
          this.#runner.run(["rev-parse", "HEAD"], { cwd: resolvedCwd }),
          this.#runner.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: resolvedCwd }),
          this.#runner.run(["worktree", "list", "--porcelain"], { cwd: resolvedCwd }),
        ]);
      const worktreeRoot = await realpath(rootResult.stdout.trim());
      const mainCandidate = parseWorktreePaths(worktreesResult.stdout)[0];
      if (!mainCandidate) throw new Error("git worktree list returned no main worktree");
      const mainWorktreeRoot = await realpath(mainCandidate);
      return {
        gitBacked: true,
        requestedCwd,
        resolvedCwd,
        worktreeRoot,
        mainWorktreeRoot,
        commonGitDir: resolve(commonResult.stdout.trim()),
        gitDir: resolve(gitDirResult.stdout.trim()),
        isLinkedWorktree: worktreeRoot !== mainWorktreeRoot,
        branch: branchResult.stdout.trim() || null,
        head: headResult.stdout.trim(),
        dirty: statusResult.stdout.length > 0,
      };
    } catch (error) {
      throw workspaceError("validate-repository", "git-inspection-failed", error, {
        currentWorkspaceCwd: resolvedCwd,
      });
    }
  }

  async createWorktree(input: CreateWorktreeInput): Promise<CreatedWorktree> {
    if (!input.pendingForkId.trim()) {
      throw workspaceError("validate-repository", "missing-pending-fork-id", "pendingForkId must not be empty");
    }
    let context: WorkspaceContext;
    try {
      context = await this.inspect(input.repositoryCwd);
    } catch (error) {
      if (error instanceof GitWorkspaceError) {
        throw new GitWorkspaceError({
          ...error.details,
          pendingForkId: input.pendingForkId,
        });
      }
      throw workspaceError("validate-repository", "git-inspection-failed", error, {
        pendingForkId: input.pendingForkId,
      });
    }
    if (!context.gitBacked) {
      throw workspaceError("validate-repository", "not-a-git-worktree", context.reason, {
        pendingForkId: input.pendingForkId,
        currentWorkspaceCwd: context.resolvedCwd,
      });
    }

    const targetParent = await this.#validateTargetParent(input.targetParent, context, input.pendingForkId);
    let baseCommit: string;
    try {
      const requestedBase = input.baseRef ?? "HEAD";
      const resolvedBase = await this.#runner.run(
        ["rev-parse", "--verify", "--end-of-options", `${requestedBase}^{commit}`],
        { cwd: context.worktreeRoot },
      );
      baseCommit = resolvedBase.stdout.trim();
      if (!/^[0-9a-f]{40,64}$/i.test(baseCommit)) throw new Error("Git returned an invalid base commit ID");
    } catch (error) {
      throw workspaceError("allocate-identity", "invalid-base-ref", error, {
        pendingForkId: input.pendingForkId,
        currentWorkspaceCwd: context.worktreeRoot,
      });
    }
    let allocated: { branch: string; path: string };
    try {
      allocated = await this.#allocateIdentity(context, targetParent, input.forkIdentity);
    } catch (error) {
      if (error instanceof GitWorkspaceError) throw error;
      throw workspaceError("allocate-identity", "identity-allocation-failed", error, {
        pendingForkId: input.pendingForkId,
        currentWorkspaceCwd: context.worktreeRoot,
      });
    }

    const retryWith: CreateWorktreeInput = {
      ...input,
      targetParent,
      baseRef: input.baseRef ?? "HEAD",
    };
    try {
      await this.#runner.run(
        ["worktree", "add", "-b", allocated.branch, allocated.path, baseCommit],
        { cwd: context.worktreeRoot },
      );
    } catch (error) {
      const artifacts = await this.#detectArtifacts(context, allocated);
      throw workspaceError("create-worktree", "git-worktree-add-failed", error, {
        pendingForkId: input.pendingForkId,
        currentWorkspaceCwd: context.worktreeRoot,
        attemptedBranch: allocated.branch,
        attemptedPath: allocated.path,
        artifacts,
      });
    }

    let created: WorkspaceContext;
    try {
      created = await this.inspect(allocated.path);
    } catch (error) {
      throw workspaceError("inspect-created-worktree", "created-worktree-unreadable", error, {
        pendingForkId: input.pendingForkId,
        currentWorkspaceCwd: context.worktreeRoot,
        attemptedBranch: allocated.branch,
        attemptedPath: allocated.path,
        artifacts: [
          { kind: "branch", name: allocated.branch },
          { kind: "worktree", path: allocated.path },
        ],
      });
    }
    if (!created.gitBacked || created.worktreeRoot !== allocated.path) {
      throw workspaceError("inspect-created-worktree", "created-worktree-mismatch", "Git returned a different cwd", {
        pendingForkId: input.pendingForkId,
        currentWorkspaceCwd: context.worktreeRoot,
        attemptedBranch: allocated.branch,
        attemptedPath: allocated.path,
        artifacts: [
          { kind: "branch", name: allocated.branch },
          { kind: "worktree", path: allocated.path },
        ],
      });
    }
    return {
      cwd: created.worktreeRoot,
      branch: allocated.branch,
      mainWorktreeRoot: created.mainWorktreeRoot,
      pendingForkId: input.pendingForkId,
      retryWith,
      currentWorkspaceCwd: context.worktreeRoot,
    };
  }

  async getDiffSummary(cwd: string): Promise<WorkspaceDiffSummary> {
    const context = await this.#requireGitContext(cwd, "read-diff");
    try {
      const [statusResult, trackedNumstat] = await Promise.all([
        this.#runner.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
          cwd: context.worktreeRoot,
        }),
        this.#runner.run(["diff", "--numstat", "-z", "HEAD", "--"], { cwd: context.worktreeRoot }),
      ]);
      const entries = parsePorcelain(statusResult.stdout);
      const numstat = parseNumstatZ(trackedNumstat.stdout);
      for (const entry of entries.filter((entry) => entry.status === "untracked")) {
        const absolute = await this.#safeFilePath(context.worktreeRoot, entry.path);
        const result = await this.#runner.run(["diff", "--no-index", "--numstat", "-z", "--", "/dev/null", absolute], {
          cwd: context.worktreeRoot,
          allowedExitCodes: [0, 1],
        });
        const stat = [...parseNumstatZ(result.stdout).values()][0];
        if (stat) numstat.set(entry.path, stat);
      }

      const files: ChangedFileSummary[] = entries.map((entry) => {
        const stat = numstat.get(entry.path);
        return {
          ...entry,
          additions: stat?.additions ?? null,
          deletions: stat?.deletions ?? null,
          binary: stat?.binary ?? false,
        };
      });
      return {
        cwd: context.worktreeRoot,
        changedFileCount: files.length,
        additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
        deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
        binaryFileCount: files.filter((file) => file.binary).length,
        files,
      };
    } catch (error) {
      if (error instanceof GitWorkspaceError) throw error;
      throw workspaceError("read-diff", "diff-summary-failed", error, {
        currentWorkspaceCwd: context.worktreeRoot,
      });
    }
  }

  async getDiff(cwd: string, path?: string): Promise<string> {
    const context = await this.#requireGitContext(cwd, "read-diff");
    try {
      if (!path) {
        const tracked = await this.#runner.run(["diff", "--no-ext-diff", "HEAD", "--"], {
          cwd: context.worktreeRoot,
        });
        const status = await this.getDiffSummary(context.worktreeRoot);
        const untrackedDiffs = await Promise.all(
          status.files
            .filter((file) => file.status === "untracked")
            .map(async (file) => await this.#untrackedDiff(context.worktreeRoot, file.path)),
        );
        return [tracked.stdout, ...untrackedDiffs].filter(Boolean).join("\n");
      }
      const safePath = await this.#safeFilePath(context.worktreeRoot, path);
      const summary = await this.getDiffSummary(context.worktreeRoot);
      const untracked = summary.files.some((file) => file.path === path && file.status === "untracked");
      if (untracked) return await this.#untrackedDiff(context.worktreeRoot, path);
      const result = await this.#runner.run(["diff", "--no-ext-diff", "HEAD", "--", safePath], {
        cwd: context.worktreeRoot,
      });
      return result.stdout;
    } catch (error) {
      if (error instanceof GitWorkspaceError) throw error;
      throw workspaceError("read-diff", "diff-read-failed", error, {
        currentWorkspaceCwd: context.worktreeRoot,
      });
    }
  }

  async getOpenTargets(cwd: string, options: { path?: string; threadId?: string } = {}): Promise<WorkspaceOpenTargets> {
    const context = await this.#requireGitContext(cwd, "validate-repository");
    const path = options.path ? await this.#safeFilePath(context.worktreeRoot, options.path) : null;
    return {
      worktree: { kind: "worktree", path: context.worktreeRoot },
      editor: { kind: "editor", cwd: context.worktreeRoot, path },
      codex: { kind: "codex", cwd: context.worktreeRoot, threadId: options.threadId ?? null },
    };
  }

  async #requireGitContext(cwd: string, stage: WorkspaceFailureDetails["stage"]): Promise<GitContext> {
    const context = await this.inspect(cwd);
    if (context.gitBacked) return context;
    throw workspaceError(stage, "not-a-git-worktree", context.reason, {
      currentWorkspaceCwd: context.resolvedCwd,
    });
  }

  async #validateTargetParent(
    input: string,
    context: GitContext,
    pendingForkId: string,
  ): Promise<string> {
    try {
      if (!isAbsolute(input)) throw new Error("targetParent must be an absolute path");
      const parent = await realpath(input);
      const stats = await lstat(parent);
      if (!stats.isDirectory()) throw new Error("targetParent is not a directory");
      const root = parse(parent).root;
      const userHome = await realpath(homedir()).catch(() => homedir());
      if (parent === root || parent === userHome) throw new Error("targetParent is too broad");
      if (parent === context.worktreeRoot || parent === context.mainWorktreeRoot) {
        throw new Error("targetParent cannot be a repository checkout root");
      }
      return parent;
    } catch (error) {
      throw workspaceError("validate-target-parent", "unsafe-target-parent", error, {
        pendingForkId,
        currentWorkspaceCwd: context.worktreeRoot,
      });
    }
  }

  async #allocateIdentity(context: GitContext, targetParent: string, forkIdentity: string): Promise<{ branch: string; path: string }> {
    const slug = slugify(forkIdentity);
    for (let suffix = 1; suffix <= 1_000; suffix += 1) {
      const unique = suffix === 1 ? slug : `${slug}-${suffix}`;
      const branch = `peel/${unique}`;
      const path = join(targetParent, unique);
      if (dirname(path) !== targetParent) throw new Error("allocated path escaped target parent");
      const [branchCheck, branchExists, pathExists] = await Promise.all([
        this.#runner.run(["check-ref-format", "--branch", branch], { cwd: context.worktreeRoot }),
        this.#runner.run(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
          cwd: context.worktreeRoot,
          allowedExitCodes: [0, 1],
        }),
        lstat(path).then(
          () => true,
          () => false,
        ),
      ]);
      void branchCheck;
      if (branchExists.exitCode !== 0 && !pathExists) return { branch, path };
    }
    throw new Error("could not allocate a unique branch/worktree identity after 1000 attempts");
  }

  async #detectArtifacts(context: GitContext, allocated: { branch: string; path: string }): Promise<RecoverableArtifact[]> {
    const artifacts: RecoverableArtifact[] = [];
    try {
      const branch = await this.#runner.run(["show-ref", "--verify", "--quiet", `refs/heads/${allocated.branch}`], {
        cwd: context.worktreeRoot,
        allowedExitCodes: [0, 1],
      });
      if (branch.exitCode === 0) artifacts.push({ kind: "branch", name: allocated.branch });
    } catch {
      // Absence of proof is not reported as a recoverable artifact.
    }
    try {
      const worktrees = await this.#runner.run(["worktree", "list", "--porcelain"], { cwd: context.worktreeRoot });
      const registered = parseWorktreePaths(worktrees.stdout)
        .map((path) => resolve(path))
        .includes(resolve(allocated.path));
      if (registered) {
        artifacts.push({ kind: "worktree", path: allocated.path });
      } else if (await lstat(allocated.path).then(() => true, () => false)) {
        artifacts.push({ kind: "directory", path: allocated.path });
      }
    } catch {
      // Preserve only artifacts we can resolve exactly.
    }
    return artifacts;
  }

  async #safeFilePath(root: string, input: string): Promise<string> {
    const target = resolve(root, input);
    const rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw workspaceError("read-diff", "unsafe-file-path", `Path is outside worktree or names the whole root: ${input}`, {
        currentWorkspaceCwd: root,
      });
    }
    let resolvedTarget: string;
    try {
      resolvedTarget = await realpath(target);
    } catch {
      try {
        resolvedTarget = join(await realpath(dirname(target)), basename(target));
      } catch (error) {
        throw workspaceError("read-diff", "unsafe-file-path", error, {
          currentWorkspaceCwd: root,
        });
      }
    }
    const resolvedRelative = relative(root, resolvedTarget);
    if (
      resolvedRelative === ".." ||
      resolvedRelative.startsWith(`..${sep}`) ||
      isAbsolute(resolvedRelative)
    ) {
      throw workspaceError("read-diff", "unsafe-file-path", `Resolved path escapes worktree: ${input}`, {
        currentWorkspaceCwd: root,
      });
    }
    return target;
  }

  async #untrackedDiff(root: string, path: string): Promise<string> {
    const target = await this.#safeFilePath(root, path);
    const result = await this.#runner.run(["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", target], {
      cwd: root,
      allowedExitCodes: [0, 1],
    });
    return result.stdout;
  }
}

function parseWorktreePaths(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "fork";
}

function statusFromCode(code: string): ChangedFileStatus {
  if (code === "??") return "untracked";
  if (code.includes("U") || code === "AA" || code === "DD") return "unmerged";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  if (code.includes("M")) return "modified";
  return "unknown";
}

function parsePorcelain(output: string): PorcelainEntry[] {
  const records = output.split("\0");
  const entries: PorcelainEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    let previousPath: string | null = null;
    if (code.includes("R") || code.includes("C")) previousPath = records[++index] || null;
    entries.push({ path, previousPath, status: statusFromCode(code) });
  }
  return entries;
}

function parseNumstatZ(output: string): Map<string, { additions: number | null; deletions: number | null; binary: boolean }> {
  const result = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
  let cursor = 0;
  while (cursor < output.length) {
    const addedEnd = output.indexOf("\t", cursor);
    if (addedEnd < 0) break;
    const deletedEnd = output.indexOf("\t", addedEnd + 1);
    if (deletedEnd < 0) break;
    const pathEnd = output.indexOf("\0", deletedEnd + 1);
    if (pathEnd < 0) break;
    const added = output.slice(cursor, addedEnd);
    const deleted = output.slice(addedEnd + 1, deletedEnd);
    let path = output.slice(deletedEnd + 1, pathEnd);
    cursor = pathEnd + 1;
    if (!path) {
      const previousEnd = output.indexOf("\0", cursor);
      if (previousEnd < 0) break;
      const nextEnd = output.indexOf("\0", previousEnd + 1);
      if (nextEnd < 0) break;
      path = output.slice(previousEnd + 1, nextEnd);
      cursor = nextEnd + 1;
    }
    if (!added || !deleted || !path) continue;
    const binary = added === "-" || deleted === "-";
    result.set(path, {
      additions: binary ? null : Number.parseInt(added, 10),
      deletions: binary ? null : Number.parseInt(deleted, 10),
      binary,
    });
  }
  return result;
}

function workspaceError(
  stage: WorkspaceFailureDetails["stage"],
  code: string,
  cause: unknown,
  overrides: Partial<Omit<WorkspaceFailureDetails, "stage" | "code" | "cause">> = {},
): GitWorkspaceError {
  const causeText =
    cause instanceof GitCommandError
      ? cause.stderr.trim() || cause.message
      : cause instanceof Error
        ? cause.message
        : String(cause);
  return new GitWorkspaceError({
    code,
    stage,
    retryable: true,
    pendingForkId: null,
    currentWorkspaceCwd: null,
    attemptedBranch: null,
    attemptedPath: null,
    artifacts: [],
    cause: causeText,
    ...overrides,
  });
}
