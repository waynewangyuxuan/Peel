import { describe, expect, it } from "vitest";

import { resolveSemanticZoomMode, semanticContentScale, visibleNodeBounds, edgeCurve, fitSemanticCamera, type SemanticZoomMode } from "../src/renderer/overview-zoom";

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

describe("semantic surface geometry", () => {
  it("never turns disjoint detail-card slots into overlapping labels while zooming both ways", () => {
    const slots = [{ x: 0, y: 0 }, { x: 382, y: 0 }, { x: 0, y: 243 }, { x: 382, y: 243 }];
    const scales = Array.from({ length: 138 }, (_, index) => (145 - index) / 100);
    let mode: SemanticZoomMode = "detail";
    for (const scale of [...scales, ...scales.toReversed()]) {
      mode = resolveSemanticZoomMode(scale, mode);
      const boxes = slots.map((position) => visibleNodeBounds(position, scale, mode));
      for (const [index, box] of boxes.entries()) {
        expect(box.width).toBeLessThanOrEqual(294);
        expect(box.height).toBeLessThanOrEqual(205);
        expect(box.y).toBeGreaterThanOrEqual(slots[index]!.y);
        expect(box.y + box.height).toBeLessThanOrEqual(slots[index]!.y + 205 + 1e-9);
        for (const other of boxes.slice(index + 1)) {
          expect(box.x + box.width <= other.x || other.x + other.width <= box.x
            || box.y + box.height <= other.y || other.y + other.height <= box.y).toBe(true);
        }
      }
    }
  });

  it("attaches edges to visible sides, including a narrower compact surface and dragged nodes", () => {
    for (const [scale, mode, width] of [[1, "detail", 294], [.6, "compact", 294], [.08, "map", 294], [.85, "compact", 252]] as const) {
      const parent = { x: -30, y: 90 };
      const child = { x: 460, y: -250 };
      const points = edgeCurve(parent, child, scale, mode).match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      expect(points.slice(0, 2)).toEqual([parent.x + width, 192.5]);
      expect(points.slice(-2)).toEqual([460, -147.5]);
    }
  });

  it("Fits the visible rectangles with balanced margins without changing positions", () => {
    const positions = [{ x: -200, y: -200 }, { x: 1820, y: 286 }, { x: 4200, y: 1540 }];
    const original = structuredClone(positions);
    for (const previous of ["detail", "compact", "map"] as const) {
      const viewport = { width: 1240, height: 820 };
      const camera = fitSemanticCamera(positions, viewport, previous);
      const mode = resolveSemanticZoomMode(camera.scale, previous);
      const boxes = positions.map((point) => visibleNodeBounds(point, camera.scale, mode));
      const left = Math.min(...boxes.map((box) => box.x)) * camera.scale + camera.x;
      const right = Math.max(...boxes.map((box) => box.x + box.width)) * camera.scale + camera.x;
      const top = Math.min(...boxes.map((box) => box.y)) * camera.scale + camera.y;
      const bottom = Math.max(...boxes.map((box) => box.y + box.height)) * camera.scale + camera.y;
      expect(left).toBeGreaterThanOrEqual(110 - 1e-6);
      expect(top).toBeGreaterThanOrEqual(98.4 - 1e-6);
      expect(left).toBeCloseTo(viewport.width - right);
      expect(top).toBeCloseTo(viewport.height - bottom);
      expect(positions).toEqual(original);
    }
  });
});
