import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createSpace, emptyState } from "../src/shared/state";

test("semantic labels stay in their slots, edges attach, and zoom preserves positions", async ({}, testInfo) => {
  const scratch = await mkdtemp(join(tmpdir(), "peel-semantic-geometry-"));
  const desktop = resolve(import.meta.dirname, "..");
  const userData = join(scratch, "data");
  await mkdir(userData);
  const space = createSpace({ id: "thread-root", name: "A long root title that must truncate at map scale", preview: "", cwd: scratch, createdAt: 1 });
  const root = space.nodes[space.rootThreadId]!;
  const positions = [{ x: 0, y: 243 }, { x: 382, y: 0 }, { x: 764, y: 0 }, { x: 382, y: 243 }];
  root.position = positions[0]!;
  for (let index = 1; index < positions.length; index += 1) {
    const id = `synthetic-${index}`;
    space.nodes[id] = { ...root, threadId: id, forkedAtTurnId: "turn-2", parentThreadId: index === 2 ? "synthetic-1" : root.threadId, title: `Long direction ${index} with more title text to truncate`, position: positions[index]! };
  }
  space.camera = { scale: .32, x: 150, y: 150 };
  const state = { ...emptyState(), spaces: { [space.id]: space }, activeSpaceId: space.id, activeThreadId: root.threadId, viewMode: "overview" as const };
  await writeFile(join(userData, "peel-state.json"), JSON.stringify(state));
  const app = await electron.launch({ args: [desktop], env: { ...process.env, PEEL_RENDERER_URL: "", PEEL_USER_DATA_PATH: userData, PEEL_CODEX_BINARY: join(desktop, "e2e/fixtures/codex"), PEEL_VOICE_HELPER: join(desktop, "e2e/fixtures/speech-helper"), TMPDIR: scratch, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
  try {
    const page = await app.firstWindow();
    const shell = page.locator(".overview-shell");
    await expect(shell).toHaveAttribute("data-zoom-mode", "map");
    await page.evaluate(() => {
      const audit = { frames: 0, violations: [] as string[] };
      (window as unknown as { geometryAudit: typeof audit }).geometryAudit = audit;
      const sample = () => {
        audit.frames += 1;
        for (const card of document.querySelectorAll<HTMLElement>(".overview-card")) {
          const slot = card.getBoundingClientRect();
          for (const layer of card.querySelectorAll<HTMLElement>(".card-compact, .card-map")) {
            if (Number(getComputedStyle(layer).opacity) < .001) continue;
            const rect = layer.getBoundingClientRect();
            if (rect.left < slot.left - 1.1 || rect.top < slot.top - 1.1 || rect.right > slot.right + 1.1 || rect.bottom > slot.bottom + 1.1) {
              if (audit.violations.length < 20) audit.violations.push(`${layer.className} escaped slot during frame ${audit.frames}`);
            }
          }
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });

    async function checkGeometry() {
      // Wait for the fade to settle, then measure actual browser layout rather than helper output.
      await page.waitForTimeout(300);
      const result = await page.evaluate(() => {
        const mode = document.querySelector<HTMLElement>(".overview-shell")!.dataset.zoomMode;
        const selector = mode === "map" ? ".card-map" : mode === "compact" ? ".card-compact" : ".overview-card-surface";
        const cards = [...document.querySelectorAll<HTMLElement>(".overview-card")];
        const rects = cards.map((card) => card.querySelector(selector)!.getBoundingClientRect());
        const withinSlots = rects.every((rect, index) => {
          const slot = cards[index]!.getBoundingClientRect();
          return rect.left >= slot.left - 1 && rect.top >= slot.top - 1 && rect.right <= slot.right + 1 && rect.bottom <= slot.bottom + 1;
        });
        const overlaps = rects.some((a, index) => rects.slice(index + 1).some((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
        const svg = document.querySelector<SVGSVGElement>(".overview-edges")!;
        const paths = [...svg.querySelectorAll("path")];
        const edgeErrors = paths.map((path, index) => {
          const start = path.getPointAtLength(0).matrixTransform(path.getScreenCTM()!);
          const end = path.getPointAtLength(path.getTotalLength()).matrixTransform(path.getScreenCTM()!);
          const parent = rects[index === 1 ? 1 : 0]!;
          const child = rects[index + 1]!;
          return Math.max(Math.abs(start.x - parent.right), Math.abs(start.y - (parent.top + parent.height / 2)), Math.abs(end.x - child.left), Math.abs(end.y - (child.top + child.height / 2)));
        });
        return { withinSlots, overlaps, edgeErrors, titles: [...document.querySelectorAll(".card-map strong")].every((el) => el.getAttribute("title") === el.textContent) };
      });
      expect(result.withinSlots).toBe(true);
      expect(result.overlaps).toBe(false);
      expect(result.edgeErrors.every((error) => error < 2)).toBe(true);
      expect(result.titles).toBe(true);
    }
    await checkGeometry();
    await page.screenshot({ path: testInfo.outputPath("map-separated.png") });
    for (let index = 0; index < 2; index += 1) {
      await page.getByRole("button", { name: "Zoom out", exact: true }).click();
      await checkGeometry();
    }
    await expect(page.locator(".zoom-controls span")).toHaveText("8%");
    await checkGeometry();
    for (let index = 0; index < 7; index += 1) {
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      await checkGeometry();
    }
    await page.getByRole("button", { name: "Fit", exact: true }).click();
    await checkGeometry();
    const saved = await page.evaluate(() => window.peel.bootstrap());
    expect(Object.values(saved.state.spaces[space.id]!.nodes).map((node) => node.position)).toEqual(positions);
    await page.screenshot({ path: testInfo.outputPath("fit-separated.png") });
    const fitMargins = await page.evaluate(() => {
      const viewport = document.querySelector(".overview-viewport")!.getBoundingClientRect();
      const mode = document.querySelector<HTMLElement>(".overview-shell")!.dataset.zoomMode;
      const selector = mode === "detail" ? ".overview-card-surface" : mode === "compact" ? ".card-compact" : ".card-map";
      const rects = [...document.querySelectorAll(selector)].map((el) => el.getBoundingClientRect());
      return { left: Math.min(...rects.map((r) => r.left)) - viewport.left, right: viewport.right - Math.max(...rects.map((r) => r.right)), top: Math.min(...rects.map((r) => r.top)) - viewport.top, bottom: viewport.bottom - Math.max(...rects.map((r) => r.bottom)) };
    });
    expect(Math.abs(fitMargins.left - fitMargins.right)).toBeLessThan(2);
    expect(Math.abs(fitMargins.top - fitMargins.bottom)).toBeLessThan(2);
    expect(Math.min(...Object.values(fitMargins))).toBeGreaterThan(20);

    // Exercise actual pointer conversion in map mode; only the dragged node may move.
    await page.locator(".overview-viewport").hover();
    await page.mouse.wheel(0, 1000);
    await expect(shell).toHaveAttribute("data-zoom-mode", "map");
    await checkGeometry();
    const scale = await page.locator(".overview-world").evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).a);
    const label = page.locator(".card-map").last();
    const box = (await label.boundingBox())!;
    await page.mouse.move(box.x + 6, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 26, box.y + box.height / 2 + 30, { steps: 5 });
    await page.mouse.up();
    await checkGeometry();
    await expect.poll(async () => {
      const next = await page.evaluate(() => window.peel.bootstrap());
      return next.state.spaces[space.id]!.nodes["synthetic-3"]!.position.y;
    }).toBeCloseTo(positions[3]!.y + 30 / scale, 2);
    const afterDrag = await page.evaluate(() => window.peel.bootstrap());
    expect(afterDrag.state.spaces[space.id]!.nodes["synthetic-3"]!.position.x).toBeCloseTo(positions[3]!.x + 20 / scale, 2);
    for (const id of ["thread-root", "synthetic-1", "synthetic-2"]) {
      expect(afterDrag.state.spaces[space.id]!.nodes[id]!.position).toEqual(state.spaces[space.id]!.nodes[id]!.position);
    }

    const transitions = await page.evaluate(() => (window as unknown as { geometryAudit: { frames: number; violations: string[] } }).geometryAudit);
    expect(transitions.frames).toBeGreaterThan(20);
    expect(transitions.violations).toEqual([]);
    await page.getByRole("button", { name: `Open ${root.title}`, exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".overview-shell")).toHaveCount(0);
  } finally {
    await app.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
