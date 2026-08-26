import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { parse } from "node:path";
import test from "node:test";

import { GitWorkspaceAdapter, GitWorkspaceError } from "../src/adapter.js";
import { GitCommandError, LocalGitRunner, type GitRunOptions, type GitRunResult, type GitRunner } from "../src/git-runner.js";
import { git, temporaryRepository } from "./fixtures.js";

test("detects main checkout and linked worktree identity without mutation", async () => {
  const fixture = await temporaryRepository();
  try {
    const adapter = new GitWorkspaceAdapter();
    const before = git(["status", "--porcelain"], fixture.repository);
    const main = await adapter.inspect(fixture.repository);
    assert.equal(main.gitBacked, true);
    if (!main.gitBacked) return;
    assert.equal(main.isLinkedWorktree, false);
    assert.equal(main.worktreeRoot, fixture.repository);
    assert.equal(main.mainWorktreeRoot, fixture.repository);
    assert.equal(main.branch, git(["branch", "--show-current"], fixture.repository).trim());
    assert.equal(main.dirty, false);
    assert.equal(git(["status", "--porcelain"], fixture.repository), before);

    const created = await adapter.createWorktree({
      repositoryCwd: fixture.repository,
      targetParent: fixture.worktrees,
      forkIdentity: "Inspect Context",
      pendingForkId: "draft-main",
    });
    const linked = await adapter.inspect(created.cwd);
    assert.equal(linked.gitBacked, true);
    if (!linked.gitBacked) return;
    assert.equal(linked.isLinkedWorktree, true);
    assert.equal(linked.mainWorktreeRoot, fixture.repository);
    assert.equal(linked.branch, created.branch);
    assert.equal(linked.commonGitDir, main.commonGitDir);
  } finally {
    await fixture.cleanup();
  }
});

test("creates unique branch/worktree identities when names collide", async () => {
  const fixture = await temporaryRepository();
  try {
    const adapter = new GitWorkspaceAdapter();
    const input = {
      repositoryCwd: fixture.repository,
      targetParent: fixture.worktrees,
      forkIdentity: "Same Fork",
      pendingForkId: "draft-collision",
    };
    const first = await adapter.createWorktree(input);
    const second = await adapter.createWorktree(input);
    assert.equal(first.branch, "peel/same-fork");
    assert.equal(second.branch, "peel/same-fork-2");
    assert.notEqual(first.cwd, second.cwd);
    assert.equal(second.pendingForkId, input.pendingForkId);
    assert.equal(second.retryWith.pendingForkId, input.pendingForkId);
  } finally {
    await fixture.cleanup();
  }
});

test("reports dirty file counts, additions/deletions, full/file diffs, and open targets", async () => {
  const fixture = await temporaryRepository();
  try {
    await writeFile(`${fixture.repository}/README.md`, "two\n", "utf8");
    await writeFile(`${fixture.repository}/new file.txt`, "new\n", "utf8");
    const adapter = new GitWorkspaceAdapter();
    const context = await adapter.inspect(fixture.repository);
    assert.equal(context.gitBacked && context.dirty, true);

    const summary = await adapter.getDiffSummary(fixture.repository);
    assert.equal(summary.changedFileCount, 2);
    assert.equal(summary.additions, 2);
    assert.equal(summary.deletions, 1);
    assert.deepEqual(
      summary.files.map((file) => [file.path, file.status]),
      [
        ["README.md", "modified"],
        ["new file.txt", "untracked"],
      ],
    );
    assert.match(await adapter.getDiff(fixture.repository), /new file\.txt/);
    assert.match(await adapter.getDiff(fixture.repository, "README.md"), /-one/);
    assert.match(await adapter.getDiff(fixture.repository, "new file.txt"), /\+new/);

    const targets = await adapter.getOpenTargets(fixture.repository, {
      path: "README.md",
      threadId: "thread-123",
    });
    assert.equal(targets.worktree.path, fixture.repository);
    assert.equal(targets.editor.path, `${fixture.repository}/README.md`);
    assert.deepEqual(targets.codex, { kind: "codex", cwd: fixture.repository, threadId: "thread-123" });
  } finally {
    await fixture.cleanup();
  }
});

