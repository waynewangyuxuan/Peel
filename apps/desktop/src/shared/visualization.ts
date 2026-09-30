export const VISUALIZATION_SCHEME = "peel-viz";

const THEME = `<style>
  :root {
    color-scheme: light;
    --foreground: #20201e;
    --muted-foreground: #71716d;
    --muted: #eeeeec;
    --accent: #242422;
    --accent-foreground: #ffffff;
    --viz-series-1: #4b6587;
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  body { margin: 0; padding: 16px 18px 20px; background: #ffffff; color: var(--foreground); }
</style>
<script>
  const report = () => parent.postMessage({ source: "peel-viz", height: document.documentElement.scrollHeight }, "*");
  addEventListener("load", report);
  new ResizeObserver(report).observe(document.documentElement);
</script>`;

export function visualizationPath(code: string): string | null {
  try {
    const parsed = JSON.parse(code) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as { path?: unknown };
    if (Object.keys(record).some((key) => key !== "path")) return null;
    const path = record.path;
    if (typeof path !== "string" || !path.startsWith("/") || !path.toLowerCase().endsWith(".html")) return null;
    if (path.includes("\0")) return null;
    return path;
  } catch {
    return null;
  }
}

export function visualizationReference(language: string, code: string): string | null {
  const info = language.trim();
  if (info === "visualize") return visualizationPath(code);
  const fromInfo = info.match(/^visualize\s*(\{[\s\S]*\})$/)?.[1];
  if (fromInfo) return visualizationPath(fromInfo);
  if (info && info !== "json") return null;
  const prefixed = code.trim().match(/^visualize\s*(\{[\s\S]*\})$/)?.[1];
  return visualizationPath(prefixed ?? (info === "json" ? code : ""));
}

const VISUALIZE_FENCE = (_match: string, json: string): string => `\n\n\`\`\`visualize\n${json}\n\`\`\`\n\n`;

export function expandVisualizeReferences(text: string): string {
  return text
    .replace(/\uE200visualize\uE202(\{[\s\S]*?\})\uE201/g, VISUALIZE_FENCE)
    .replace(/```visualize[ \t]*(\{[\s\S]*?\})[ \t]*\n```/g, VISUALIZE_FENCE)
    .replace(/```visualize\s*(\{[^\n`]*\})```/g, VISUALIZE_FENCE)
    .replace(/`visualize\s*(\{[^`\n]*\})`/g, VISUALIZE_FENCE);
}

export function visualizationFrameUrl(filePath: string): string {
  return `${VISUALIZATION_SCHEME}://view/?path=${encodeURIComponent(filePath)}`;
}

export function isVisualizationFile(resolvedPath: string): boolean {
  return resolvedPath.startsWith("/")
    && resolvedPath.toLowerCase().endsWith(".html")
    && resolvedPath.split("/").includes(".visualizations");
}

export function visualizationDocument(source: string): string {
  if (/<html[\s>]/i.test(source)) {
    if (/<head[\s>]/i.test(source)) return source.replace(/<head([^>]*)>/i, `<head$1>${THEME}`);
    return source.replace(/<html([^>]*)>/i, `<html$1><head>${THEME}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${THEME}</head><body>${source}</body></html>`;
}
