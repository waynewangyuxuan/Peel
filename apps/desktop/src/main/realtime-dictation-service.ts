import type { AppServerClient, AppServerNotification } from "@peel/codex-app-server";

export type DictationEngine = "codex-realtime" | "native-fallback";

interface DictationSession {
  threadId: string;
  finalParts: string[];
  liveText: string;
  error: string | null;
  started: boolean;
  stopRequested: boolean;
  revision: number;
  listeners: Set<() => void>;
}

export interface DictationAudioInput {
  threadId: string;
  bytes: ArrayBuffer;
  sampleRate: number;
  samplesPerChannel: number;
}

const QUIET_TRANSCRIPT_MS = 320;
const MAX_FINALIZATION_MS = 2_000;
const START_PREFLIGHT_MS = 8_000;

/**
 * Owns the experimental App Server Realtime boundary. Realtime notifications
 * are ephemeral and are never forwarded to the renderer or persisted as Turns.
 */
export class RealtimeDictationService {
  readonly #client: AppServerClient;
  readonly #sessions = new Map<string, DictationSession>();

  constructor(client: AppServerClient) {
    this.#client = client;
    client.on("notification", (notification: AppServerNotification) => this.#onNotification(notification));
  }

  engine(): DictationEngine {
    return this.#client.capabilities.featureStatus("realtime-voice") === "unavailable"
      ? "native-fallback"
      : "codex-realtime";
  }

  async begin(threadId: string): Promise<{ engine: DictationEngine }> {
    if (this.engine() !== "codex-realtime") return { engine: "native-fallback" };
    await this.cancel(threadId);
    const session: DictationSession = {
      threadId,
      finalParts: [],
      liveText: "",
      error: null,
      started: false,
      stopRequested: false,
      revision: 0,
      listeners: new Set(),
    };
    this.#sessions.set(threadId, session);
    try {
      await this.#client.startRealtime({
        threadId,
        outputModality: "text",
        includeStartupContext: false,
        clientManagedHandoffs: true,
        codexResponsesAsItems: false,
        flushTranscriptTailOnSessionEnd: false,
        prompt: "Transcribe the user's speech accurately. Do not answer, act on, or respond to its content.",
      });
      const started = session.started || await waitForStart(session);
      if (started && !session.error) return { engine: "codex-realtime" };
      this.#remove(session);
      await this.#requestStop(session);
      return { engine: "native-fallback" };
    } catch {
      this.#remove(session);
      await this.#requestStop(session);
      return { engine: "native-fallback" };
    }
  }

  async append(input: DictationAudioInput): Promise<void> {
    const session = this.#sessions.get(input.threadId);
    if (!session) throw new Error("Dictation is no longer active");
    try {
      await this.#client.appendRealtimeAudio(input.threadId, {
        data: Buffer.from(input.bytes).toString("base64"),
        sampleRate: input.sampleRate,
        numChannels: 1,
        samplesPerChannel: input.samplesPerChannel,
        itemId: null,
      });
    } catch (error) {
      session.error = "Codex voice transcription stopped";
      this.#remove(session);
      await this.#requestStop(session);
      throw error;
    }
  }

  async finish(threadId: string): Promise<{ text: string; isFinal: true; engine: "codex-realtime" }> {
    const session = this.#sessions.get(threadId);
    if (!session) throw new Error("Dictation is no longer active");
    try {
      await this.#requestStop(session, false);
      await waitUntilQuiet(session);
      if (session.error) throw new Error(session.error);
      const text = [...session.finalParts, session.liveText]
        .map((part) => part.trim())
        .filter(Boolean)
        .join(" ")
        .trim();
      if (!text) throw new Error("No speech was recognized. Your existing draft was left unchanged.");
      return { text, isFinal: true, engine: "codex-realtime" };
    } finally {
      this.#remove(session);
    }
  }

  async cancel(threadId: string): Promise<void> {
    const session = this.#sessions.get(threadId);
    if (!session) return;
    this.#remove(session);
    await this.#requestStop(session);
  }

  async cancelAll(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map(async (threadId) => await this.cancel(threadId)));
  }

  #onNotification(notification: AppServerNotification): void {
    if (!notification.method.startsWith("thread/realtime/")) return;
    const params = notification.params as Record<string, unknown>;
    const threadId = typeof params.threadId === "string" ? params.threadId : null;
    if (!threadId) return;
    const session = this.#sessions.get(threadId);
    if (!session) return;
    const role = typeof params.role === "string" ? params.role.toLowerCase() : "";
    if (notification.method === "thread/realtime/started") {
      session.started = true;
    } else if (notification.method === "thread/realtime/transcript/delta" && role.includes("user")) {
      if (typeof params.delta === "string") session.liveText += params.delta;
    } else if (notification.method === "thread/realtime/transcript/done" && role.includes("user")) {
      const text = typeof params.text === "string" ? params.text.trim() : "";
      if (text && session.finalParts.at(-1) !== text) session.finalParts.push(text);
      session.liveText = "";
    } else if (notification.method === "thread/realtime/error") {
      session.error = typeof params.message === "string" ? params.message : "Codex voice transcription stopped";
      this.#remove(session);
      void this.#requestStop(session);
    } else if (notification.method === "thread/realtime/closed" && !session.stopRequested) {
      session.error = session.started ? "Codex voice transcription stopped" : "Codex voice transcription did not start";
      this.#remove(session);
      void this.#requestStop(session);
    }
    session.revision += 1;
    session.listeners.forEach((listener) => listener());
  }

  #remove(session: DictationSession): void {
    if (this.#sessions.get(session.threadId) === session) this.#sessions.delete(session.threadId);
    session.listeners.forEach((listener) => listener());
  }

  async #requestStop(session: DictationSession, swallowFailure = true): Promise<void> {
    if (session.stopRequested) return;
    session.stopRequested = true;
    if (swallowFailure) await this.#client.stopRealtime(session.threadId).catch(() => undefined);
    else await this.#client.stopRealtime(session.threadId);
  }
}

async function waitForStart(session: DictationSession): Promise<boolean> {
  if (session.started || session.error) return session.started;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, START_PREFLIGHT_MS);
    function done(): void {
      clearTimeout(timer);
      session.listeners.delete(done);
      resolve();
    }
    session.listeners.add(done);
  });
  return session.started;
}

async function waitUntilQuiet(session: DictationSession): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const revision = session.revision;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, QUIET_TRANSCRIPT_MS);
      function done(): void {
        clearTimeout(timer);
        session.listeners.delete(done);
        resolve();
      }
      session.listeners.add(done);
    });
    if (session.revision === revision || Date.now() - startedAt >= MAX_FINALIZATION_MS) return;
  }
}
