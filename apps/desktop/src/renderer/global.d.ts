import type { PeelApi } from "../shared/contracts";
import type { BenchmarkRenderer, RenderingBenchmarkResult } from "./RenderingBenchmark";

declare global {
  interface Window {
    peel: PeelApi;
    __peelRenderingBenchmark?: {
      runSuite(renderer: BenchmarkRenderer): Promise<RenderingBenchmarkResult>;
    };
  }
}

export {};
