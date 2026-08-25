import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TemporaryRepository {
  root: string;
  repository: string;
  worktrees: string;
  cleanup(): Promise<void>;
}

export async function temporaryRepository(): Promise<TemporaryRepository> {
  const root = await mkdtemp(join(tmpdir(), "peel-git-workspace-test-"));
  const repository = join(root, "repository");
  const worktrees = join(root, "worktrees");
  await mkdir(repository);
  await mkdir(worktrees);
  git(["init", "-q"], repository);
  await writeFile(join(repository, "README.md"), "one\n", "utf8");
  git(["add", "README.md"], repository);
  git(
    ["-c", "user.name=Peel Test", "-c", "user.email=test@peel.invalid", "commit", "-qm", "fixture"],
    repository,
  );
  const resolvedRoot = await realpath(root);
  return {
    root: resolvedRoot,
    repository: await realpath(repository),
    worktrees: await realpath(worktrees),
    cleanup: async () => await rm(resolvedRoot, { recursive: true, force: true }),
  };
}

export function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}
