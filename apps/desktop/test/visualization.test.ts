import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readVisualizationFile } from "../src/main/visualization-file";
import { isVisualizationFile, visualizationDocument, visualizationPath } from "../src/shared/visualization";
import { canFoldSteps, STEP_FOLD_THRESHOLD } from "../src/renderer/transcript-steps";

describe("chat visualizations", () => {
  it("reads a visualize fence only when it points at a local html file", () => {
    const path = "/Users/waynewang/Peel/apps/desktop/.visualizations/attention-explainer.html";
    expect(visualizationPath(JSON.stringify({ path }))).toBe(path);
    expect(visualizationPath("not json")).toBeNull();
    expect(visualizationPath(JSON.stringify({ path: "https://example.com/a.html" }))).toBeNull();
    expect(visualizationPath(JSON.stringify({ path: "/tmp/notes.txt" }))).toBeNull();
  });

  it("keeps the visualization script and refuses files outside .visualizations", async () => {
    const root = await mkdtemp(join(tmpdir(), "peel-viz-"));
    const folder = join(root, ".visualizations");
    await mkdir(folder);
    const file = join(folder, "lesson.html");
    await writeFile(file, "<div id=\"lesson\"></div><script>draw()</script>");
    const outside = join(root, "notes.html");
    await writeFile(outside, "<p>no</p>");
    await symlink(outside, join(folder, "escape.html"));

    const source = await readVisualizationFile(file);
    const document = visualizationDocument(source);
    expect(document).toContain("id=\"lesson\"");
    expect(document).toContain("draw()");
    expect(document).toContain("peel-viz");
    expect(isVisualizationFile(file)).toBe(true);
    await expect(readVisualizationFile(outside)).rejects.toThrow(".visualizations");
    await expect(readVisualizationFile(join(folder, "escape.html"))).rejects.toThrow(".visualizations");
  });
});

describe("step fold", () => {
  it("offers a fold only after more than five reasoning or tool steps", () => {
    const five = ["userMessage", ...Array.from({ length: STEP_FOLD_THRESHOLD }, () => "reasoning"), "agentMessage"];
    const six = ["userMessage", ...Array.from({ length: STEP_FOLD_THRESHOLD + 1 }, (_, index) => index % 2 === 0 ? "reasoning" : "commandExecution"), "agentMessage"];
    expect(canFoldSteps(five)).toBe(false);
    expect(canFoldSteps(six)).toBe(true);
    expect(canFoldSteps(["userMessage", "agentMessage"])).toBe(false);
  });
});
