import type { CameraState, Point } from "../shared/contracts";

export const CARD_WIDTH = 294;
export const CARD_HEIGHT = 205;
export const MIN_SCALE = .08;
export const MAX_SCALE = 1.45;
const COMPACT_HEIGHT = 148;

export type SemanticZoomMode = "detail" | "compact" | "map";

const DETAIL_ENTER = 0.86;
const DETAIL_EXIT = 0.76;
const MAP_ENTER = 0.42;
const MAP_EXIT = 0.5;

export function resolveSemanticZoomMode(
  scale: number,
  previous: SemanticZoomMode = "detail",
): SemanticZoomMode {
  const normalized = Number.isFinite(scale) ? scale : 1;

  if (previous === "detail") {
    return normalized < DETAIL_EXIT
      ? normalized < MAP_ENTER ? "map" : "compact"
      : "detail";
  }

  if (previous === "map") {
    return normalized > MAP_EXIT
      ? normalized > DETAIL_ENTER ? "detail" : "compact"
      : "map";
  }

  if (normalized > DETAIL_ENTER) return "detail";
  if (normalized < MAP_ENTER) return "map";
  return "compact";
}

export function semanticContentScale(scale: number, mode: SemanticZoomMode): number {
  const normalized = Math.max(0.08, Number.isFinite(scale) ? scale : 1);
  if (mode === "detail") return 1;
  if (mode === "compact") return clamp(0.82 / normalized, 1, CARD_HEIGHT / COMPACT_HEIGHT);
  return clamp(0.92 / normalized, 1.7, 4.8);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

// Semantic text can resist zoom, but its surface must not grow into a neighbour's slot.
export function semanticGeometry(scale: number, mode: SemanticZoomMode) {
  const contentScale = semanticContentScale(scale, mode);
  const width = mode === "detail" ? CARD_WIDTH : Math.min(CARD_WIDTH, (mode === "compact" ? 252 : 220) * contentScale);
  const height = mode === "detail" ? CARD_HEIGHT : (mode === "compact" ? COMPACT_HEIGHT : 38) * contentScale;
  return { width, height, top: (CARD_HEIGHT - height) / 2, contentScale };
}

export function visibleNodeBounds(position: Point, scale: number, mode: SemanticZoomMode) {
  const geometry = semanticGeometry(scale, mode);
  return { x: position.x, y: position.y + geometry.top, width: geometry.width, height: geometry.height };
}

export function edgeCurve(parent: Point, child: Point, scale: number, mode: SemanticZoomMode): string {
  const source = visibleNodeBounds(parent, scale, mode);
  const target = visibleNodeBounds(child, scale, mode);
  const x1 = source.x + source.width;
  const y1 = source.y + source.height / 2;
  const x2 = target.x;
  const y2 = target.y + target.height / 2;
  const bend = Math.max(50, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

export function fitSemanticCamera(
  positions: Point[],
  viewport: { width: number; height: number },
  previousMode: SemanticZoomMode,
): CameraState {
  if (positions.length === 0) return { x: 120, y: 120, scale: 1 };
  const paddingX = Math.min(110, viewport.width * .1);
  const paddingY = Math.min(105, viewport.height * .12);
  const boundsAt = (scale: number) => {
    const mode = resolveSemanticZoomMode(scale, previousMode);
    const rectangles = positions.map((position) => visibleNodeBounds(position, scale, mode));
    const minX = Math.min(...rectangles.map((rect) => rect.x));
    const minY = Math.min(...rectangles.map((rect) => rect.y));
    const maxX = Math.max(...rectangles.map((rect) => rect.x + rect.width));
    const maxY = Math.max(...rectangles.map((rect) => rect.y + rect.height));
    return { minX, minY, width: maxX - minX, height: maxY - minY };
  };
  const fits = (scale: number) => {
    const bounds = boundsAt(scale);
    return bounds.width * scale <= viewport.width - paddingX * 2
      && bounds.height * scale <= viewport.height - paddingY * 2;
  };
  let low = MIN_SCALE;
  let high = 1;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const middle = (low + high) / 2;
    if (fits(middle)) low = middle;
    else high = middle;
  }
  const scale = fits(1) ? 1 : low;
  const bounds = boundsAt(scale);
  return {
    scale,
    x: (viewport.width - bounds.width * scale) / 2 - bounds.minX * scale,
    y: (viewport.height - bounds.height * scale) / 2 - bounds.minY * scale,
  };
}
