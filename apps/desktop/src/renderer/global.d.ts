import type { PeelApi } from "../shared/contracts";
import type { BenchmarkRenderer, RenderingBenchmarkResult } from "./RenderingBenchmark";
import type { TranscriptPerformanceSnapshot } from "./transcript-performance";

declare global {
  interface Window {
    peel: PeelApi;
    __peelRenderingBenchmark?: {
      runSuite(renderer: BenchmarkRenderer): Promise<RenderingBenchmarkResult>;
    };
    __peelTranscriptPerformance?: {
      mode: "optimized" | "baseline";
      reset(): void;
      snapshot(): TranscriptPerformanceSnapshot;
      waitForUpdates(count: number, timeoutMs?: number): Promise<TranscriptPerformanceSnapshot>;
      waitForNavigations(count: number, timeoutMs?: number): Promise<TranscriptPerformanceSnapshot>;
      openThread(threadId: string, cold?: boolean): void;
    };
  }
}

export {};
