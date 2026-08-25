import type { PeelApi } from "../shared/contracts";

declare global {
  interface Window {
    peel: PeelApi;
  }
}

export {};
