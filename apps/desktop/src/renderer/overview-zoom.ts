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
  if (mode === "compact") return clamp(0.82 / normalized, 1, 1.62);
  return clamp(0.92 / normalized, 1.7, 4.8);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
