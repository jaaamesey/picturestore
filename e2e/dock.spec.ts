import { expect, test, type Page } from "@playwright/test";
import { newDocument } from "./helpers";

const height = async (page: Page, id: string) => (await page.getByTestId(`${id}-panel`).boundingBox())!.height;
const ids = ["history", "properties", "layers"];
/** Within a pixel: flex layout shares out fractional pixels. */
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(1);
const heights = (page: Page) => Promise.all(ids.map((id) => height(page, id)));

/** Presses on `handle` and drags it by (dx, dy), in steps. */
async function dragBy(page: Page, handle: ReturnType<Page["getByTestId"]>, dx: number, dy: number) {
  const b = (await handle.boundingBox())!;
  const x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  await page.mouse.up();
}

test("the dock widens by its edge, panels trade height at their dividers, and the layout is remembered", async ({ page }) => {
  await newDocument(page);
  const dock = page.getByTestId("dock");
  const viewport = page.getByTestId("viewport");
  const width = (await dock.boundingBox())!.width;
  const canvas = (await viewport.boundingBox())!.width;
  // Dragged left, wider; the canvas gives up the room.
  await dragBy(page, page.getByTestId("dock-edge"), -80, 0);
  near((await dock.boundingBox())!.width, width + 80);
  near((await viewport.boundingBox())!.width, canvas - 80);

  // The divider under History: History grows, Properties shrinks, Layers stays.
  const [h0, p0, l0] = await heights(page);
  await dragBy(page, page.getByTestId("dock-divider").first(), 0, 60);
  const [h1, p1, l1] = await heights(page);
  near(h1, h0 + 60);
  near(p1, p0 - 60);
  near(l1, l0);
  // Not below a panel's minimum, however far.
  await dragBy(page, page.getByTestId("dock-divider").first(), 0, 2000);
  near(await height(page, "properties"), 72);
  near(await height(page, "layers"), l0);

  const before = await heights(page);
  await page.reload();
  near((await dock.boundingBox())!.width, width + 80);
  (await heights(page)).forEach((h, i) => near(h, before[i]));
});

test("double-clicking a panel's tab minimizes it to the tab, and the others take the room", async ({ page }) => {
  await newDocument(page);
  const [h0, p0, l0] = await heights(page);
  const tab = page.getByTestId("properties-panel").locator("header");
  await tab.dblclick();
  await expect(page.getByTestId("properties-panel")).toHaveAttribute("data-minimized", "");
  await expect(tab).toHaveAttribute("aria-expanded", "false");
  const [h1, p1, l1] = await heights(page);
  expect(p1).toBeLessThan(40);
  near(h1 + l1, h0 + l0 + p0 - p1);
  // Its state is kept while minimized: restored, it's as it was.
  await tab.dblclick();
  await expect(page.getByTestId("properties-panel")).not.toHaveAttribute("data-minimized");
  (await heights(page)).forEach((h, i) => near(h, [h0, p0, l0][i]));
  // With Properties minimized, the divider under History resizes History against Layers.
  await tab.dblclick();
  await dragBy(page, page.getByTestId("dock-divider").first(), 0, 40);
  const [h2, , l2] = await heights(page);
  near(h2, h1 + 40);
  near(l2, l1 - 40);
});

test("resizing panels only resizes them: their contents aren't rebuilt as the divider moves", async ({ page }) => {
  await newDocument(page);
  // Mark each panel's content; a rebuilt panel would lose the mark.
  await page.evaluate(() => document.querySelectorAll("[data-panel]").forEach((el) => ((el.firstElementChild as HTMLElement & { mark?: boolean }).mark = true)));
  const marked = () => page.evaluate(() => [...document.querySelectorAll("[data-panel]")].map((el) => !!(el.firstElementChild as HTMLElement & { mark?: boolean }).mark));
  await dragBy(page, page.getByTestId("dock-divider").nth(1), 0, -50);
  await dragBy(page, page.getByTestId("dock-divider").first(), 0, 30);
  const after = await marked();
  expect(after.length).toBeGreaterThanOrEqual(3);
  expect(after.every(Boolean)).toBe(true);
});
