import { describe, expect, it } from "vitest";

import { resolveSemanticZoomMode, semanticContentScale } from "../src/renderer/overview-zoom";

describe("semantic Overview zoom", () => {
  it("uses hysteresis so a wheel resting near a boundary does not flicker", () => {
    expect(resolveSemanticZoomMode(0.8, "detail")).toBe("detail");
    expect(resolveSemanticZoomMode(0.75, "detail")).toBe("compact");
    expect(resolveSemanticZoomMode(0.8, "compact")).toBe("compact");
    expect(resolveSemanticZoomMode(0.87, "compact")).toBe("detail");
    expect(resolveSemanticZoomMode(0.46, "compact")).toBe("compact");
    expect(resolveSemanticZoomMode(0.41, "compact")).toBe("map");
    expect(resolveSemanticZoomMode(0.48, "map")).toBe("map");
    expect(resolveSemanticZoomMode(0.51, "map")).toBe("compact");
  });

  it("keeps compact and map labels near a readable screen scale", () => {
    expect(semanticContentScale(1, "detail")).toBe(1);
    expect(semanticContentScale(0.6, "compact")).toBeCloseTo(0.82 / 0.6);
    expect(semanticContentScale(0.2, "map")).toBeCloseTo(0.92 / 0.2);
    expect(semanticContentScale(0.08, "map")).toBe(4.8);
  });
});
