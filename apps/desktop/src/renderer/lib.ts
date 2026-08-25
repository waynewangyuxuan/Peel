import type { CodexThread, CodexTurn, ThreadItem } from "@peel/codex-app-server";

export function latestCompletedTurn(thread: CodexThread): CodexTurn | null {
  return [...thread.turns].reverse().find((turn) => turn.status === "completed") ?? null;
}

export function latestText(thread: CodexThread, role: "user" | "agent"): string {
  const types = role === "user" ? ["userMessage"] : ["agentMessage"];
  const item = thread.turns.flatMap((turn) => turn.items).reverse().find((candidate) => types.includes(candidate.type));
  return itemText(item).trim();
}

export function itemText(item: ThreadItem | undefined): string {
  if (!item) return "";
  for (const key of ["text", "content", "message", "summary", "aggregatedOutput", "output"]) {
    const value = item[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const text = value.map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const record = part as Record<string, unknown>;
          return typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : "";
        }
        return "";
      }).filter(Boolean).join("\n");
      if (text) return text;
    }
  }
  return "";
}

export function relativeTime(timestamp: number | null | undefined): string {
  if (!timestamp) return "No activity";
  const value = timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
  const seconds = Math.round((value - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function clip(value: string, max = 132): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}
