import { expect, test, type Page } from "@playwright/test";
import { click, cpuPixel, docPoint, drag, expectHistory, newDocument, rectOnLayer, screenPixel, settled } from "./helpers";

type Ed = {
  active(): { doc(): { width: number; height: number; resolution?: number }; view(): { zoom: number; rotation?: number } };
  settings: { crop: Record<string, unknown> };
};
const doc = (page: Page) => page.evaluate(() => (window.__ps!.editor as Ed).active().doc());
const view = (page: Page) => page.evaluate(() => (window.__ps!.editor as Ed).active().view());
const cropBox = async (page: Page) => {
  const g = page.getByTestId("crop-box");
  const [w, h, angle] = await Promise.all(["data-w", "data-h", "data-angle"].map((a) => g.getAttribute(a)));
  return { w: Number(w), h: Number(h), angle: Number(angle) };
};

/** A 400×300 white document with a red square at (100, 100)–(150, 150). */
async function setup(page: Page) {
  await newDocument(page, 400, 300);
  await rectOnLayer(page, 100, 100, 150, 150, "ff0000");
  await page.keyboard.press("c");
  await expect(page.getByTestId("tool-crop")).toHaveAttribute("aria-pressed", "true");
}

test("the Crop tool shows a box at once; drawing one and pressing Enter crops to it", async ({ page }) => {
  await setup(page);
  expect(await cropBox(page)).toEqual({ w: 400, h: 300, angle: 0 });
  await drag(page, [80, 90], [180, 170]);
  expect(await cropBox(page)).toMatchObject({ w: 100, h: 80 });
  await page.keyboard.press("Enter");
  await expectHistory(page, "Crop");
  expect(await doc(page)).toMatchObject({ width: 100, height: 80 });
  expect(await cpuPixel(page, 30, 20)).toEqual([255, 0, 0, 255]);
  expect(await cpuPixel(page, 5, 5)).toEqual([255, 255, 255, 255]);
  expect(await screenPixel(page, 30, 20)).toEqual([255, 0, 0, 255]);
  // The box is hidden after a crop, until the next click.
  await expect(page.getByTestId("crop-box")).toHaveCount(0);
  await click(page, 50, 40);
  await expect(page.getByTestId("crop-box")).toHaveCount(1);
});

test("dragging outside the box turns the image under it, on the GPU, and Enter crops it straightened", async ({ page }) => {
  await setup(page);
  // The box's centre is the canvas centre (200, 150): drag a quarter turn around it.
  const c = await docPoint(page, 200, 150);
  await page.mouse.move(c.x + 260, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x, c.y + 260, { steps: 20 });
  await expect(page.getByTestId("crop-readout")).toContainText("°");
  await page.mouse.up();
  const v = await view(page);
  expect(v.rotation).toBeCloseTo(Math.PI / 2, 2);
  // The image is drawn turned: the red square is where the rotated view puts it.
  expect(await screenPixel(page, 125, 125)).toEqual([255, 0, 0, 255]);
  expect(await screenPixel(page, 60, 60)).toEqual([255, 255, 255, 255]);
  const box = await cropBox(page);
  await page.keyboard.press("Enter");
  await expectHistory(page, "Crop");
  expect(await doc(page)).toMatchObject({ width: Math.round(box.w), height: Math.round(box.h) });
  expect((await view(page)).rotation ?? 0).toBe(0);
});

test("the ratio menu, W x H x Resolution, and Delete Cropped Pixels", async ({ page }) => {
  await setup(page);
  await page.getByTestId("crop-preset").click();
  await page.getByRole("menuitem", { name: "1 : 1 (Square)" }).click();
  expect(await cropBox(page)).toMatchObject({ w: 300, h: 300 });
  await expect(page.getByTestId("crop-width")).toHaveValue("1");

  await page.getByTestId("crop-preset").click();
  await page.getByRole("menuitem", { name: "W x H x Resolution" }).click();
  await page.getByTestId("crop-width").fill("2 in");
  await page.getByTestId("crop-width").press("Enter");
  await page.getByTestId("crop-height").fill("1 in");
  await page.getByTestId("crop-height").press("Enter");
  await page.getByTestId("crop-resolution").fill("100");
  await page.getByTestId("crop-resolution").press("Enter");
  expect(await cropBox(page)).toMatchObject({ w: 400, h: 200 });
  await page.getByTestId("crop-commit").click();
  await expectHistory(page, "Crop");
  expect(await doc(page)).toMatchObject({ width: 200, height: 100, resolution: 100 });
});

