export type CapabilityStatus = "stable" | "experimental-enabled" | "unavailable";

export const REQUIRED_STABLE_METHODS = [
  "initialize",
  "thread/list",
  "thread/read",
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/name/set",
  "thread/delete",
  "turn/start",
  "turn/interrupt",
] as const;

export const REQUIRED_STABLE_NOTIFICATIONS = [
  "thread/status/changed",
  "thread/name/updated",
  "turn/started",
  "turn/completed",
  "turn/diff/updated",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
] as const;

const EXPERIMENTAL_FEATURES = new Set([
  "project-association",
  "project-inheritance",
  "realtime-voice",
  "paginated-turn-items",
  "descendant-thread-filtering",
  "websocket-transport",
]);

export interface CapabilitySnapshot {
  experimentalApi: boolean;
  detection: "declared-contract" | "installed-schema" | "fallback-contract";
  detectionError: string | null;
  methods: Record<string, CapabilityStatus>;
  features: Record<string, CapabilityStatus>;
}

export interface DetectedAppServerSchema {
  stableMethods: ReadonlySet<string>;
  experimentalMethods: ReadonlySet<string>;
  stableNotifications: ReadonlySet<string>;
  experimentalNotifications: ReadonlySet<string>;
}

export class CapabilityMatrix {
  readonly #experimentalApi: boolean;
  readonly #methods = new Map<string, CapabilityStatus>();
  readonly #features = new Map<string, CapabilityStatus>();
  #detection: CapabilitySnapshot["detection"] = "declared-contract";
  #detectionError: string | null = null;

  constructor({ experimentalApi = false }: { experimentalApi?: boolean } = {}) {
    this.#experimentalApi = experimentalApi;
    for (const method of REQUIRED_STABLE_METHODS) this.#methods.set(method, "stable");
    for (const feature of EXPERIMENTAL_FEATURES) {
      // Protocol presence is not product implementation. Optional surfaces stay
      // unavailable until an adapter explicitly owns them.
      this.#features.set(feature, "unavailable");
    }
  }

  applySchemaDetection(schema: DetectedAppServerSchema): void {
    for (const method of REQUIRED_STABLE_METHODS) {
      const status: CapabilityStatus = schema.stableMethods.has(method)
        ? "stable"
        : this.#experimentalApi && schema.experimentalMethods.has(method)
          ? "experimental-enabled"
          : "unavailable";
      this.#methods.set(method, status);
    }
    this.#detection = "installed-schema";
    this.#detectionError = null;
  }

  recordDetectionFallback(error: unknown): void {
    this.#detection = "fallback-contract";
    this.#detectionError = error instanceof Error ? error.message : String(error);
  }

  methodStatus(method: string): CapabilityStatus {
    return this.#methods.get(method) ?? "unavailable";
  }

  featureStatus(feature: string): CapabilityStatus {
    return this.#features.get(feature) ?? "unavailable";
  }

  markMethodUnavailable(method: string): void {
    this.#methods.set(method, "unavailable");
  }

  markFeatureUnavailable(feature: string): void {
    this.#features.set(feature, "unavailable");
  }

  observeRpcFailure(method: string, error: { code?: number }): void {
    if (error.code === -32601) this.markMethodUnavailable(method);
  }

  snapshot(): CapabilitySnapshot {
    return {
      experimentalApi: this.#experimentalApi,
      detection: this.#detection,
      detectionError: this.#detectionError,
      methods: Object.fromEntries(this.#methods),
      features: Object.fromEntries(this.#features),
    };
  }
}
