import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const desktop = resolve(import.meta.dirname, "..");
const codexMock = join(desktop, "e2e/fixtures/codex");

test("real display math keeps Latin glyphs and CJK scripts separated", async ({}, testInfo) => {
  const scratch = await mkdtemp(join(tmpdir(), "peel-math-layout-"));
  const userData = join(scratch, "data");
  await mkdir(userData);
  await chmod(codexMock, 0o755);
  const app = await electron.launch({
    args: [desktop],
    env: {
      ...process.env,
      PEEL_RENDERER_URL: "",
      PEEL_USER_DATA_PATH: userData,
      PEEL_CODEX_BINARY: codexMock,
      TMPDIR: scratch,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  try {
    const page = await app.firstWindow();
    const searchChats = page.locator(".space-sidebar").getByRole("button", { name: "Search Chats", exact: true });
    await expect(searchChats).toBeEnabled();
    await searchChats.click();
    await page.locator(".thread-result").first().click();
    await expect(page.getByRole("heading", { name: "Direction", exact: true })).toBeVisible();
    const formulas = page.locator(".agent-message .katex-display");
    await expect(formulas).toHaveCount(4);

    for (const size of [
      { name: "normal", width: 1440, height: 960 },
      { name: "narrow", width: 1000, height: 720 },
    ]) {
      await setContentSize(app, size.width, size.height);
      await expect.poll(async () => await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })))
        .toEqual({ width: size.width, height: size.height });
      const latin = await glyphContainment(page, 1);
      expect(latin.visibleText).toBe("Qh=XWhQ,Kh=XWhK,Vh=XWhV");
      expect(latin.visibleTextNodeCount).toBeGreaterThan(15);
      expect(latin.verticallyContained).toBe(true);
      expect(latin.pageFits).toBe(true);
      expect(latin.overflowX).toBe("auto");

      await formulas.nth(1).screenshot({ path: testInfo.outputPath(`latin-${size.name}.png`) });
      await formulas.nth(2).screenshot({ path: testInfo.outputPath(`cjk-apples-takeout-${size.name}.png`) });
      await formulas.nth(3).screenshot({ path: testInfo.outputPath(`cjk-takeout-company-${size.name}.png`) });

      for (const index of [2, 3]) {
        const layout = await cjkScriptLayout(page, index);
        expect(layout.pairs).toHaveLength(2);
        expect(layout.pairs.every((pair) => Number.parseFloat(pair.top) >= 4.5)).toBe(true);
        expect(layout.pairs.every((pair) => pair.fontFamily.includes("Songti SC"))).toBe(true);
        expect(layout.pairs.every((pair) => pair.supCenter + 2 < pair.baseCenter)).toBe(true);
        expect(layout.pairs.every((pair) => pair.baseCenter + 2 < pair.cjkCenter)).toBe(true);
        expect(layout.pairs.every((pair) => pair.cjkBottom <= layout.containerBottom + .5)).toBe(true);
        expect(layout.pageFits).toBe(true);
      }

    }
  } finally {
    await app.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

async function setContentSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
  }, { width, height });
}

async function glyphContainment(page: Page, formulaIndex: number): Promise<{
  overflowX: string;
  pageFits: boolean;
  verticallyContained: boolean;
  visibleText: string;
  visibleTextNodeCount: number;
}> {
  return await page.locator(".agent-message .katex-display").nth(formulaIndex).evaluate((element) => {
    const container = element.getBoundingClientRect();
    const visibleMath = element.querySelector<HTMLElement>(".katex-html")!;
    const walker = document.createTreeWalker(visibleMath, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (current.textContent?.trim()) textNodes.push(current as Text);
    }
    const rangeRect = (node: Node): DOMRect => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect();
    };
    const textRects = textNodes.map(rangeRect);
    const wholeFormula = rangeRect(visibleMath);
    return {
      overflowX: getComputedStyle(element).overflowX,
      pageFits: document.documentElement.scrollWidth === document.documentElement.clientWidth,
      verticallyContained: [wholeFormula, ...textRects]
        .every((glyph) => glyph.top >= container.top - .5 && glyph.bottom <= container.bottom + .5),
      visibleText: (visibleMath.textContent ?? "").replace(/[\s\u200b]/g, ""),
      visibleTextNodeCount: textNodes.length,
    };
  });
}

async function cjkScriptLayout(page: Page, formulaIndex: number): Promise<{
  containerBottom: number;
  pageFits: boolean;
  pairs: Array<{
    baseCenter: number;
    cjkBottom: number;
    cjkCenter: number;
    fontFamily: string;
    supCenter: number;
    top: string;
  }>;
}> {
  return await page.locator(".agent-message .katex-display").nth(formulaIndex).evaluate((element) => {
    const bases = [...element.querySelectorAll<HTMLElement>(".mathnormal")].filter((node) => ["q", "k"].includes(node.textContent ?? ""));
    const cjk = [...element.querySelectorAll<HTMLElement>(".cjk_fallback")];
    const superscripts = [...element.querySelectorAll<HTMLElement>(".mord.mtight")]
      .filter((node) => /^\([12]\)$/.test(node.textContent ?? ""));
    return {
      containerBottom: element.getBoundingClientRect().bottom,
      pageFits: document.documentElement.scrollWidth === document.documentElement.clientWidth,
      pairs: bases.map((base, index) => {
        const baseRect = base.getBoundingClientRect();
        const cjkRect = cjk[index]!.getBoundingClientRect();
        const supRect = superscripts[index]!.getBoundingClientRect();
        return {
          baseCenter: baseRect.top + baseRect.height / 2,
          cjkBottom: cjkRect.bottom,
          cjkCenter: cjkRect.top + cjkRect.height / 2,
          fontFamily: getComputedStyle(cjk[index]!).fontFamily,
          supCenter: supRect.top + supRect.height / 2,
          top: getComputedStyle(cjk[index]!).top,
        };
      }),
    };
  });
}
