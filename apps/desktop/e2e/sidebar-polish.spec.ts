import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createSpace, emptyState } from "../src/shared/state";

test("sidebar brand and navigation remain usable at normal and narrow widths", async ({}, testInfo) => {
  const scratch = await mkdtemp(join(tmpdir(), "peel-sidebar-"));
  const desktop = resolve(import.meta.dirname, "..");
  const userData = join(scratch, "data");
  await mkdir(userData);
  const names = ["Product direction", "交互细节与产品体验优化", "A very long workspace name that should truncate", "Research notes", "Release planning"];
  const spaces = Array.from({ length: 30 }, (_, i) => {
    const space = createSpace({ id: "thread-root", name: names[i] ?? `Exploration ${i + 1}`, preview: "", cwd: scratch, createdAt: 1 });
    space.updatedAt = 100 - i;
    return space;
  });
  const first = spaces[0]!;
  await writeFile(join(userData, "peel-state.json"), JSON.stringify({ ...emptyState(), spaces: Object.fromEntries(spaces.map((s) => [s.id, s])), activeSpaceId: first.id, activeThreadId: first.rootThreadId, viewMode: "focus" }));
  const app = await electron.launch({ args: [desktop], env: { ...process.env, PEEL_RENDERER_URL: "", PEEL_USER_DATA_PATH: userData, PEEL_CODEX_BINARY: join(desktop, "e2e/fixtures/codex"), TMPDIR: scratch, ELECTRON_DISABLE_SECURITY_WARNINGS: "true" } });
  try {
    const page = await app.firstWindow();
    const sidebar = page.locator(".space-sidebar");
    const nav = sidebar.getByRole("navigation", { name: "Spaces" });
    await expect(sidebar.getByRole("button", { name: "Search Chats", exact: true })).toBeEnabled();
    for (const [width, height, railWidth, name] of [[1440, 960, 196, "normal"], [1000, 720, 178, "narrow"]] as const) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]!.setContentSize(size.width, size.height), { width, height });
      await expect.poll(async () => (await sidebar.boundingBox())!.width).toBe(railWidth);
      await expect(sidebar.locator(".brand svg")).toBeVisible();
      const layout = await sidebar.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const brand = el.querySelector(".brand")!.getBoundingClientRect();
        const nav = el.querySelector("nav")!;
        const heading = el.querySelector(".sidebar-heading")!.getBoundingClientRect();
        return { dragHeight: el.querySelector(".drag-region")!.getBoundingClientRect().height, brandBelowDrag: brand.top >= 43, headingBelowBrand: heading.top >= brand.bottom, scrollable: nav.scrollHeight > nav.clientHeight, withinSidebar: nav.getBoundingClientRect().bottom <= rect.bottom && rect.bottom <= innerHeight, pageOverflow: document.documentElement.scrollWidth > innerWidth, ellipsis: [...nav.querySelectorAll("strong")].some((e) => e.scrollWidth > e.clientWidth && getComputedStyle(e).textOverflow === "ellipsis") };
      });
      expect(layout).toEqual({ dragHeight: 43, brandBelowDrag: true, headingBelowBrand: true, scrollable: true, withinSidebar: true, pageOverflow: false, ellipsis: true });
      await expect(nav.getByRole("button").first()).toHaveAttribute("aria-current", "page");
      await expect(nav.getByRole("button").nth(2)).toHaveAttribute("title", names[2]!);
      await page.screenshot({ path: testInfo.outputPath(`sidebar-${name}.png`) });
      await sidebar.screenshot({ path: testInfo.outputPath(`sidebar-${name}-detail.png`) });
      const brandBox = await sidebar.locator(".brand").boundingBox();
      await nav.getByRole("button").last().scrollIntoViewIfNeeded();
      expect(await nav.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      expect(await sidebar.locator(".brand").boundingBox()).toEqual(brandBox);
      await nav.evaluate((el) => { el.scrollTop = 0; });
    }
    const second = nav.getByRole("button").nth(1);
    await nav.getByRole("button").first().focus();
    await page.keyboard.press("Tab");
    await expect(second).toBeFocused();
    expect(await second.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");
    await page.keyboard.press("Enter");
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    await expect(sidebar.getByRole("button", { name: `${names[1]}, 1 direction`, exact: true })).toHaveAttribute("aria-current", "page");
    await sidebar.getByRole("button", { name: "Search Chats", exact: true }).click();
    await expect(page.getByLabel("Search Codex Chats")).toBeVisible();
    await page.getByRole("button", { name: "Close Chat picker", exact: true }).click();
    await sidebar.getByRole("button", { name: "New Chat", exact: true }).click();
    await expect(page.getByRole("heading", { name: "New Chat", exact: true })).toBeVisible();
    await page.emulateMedia({ reducedMotion: "reduce", contrast: "more" });
    expect(await nav.locator('[aria-current="page"]').evaluate((el) => getComputedStyle(el).boxShadow)).toContain("rgb(17, 17, 15)");
  } finally {
    await app.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
