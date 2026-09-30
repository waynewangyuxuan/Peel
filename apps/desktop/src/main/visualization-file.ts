import { readFile, realpath, stat } from "node:fs/promises";

import { isVisualizationFile } from "../shared/visualization";

const MAX_VISUALIZATION_BYTES = 1_500_000;

export async function readVisualizationFile(inputPath: string): Promise<string> {
  if (!inputPath.startsWith("/") || inputPath.includes("\0") || !inputPath.toLowerCase().endsWith(".html")) {
    throw new Error("Visualization path is not a local HTML file.");
  }
  const resolved = await realpath(inputPath);
  if (!isVisualizationFile(resolved)) throw new Error("Visualization files stay inside a .visualizations folder.");
  const info = await stat(resolved);
  if (!info.isFile() || info.size > MAX_VISUALIZATION_BYTES) throw new Error("Visualization file is unavailable.");
  return await readFile(resolved, "utf8");
}