test("uses main for divergent-branch Diff and default Worktree ancestry", async () => {
  const fixture = await temporaryRepository();
  try {
    const mainCommit = git(["rev-parse", "refs/heads/main"], fixture.repository).trim();
    git(["switch", "-q", "-c", "codex/ticket-baseline"], fixture.repository);
    await writeFile(`${fixture.repository}/committed.txt`, "committed ticket work\n", "utf8");
    git(["add", "committed.txt"], fixture.repository);
    git(
      ["-c", "user.name=Peel Test", "-c", "user.email=test@peel.invalid", "commit", "-qm", "ticket work"],
      fixture.repository,
    );
    const ticketCommit = git(["rev-parse", "HEAD"], fixture.repository).trim();
    git(["mv", "README.md", "RENAMED.md"], fixture.repository);
    await writeFile(`${fixture.repository}/staged.txt`, "staged work\n", "utf8");
    await writeFile(`${fixture.repository}/binary.bin`, Buffer.from([0, 1, 2, 3]));
    git(["add", "staged.txt", "binary.bin"], fixture.repository);
    await writeFile(`${fixture.repository}/tracked.txt`, "unstaged work\n", "utf8");
    await writeFile(`${fixture.repository}/untracked.txt`, "untracked work\n", "utf8");

    const adapter = new GitWorkspaceAdapter();
    const branchBeforeDiff = git(["branch", "--show-current"], fixture.repository).trim();
    const mainBeforeDiff = git(["rev-parse", "refs/heads/main"], fixture.repository).trim();
    const configBeforeDiff = git(["config", "--local", "--list"], fixture.repository);
    const summary = await adapter.getDiffSummary(fixture.repository);
    assert.equal(summary.baseBranch, "main");
    assert.equal(summary.baseCommit, mainCommit);
    assert.equal(summary.files.find((file) => file.path === "committed.txt")?.status, "added");
    assert.equal(summary.files.find((file) => file.path === "RENAMED.md")?.previousPath, "README.md");
    assert.equal(summary.files.find((file) => file.path === "binary.bin")?.binary, true);
    assert.equal(summary.files.find((file) => file.path === "staged.txt")?.status, "added");
    assert.equal(summary.files.find((file) => file.path === "tracked.txt")?.status, "modified");
    assert.equal(summary.files.find((file) => file.path === "untracked.txt")?.status, "untracked");
    assert.match(await adapter.getDiff(fixture.repository), /committed ticket work/);
    assert.match(await adapter.getDiff(fixture.repository), /untracked work/);
    assert.match(await adapter.getDiff(fixture.repository, "committed.txt"), /committed ticket work/);
    assert.equal(git(["branch", "--show-current"], fixture.repository).trim(), branchBeforeDiff);
    assert.equal(git(["rev-parse", "refs/heads/main"], fixture.repository).trim(), mainBeforeDiff);
    assert.equal(git(["config", "--local", "--list"], fixture.repository), configBeforeDiff);

    const refsBeforeCreate = git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], fixture.repository);
    const created = await adapter.createWorktree({
      repositoryCwd: fixture.repository,
      targetParent: fixture.worktrees,
      forkIdentity: "From Main",
      pendingForkId: "draft-from-main",
    });
    assert.equal(created.retryWith.baseRef, "refs/heads/main");
    assert.equal(git(["rev-parse", created.branch], fixture.repository).trim(), mainCommit);
    assert.notEqual(git(["rev-parse", created.branch], fixture.repository).trim(), ticketCommit);
    assert.equal(git(["branch", "--show-current"], fixture.repository).trim(), branchBeforeDiff);
    assert.equal(git(["rev-parse", "refs/heads/main"], fixture.repository).trim(), mainBeforeDiff);
    assert.equal(git(["config", "--local", "--list"], fixture.repository), configBeforeDiff);
    const refsAfterCreate = git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], fixture.repository)
      .split("\n")
      .filter((line) => line && !line.startsWith(`refs/heads/${created.branch} `))
      .join("\n") + "\n";
    assert.equal(refsAfterCreate, refsBeforeCreate);

    await writeFile(`${created.cwd}/linked.txt`, "linked branch work\n", "utf8");
    git(["add", "linked.txt"], created.cwd);
    git(
      ["-c", "user.name=Peel Test", "-c", "user.email=test@peel.invalid", "commit", "-qm", "linked work"],
      created.cwd,
    );
    const linkedSummary = await adapter.getDiffSummary(created.cwd);
    assert.equal(linkedSummary.baseBranch, "main");
    assert.equal(linkedSummary.baseCommit, mainCommit);
    assert.equal(linkedSummary.files.find((file) => file.path === "linked.txt")?.status, "added");
  } finally {
    await fixture.cleanup();
  }
});

