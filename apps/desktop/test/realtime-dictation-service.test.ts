import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import type { AppServerClient } from "@peel/codex-app-server";
import { RealtimeDictationService } from "../src/main/realtime-dictation-service";

class FakeClient extends EventEmitter {
  feature: "experimental-enabled" | "unavailable" = "experimental-enabled";
  calls: Array<{ method: string; params: unknown }> = [];
  capabilities = { featureStatus: () => this.feature };
  startFailure: string | null = null;

  async startRealtime(params: unknown): Promise<void> {
    this.calls.push({ method: "thread/realtime/start", params });
    const threadId = (params as { threadId: string }).threadId;
    queueMicrotask(() => this.emit("notification", this.startFailure
      ? { method: "thread/realtime/error", params: { threadId, message: this.startFailure } }
      : { method: "thread/realtime/started", params: { threadId, realtimeSessionId: "test" } }));
  }

  async appendRealtimeAudio(threadId: string, audio: unknown): Promise<void> {
    this.calls.push({ method: "thread/realtime/appendAudio", params: { threadId, audio } });
  }

  async stopRealtime(threadId: string): Promise<void> {
    this.calls.push({ method: "thread/realtime/stop", params: { threadId } });
  }
}

describe("Codex App Server realtime dictation", () => {
  it("uses the existing server session, assembles only user transcript, and creates no Turn", async () => {
    const client = new FakeClient();
    const service = new RealtimeDictationService(client as unknown as AppServerClient);
    await expect(service.begin("thread-a")).resolves.toEqual({ engine: "codex-realtime" });
    await service.append({
      threadId: "thread-a",
      bytes: new Uint8Array([5, 6, 7]).buffer,
      sampleRate: 16_000,
      samplesPerChannel: 3,
    });
    client.emit("notification", {
      method: "thread/realtime/transcript/delta",
      params: { threadId: "thread-a", role: "assistant", delta: "ignore me" },
    });
    client.emit("notification", {
      method: "thread/realtime/transcript/delta",
      params: { threadId: "thread-a", role: "user", delta: "你好" },
    });
    client.emit("notification", {
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-a", role: "user", text: "你好，Peel" },
    });
    await expect(service.finish("thread-a")).resolves.toEqual({
      text: "你好，Peel",
      isFinal: true,
      engine: "codex-realtime",
    });
    const start = client.calls[0]?.params as Record<string, unknown>;
    expect(start).toMatchObject({
      threadId: "thread-a",
      outputModality: "text",
      includeStartupContext: false,
      clientManagedHandoffs: true,
      flushTranscriptTailOnSessionEnd: false,
    });
    const audio = (client.calls[1]?.params as { audio: Record<string, unknown> }).audio;
    expect(audio).toMatchObject({ data: "BQYH", sampleRate: 16_000, numChannels: 1, samplesPerChannel: 3 });
    expect(client.calls.map((call) => call.method)).toEqual([
      "thread/realtime/start",
      "thread/realtime/appendAudio",
      "thread/realtime/stop",
    ]);
    expect(client.calls.some((call) => call.method === "turn/start")).toBe(false);
  });

  it("falls back before capture when realtime is unavailable and isolates cancelled Threads", async () => {
    const client = new FakeClient();
    client.feature = "unavailable";
    const service = new RealtimeDictationService(client as unknown as AppServerClient);
    await expect(service.begin("thread-a")).resolves.toEqual({ engine: "native-fallback" });
    expect(client.calls).toEqual([]);

    client.feature = "experimental-enabled";
    await service.begin("thread-a");
    client.emit("notification", {
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-a", role: "user", text: "must not leak" },
    });
    await service.cancel("thread-a");
    await service.begin("thread-b");
    client.emit("notification", {
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-a", role: "user", text: "still must not leak" },
    });
    client.emit("notification", {
      method: "thread/realtime/transcript/done",
      params: { threadId: "thread-b", role: "user", text: "right draft" },
    });
    await expect(service.finish("thread-b")).resolves.toMatchObject({ text: "right draft" });
  });

  it("turns the current ChatGPT-auth preflight rejection into native fallback before audio", async () => {
    const client = new FakeClient();
    client.startFailure = "realtime conversation requires API key auth";
    const service = new RealtimeDictationService(client as unknown as AppServerClient);
    await expect(service.begin("thread-a")).resolves.toEqual({ engine: "native-fallback" });
    expect(client.calls.map((call) => call.method)).toEqual([
      "thread/realtime/start",
      "thread/realtime/stop",
    ]);
    expect(client.calls.some((call) => call.method === "thread/realtime/appendAudio")).toBe(false);
  });
});
