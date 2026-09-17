import type { OpenTargetInput } from "../shared/contracts";

export const OPEN_CODEX_FAILURE = "Codex could not be opened. Make sure the desktop app is installed, then try again.";

export async function openCodexInDesktop(
  openTarget: (input: OpenTargetInput) => Promise<void>,
  input: Pick<OpenTargetInput, "cwd" | "threadId">,
): Promise<string | null> {
  try {
    await openTarget({ kind: "codex", cwd: input.cwd, ...(input.threadId ? { threadId: input.threadId } : {}) });
    return null;
  } catch {
    return OPEN_CODEX_FAILURE;
  }
}
