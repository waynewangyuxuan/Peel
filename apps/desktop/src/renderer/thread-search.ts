import type { CodexThread, ThreadListResponse } from "@peel/codex-app-server";

export function threadMatches(thread: CodexThread, term: string): boolean {
  const query = term.toLocaleLowerCase();
  return [thread.name, thread.preview, thread.cwd].some((value) => value?.toLocaleLowerCase().includes(query));
}

export function mergeThreadPage(current: ThreadListResponse, page: ThreadListResponse): ThreadListResponse {
  const threads = new Map(current.data.map((thread) => [thread.id, thread]));
  for (const thread of page.data) threads.set(thread.id, thread);
  return { data: [...threads.values()], nextCursor: page.nextCursor, backwardsCursor: current.backwardsCursor };
}