test("H hides the cropped area, O cycles overlays, and the gear menu switches to Classic Mode", async ({ page }) => {
  await setup(page);
  await drag(page, [50, 50], [300, 250]);
  await expect(page.getByTestId("crop-shield")).toHaveAttribute("opacity", "0.75");
  await page.keyboard.press("h");
  await expect(page.getByTestId("crop-shield")).toHaveAttribute("opacity", "1");
  await page.keyboard.press("h");
  await page.keyboard.press("o");
  expect(await page.evaluate(() => (window.__ps!.editor as Ed).settings.crop.overlay)).toBe("grid");
  await page.getByTestId("crop-settings").click();
  await page.getByTestId("crop-classic").check();
  await page.keyboard.press("Escape");
  // Classic Mode: dragging outside turns the box, not the view.
  const c = await docPoint(page, 175, 150);
  await page.mouse.move(c.x + 250, c.y);
  await page.mouse.down();
  await page.mouse.move(c.x + 200, c.y + 150, { steps: 10 });
  await page.mouse.up();
  expect((await view(page)).rotation ?? 0).toBe(0);
  expect((await cropBox(page)).angle).toBeGreaterThan(0.3);
});

test("Escape resets the crop, the context menu offers Reset Crop, and switching tools crops", async ({ page }) => {
  await setup(page);
  await drag(page, [50, 50], [300, 250]);
  await page.keyboard.press("Escape");
  expect(await cropBox(page)).toMatchObject({ w: 400, h: 300 });
  await drag(page, [50, 50], [300, 250]);
  const p = await docPoint(page, 150, 150);
  await page.mouse.click(p.x, p.y, { button: "right" });
  await page.getByRole("menuitem", { name: "Reset Crop" }).click();
  expect(await cropBox(page)).toMatchObject({ w: 400, h: 300 });
  await drag(page, [50, 50], [300, 250]);
  await page.keyboard.press("b");
  await expectHistory(page, "Crop");
  expect(await doc(page)).toMatchObject({ width: 250, height: 200 });
});

test("Straighten levels a drawn line", async ({ page }) => {
  await setup(page);
  await page.getByTestId("crop-straighten").click();
  await drag(page, [20, 100], [380, 140]);
  const box = await cropBox(page);
  expect(box.angle).toBeCloseTo(Math.atan2(40, 360), 2);
  expect(box.w).toBeLessThan(400);
  await expect(page.getByTestId("crop-straighten")).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("Enter");
  await expectHistory(page, "Crop");
  // No empty corners.
  expect((await cpuPixel(page, 1, 1))[3]).toBe(255);
});

test("Perspective Crop straightens four clicked corners", async ({ page }) => {
  await setup(page);
  await page.keyboard.press("Shift+c");
  await expect(page.getByTestId("tool-perspective-crop")).toHaveAttribute("aria-pressed", "true");
  for (const [x, y] of [[60, 60], [340, 80], [320, 260], [80, 240]] as const) await click(page, x, y);
  await expect(page.getByTestId("perspective-crop")).toHaveAttribute("data-valid", "true");
  await page.keyboard.press("Enter");
  await expectHistory(page, "Perspective Crop");
  const d = await doc(page);
  expect(d.width).toBeGreaterThan(200);
  expect((await cpuPixel(page, 1, 1))[3]).toBe(255);
  await settled(page);
});

test("Image ▸ Crop crops to the selection", async ({ page }) => {
  await setup(page);
  await page.keyboard.press("m");
  await drag(page, [90, 90], [160, 170]);
  await page.getByRole("menuitem", { name: "Image" }).click();
  await page.locator('[data-command="image.crop"]').click();
  await expectHistory(page, "Crop");
  expect(await doc(page)).toMatchObject({ width: 70, height: 80 });
  expect(await cpuPixel(page, 15, 15)).toEqual([255, 0, 0, 255]);
});
