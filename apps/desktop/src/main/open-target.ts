import type { OpenTargetInput } from "../shared/contracts";

const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OpenTargetDependencies {
  exists(path: string): boolean;
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<string>;
}

export function codexThreadDeepLink(threadId: string | undefined): string {
  const normalized = threadId?.trim();
  if (!normalized || !CODEX_THREAD_ID.test(normalized)) {
    throw new Error("This Codex Chat has an invalid Thread ID and could not be opened.");
  }
  return `codex://threads/${encodeURIComponent(normalized)}`;
}

export async function openTarget(input: OpenTargetInput, dependencies: OpenTargetDependencies): Promise<void> {
  if (input.kind === "codex") {
    const deepLink = codexThreadDeepLink(input.threadId);
    try {
      await dependencies.openExternal(deepLink);
    } catch {
      throw new Error("Codex could not be opened. Make sure the desktop app is installed, then try again.");
    }
    return;
  }

  if (input.path && dependencies.exists(input.path)) {
    await dependencies.openPath(input.path);
    return;
  }
  await dependencies.openPath(input.cwd);
}
