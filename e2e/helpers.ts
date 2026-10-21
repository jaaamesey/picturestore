import { expect, type Page } from "@playwright/test";

type RGBA = number[];

/**
 * Replaces the File System Access pickers: opening falls back to <input>
 * (which Playwright drives), and "saving" records what would be written.
 */
export async function stubFilePickers(page: Page, { saveInPlace = true } = {}) {
  await page.addInitScript((inPlace) => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showOpenFilePicker;
    w.__saved = [] as { name: string; blob: Blob }[];
    w.__savePrompts = 0;
    if (!inPlace) {
      delete w.showSaveFilePicker;
      return;
    }
    w.showSaveFilePicker = async (opts: { suggestedName: string }) => {
      (w.__savePrompts as number)++;
      return {
        name: opts.suggestedName,
        createWritable: async () => {
          const chunks: Blob[] = [];
          return {
            write: async (b: Blob) => void chunks.push(b),
            close: async () => void (w.__saved as unknown[]).push({ name: opts.suggestedName, blob: new Blob(chunks) }),
          };
        },
      };
    };
  }, saveInPlace);
}

/** Opens the app and creates a document. Readback presentation keeps headless runs deterministic. */
export async function newDocument(page: Page, width = 400, height = 300, background = "white", query = "") {
  await page.goto(`/?present=readback${query}`);
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
  const v = await page.evaluate(() =>
    (window.__ps!.editor as { active(): { view(): { zoom: number; panX: number; panY: number; rotation?: number } } }).active().view(),
  );
  const c = Math.cos(v.rotation ?? 0), s = Math.sin(v.rotation ?? 0);
  return { x: box.x + v.panX + (c * x - s * y) * v.zoom, y: box.y + v.panY + (s * x + c * y) * v.zoom };
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

/** Waits for an async commit (GPU resample) to land in history. */
export async function expectHistory(page: Page, label: string) {
  await expect(page.getByTestId("history-entry").last()).toHaveText(label);
  await settled(page);
}

/** A filled rectangle on a new layer, deselected. */
export async function rectOnLayer(page: Page, x0: number, y0: number, x1: number, y1: number, hex = "000000") {
  await page.getByTestId("new-layer").click();
  if (hex !== "000000") await setForeground(page, hex);
  await page.keyboard.press("m");
  await drag(page, [x0, y0], [x1, y1]);
  await page.keyboard.press("Alt+Backspace");
  await page.keyboard.press("Control+d");
}

export async function withKeys(page: Page, keys: string[], fn: () => Promise<void>) {
  for (const k of keys) await page.keyboard.down(k);
  await fn();
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
}

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