test("missing main fails Diff and omitted-base Worktree without falling back to HEAD", async () => {
  const fixture = await temporaryRepository();
  try {
    git(["branch", "-m", "main", "trunk"], fixture.repository);
    const adapter = new GitWorkspaceAdapter();
    const refsBefore = git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], fixture.repository);
    const branchBefore = git(["branch", "--show-current"], fixture.repository).trim();
    const configBefore = git(["config", "--local", "--list"], fixture.repository);
    const worktreesBefore = git(["worktree", "list", "--porcelain"], fixture.repository);

    await assert.rejects(
      adapter.getDiffSummary(fixture.repository),
      (error: unknown) => error instanceof GitWorkspaceError && error.details.code === "main-ref-unavailable",
    );
    await assert.rejects(
      adapter.getDiff(fixture.repository),
      (error: unknown) => error instanceof GitWorkspaceError && error.details.code === "main-ref-unavailable",
    );
    await assert.rejects(
      adapter.createWorktree({
        repositoryCwd: fixture.repository,
        targetParent: fixture.worktrees,
        forkIdentity: "Must Not Use Head",
        pendingForkId: "draft-missing-main",
      }),
      (error: unknown) =>
        error instanceof GitWorkspaceError &&
        error.details.code === "main-ref-unavailable" &&
        error.details.pendingForkId === "draft-missing-main" &&
        error.details.artifacts.length === 0,
    );
    assert.equal(git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"], fixture.repository), refsBefore);
    assert.equal(git(["branch", "--show-current"], fixture.repository).trim(), branchBefore);
    assert.equal(git(["config", "--local", "--list"], fixture.repository), configBefore);
    assert.equal(git(["worktree", "list", "--porcelain"], fixture.repository), worktreesBefore);
  } finally {
    await fixture.cleanup();
  }
});

