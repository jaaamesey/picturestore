import { expect, type Page } from "@playwright/test";

type RGBA = number[];

/** Opens the app and creates a document. Readback presentation keeps headless runs deterministic. */
export async function newDocument(page: Page, width = 400, height = 300, background = "white") {
  await page.goto("/?present=readback");
  await page.getByTestId("start-new").click();
  await page.getByTestId("new-width").fill(String(width));
  await page.getByTestId("new-width").press("Tab");
  await page.getByTestId("new-height").fill(String(height));
  await page.getByTestId("new-height").press("Tab");
  await page.getByTestId("new-background").selectOption(background);
  await page.getByTestId("new-create").click();
  await expect(page.getByTestId("doc-tab")).toHaveCount(1);
  await settled(page);
}

export const settled = (page: Page) => page.evaluate(() => window.__ps!.settled!());

/** Page coordinates of a document point under the current view. */
export async function docPoint(page: Page, x: number, y: number) {
  const box = (await page.getByTestId("viewport").boundingBox())!;
  const v = await page.evaluate(() => (window.__ps!.editor as { active(): { view(): { zoom: number; panX: number; panY: number } } }).active().view());
  return { x: box.x + v.panX + x * v.zoom, y: box.y + v.panY + y * v.zoom };
}

export async function drag(page: Page, from: [number, number], to: [number, number], steps = 10) {
  const a = await docPoint(page, ...from);
  const b = await docPoint(page, ...to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
}

export async function click(page: Page, x: number, y: number) {
  const p = await docPoint(page, x, y);
  await page.mouse.click(p.x, p.y);
}

/** The CPU reference composite. */
export const cpuPixel = (page: Page, x: number, y: number): Promise<RGBA> =>
  page.evaluate(([x, y]) => window.__ps!.pixel!(x, y), [x, y]);

/** The GPU composite, read back from the renderer. */
export async function gpuPixels(page: Page, points: [number, number][]): Promise<RGBA[]> {
  await settled(page);
  return page.evaluate(async (pts) => {
    const ed = window.__ps!.editor as { active(): { doc(): { width: number } } };
    const w = ed.active().doc().width;
    const data = await window.__ps!.renderer!.readComposite();
    return pts.map(([x, y]) => [...data.slice((y * w + x) * 4, (y * w + x) * 4 + 4)]);
  }, points);
}

/** What's actually on screen at a document point. */
export async function screenPixel(page: Page, x: number, y: number): Promise<RGBA> {
  await settled(page);
  const p = await docPoint(page, x + 0.5, y + 0.5);
  const png = await page.screenshot({ clip: { x: Math.floor(p.x), y: Math.floor(p.y), width: 1, height: 1 } });
  return page.evaluate(async (b64) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const ctx = new OffscreenCanvas(1, 1).getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    return [...ctx.getImageData(0, 0, 1, 1).data];
  }, png.toString("base64"));
}

export const historyLabels = (page: Page) => page.getByTestId("history-entry").allInnerTexts();

export function expectClose(actual: RGBA, expected: RGBA, tolerance = 2) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(Math.abs(v - expected[i]), `channel ${i}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance));
}

export async function setForeground(page: Page, hex: string) {
  await page.getByTestId("fg-swatch").click();
  await page.getByTestId("hex-input").fill(hex);
  await page.getByTestId("hex-input").press("Enter");
  await page.getByTestId("color-ok").click();
}

export const WHITE = [255, 255, 255, 255];
export const BLACK = [0, 0, 0, 255];