test("invalid repositories and broad or unresolved targets fail before mutation", async () => {
  const fixture = await temporaryRepository();
  try {
    const notRepo = `${fixture.root}/not-repo`;
    await mkdir(notRepo);
    const adapter = new GitWorkspaceAdapter();
    assert.deepEqual(await adapter.inspect(`${fixture.root}/missing`), {
      gitBacked: false,
      requestedCwd: `${fixture.root}/missing`,
      resolvedCwd: null,
      reason: "path-unavailable",
    });
    assert.equal((await adapter.inspect(notRepo)).gitBacked, false);

    await assert.rejects(
      adapter.createWorktree({
        repositoryCwd: notRepo,
        targetParent: fixture.worktrees,
        forkIdentity: "invalid",
        pendingForkId: "draft-invalid",
      }),
      (error: unknown) =>
        error instanceof GitWorkspaceError &&
        error.details.stage === "validate-repository" &&
        error.details.pendingForkId === "draft-invalid" &&
        error.details.artifacts.length === 0,
    );
    await assert.rejects(
      adapter.createWorktree({
        repositoryCwd: fixture.repository,
        targetParent: fixture.worktrees,
        forkIdentity: "invalid base",
        pendingForkId: "draft-invalid-base",
        baseRef: "--definitely-not-a-ref",
      }),
      (error: unknown) =>
        error instanceof GitWorkspaceError &&
        error.details.stage === "allocate-identity" &&
        error.details.code === "invalid-base-ref" &&
        error.details.pendingForkId === "draft-invalid-base" &&
        error.details.artifacts.length === 0,
    );
    await assert.rejects(
      adapter.createWorktree({
        repositoryCwd: fixture.repository,
        targetParent: `${fixture.root}/does-not-exist`,
        forkIdentity: "unresolved",
        pendingForkId: "draft-unresolved",
      }),
      (error: unknown) =>
        error instanceof GitWorkspaceError &&
        error.details.stage === "validate-target-parent" &&
        error.details.pendingForkId === "draft-unresolved" &&
        error.details.artifacts.length === 0,
    );
    await assert.rejects(
      adapter.createWorktree({
        repositoryCwd: fixture.repository,
        targetParent: parse(fixture.repository).root,
        forkIdentity: "unsafe",
        pendingForkId: "draft-unsafe",
      }),
      (error: unknown) =>
        error instanceof GitWorkspaceError &&
        error.details.stage === "validate-target-parent" &&
        error.details.artifacts.length === 0,
    );
    assert.equal(git(["worktree", "list", "--porcelain"], fixture.repository).match(/^worktree /gm)?.length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("partial create failure reports exact artifact and preserves retry/current-workspace recovery", async () => {
  const fixture = await temporaryRepository();
  try {
    const runner = new BranchThenFailRunner();
    const adapter = new GitWorkspaceAdapter({ runner });
    const input = {
      repositoryCwd: fixture.repository,
      targetParent: fixture.worktrees,
      forkIdentity: "Recover Me",
      pendingForkId: "draft-with-composer-text",
    };
    let failure: GitWorkspaceError | null = null;
    try {
      await adapter.createWorktree(input);
    } catch (error) {
      if (error instanceof GitWorkspaceError) failure = error;
      else throw error;
    }
    assert.ok(failure);
    assert.equal(failure.details.stage, "create-worktree");
    assert.equal(failure.details.pendingForkId, input.pendingForkId);
    assert.equal(failure.details.currentWorkspaceCwd, fixture.repository);
    assert.deepEqual(failure.details.artifacts, [{ kind: "branch", name: "peel/recover-me" }]);
    assert.equal(git(["worktree", "list", "--porcelain"], fixture.repository).includes("recover-me"), false);

    const retry = await new GitWorkspaceAdapter().createWorktree(input);
    assert.equal(retry.branch, "peel/recover-me-2");
    assert.equal(retry.pendingForkId, input.pendingForkId);
  } finally {
    await fixture.cleanup();
  }
});

test("unregistered leftover directories are reported separately from Git worktrees", async () => {
  const fixture = await temporaryRepository();
  try {
    const adapter = new GitWorkspaceAdapter({ runner: new BranchAndDirectoryThenFailRunner() });
    await assert.rejects(
      adapter.createWorktree({
        repositoryCwd: fixture.repository,
        targetParent: fixture.worktrees,
        forkIdentity: "Partial Directory",
        pendingForkId: "draft-partial-directory",
      }),
      (error: unknown) =>
        error instanceof GitWorkspaceError &&
        error.details.pendingForkId === "draft-partial-directory" &&
        error.details.artifacts.some(
          (artifact) => artifact.kind === "branch" && artifact.name === "peel/partial-directory",
        ) &&
        error.details.artifacts.some(
          (artifact) => artifact.kind === "directory" && artifact.path?.endsWith("/partial-directory"),
        ) &&
        !error.details.artifacts.some((artifact) => artifact.kind === "worktree"),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("file diff rejects paths that escape the resolved worktree", async () => {
  const fixture = await temporaryRepository();
  try {
    const adapter = new GitWorkspaceAdapter();
    await assert.rejects(
      adapter.getDiff(fixture.repository, "../outside.txt"),
      (error: unknown) => error instanceof GitWorkspaceError && error.details.code === "unsafe-file-path",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("NUL-safe numstat maps additions and deletions for valid filenames containing tabs", async () => {
  const fixture = await temporaryRepository();
  try {
    const oddPath = "tab\tfile.txt";
    await writeFile(`${fixture.repository}/${oddPath}`, "before\n", "utf8");
    git(["add", oddPath], fixture.repository);
    git(
      ["-c", "user.name=Peel Test", "-c", "user.email=test@peel.invalid", "commit", "-qm", "odd path"],
      fixture.repository,
    );
    await writeFile(`${fixture.repository}/${oddPath}`, "after\n", "utf8");
    const adapter = new GitWorkspaceAdapter();
    const summary = await adapter.getDiffSummary(fixture.repository);
    const oddFile = summary.files.find((file) => file.path === oddPath);
    assert.ok(oddFile);
    assert.equal(oddFile.additions, 1);
    assert.equal(oddFile.deletions, 1);
    assert.match(await adapter.getDiff(fixture.repository, oddPath), /\+after/);
  } finally {
    await fixture.cleanup();
  }
});

test("realpath-aware containment rejects in-worktree symlinks that resolve outside", async () => {
  const fixture = await temporaryRepository();
  try {
    const outside = `${fixture.root}/outside`;
    await mkdir(outside);
    await writeFile(`${outside}/secret.txt`, "outside\n", "utf8");
    await symlink(outside, `${fixture.repository}/outside-link`, "dir");
    const adapter = new GitWorkspaceAdapter();
    await assert.rejects(
      adapter.getOpenTargets(fixture.repository, { path: "outside-link/secret.txt" }),
      (error: unknown) => error instanceof GitWorkspaceError && error.details.code === "unsafe-file-path",
    );
    await assert.rejects(
      adapter.getDiff(fixture.repository, "outside-link/secret.txt"),
      (error: unknown) => error instanceof GitWorkspaceError && error.details.code === "unsafe-file-path",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("Git process failures use the same recoverable envelope and retain pending Fork identity", async () => {
  const fixture = await temporaryRepository();
  try {
    const adapter = new GitWorkspaceAdapter({ runner: new AlwaysFailRunner() });
    await assert.rejects(
      adapter.createWorktree({
        repositoryCwd: fixture.repository,
        targetParent: fixture.worktrees,
        forkIdentity: "Git unavailable",
        pendingForkId: "draft-git-unavailable",
      }),
      (error: unknown) =>
        error instanceof GitWorkspaceError &&
        error.details.stage === "validate-repository" &&
        error.details.code === "git-unavailable" &&
        error.details.pendingForkId === "draft-git-unavailable" &&
        error.details.artifacts.length === 0,
    );
  } finally {
    await fixture.cleanup();
  }
});

class BranchThenFailRunner implements GitRunner {
  readonly #delegate = new LocalGitRunner();
  #failed = false;

  async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
    if (!this.#failed && args[0] === "worktree" && args[1] === "add") {
      this.#failed = true;
      const branch = args[3];
      const baseRef = args[5];
      assert.ok(branch);
      assert.ok(baseRef);
      await this.#delegate.run(["branch", branch, baseRef], { cwd: options.cwd });
      throw new GitCommandError("injected failure after branch creation", {
        args,
        cwd: options.cwd,
        exitCode: 77,
        stderr: "injected creation failure",
      });
    }
    return await this.#delegate.run(args, options);
  }
}

class AlwaysFailRunner implements GitRunner {
  async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
    throw new GitCommandError("git unavailable", {
      args,
      cwd: options.cwd,
      exitCode: null,
      stderr: "git unavailable",
    });
  }
}

class BranchAndDirectoryThenFailRunner implements GitRunner {
  readonly #delegate = new LocalGitRunner();
  #failed = false;

  async run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
    if (!this.#failed && args[0] === "worktree" && args[1] === "add") {
      this.#failed = true;
      const branch = args[3];
      const path = args[4];
      const baseRef = args[5];
      assert.ok(branch);
      assert.ok(path);
      assert.ok(baseRef);
      await this.#delegate.run(["branch", branch, baseRef], { cwd: options.cwd });
      await mkdir(path);
      throw new GitCommandError("injected failure after branch and directory creation", {
        args,
        cwd: options.cwd,
        exitCode: 78,
        stderr: "injected partial directory failure",
      });
    }
    return await this.#delegate.run(args, options);
  }
}
