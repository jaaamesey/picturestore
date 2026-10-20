import { expect, test } from "@playwright/test";
import { BLACK, WHITE, cpuPixel, drag, expectClose, gpuPixels, historyLabels, newDocument, screenPixel } from "./helpers";

test("creates a document and renders it", async ({ page }) => {
  await newDocument(page);
  expect(await cpuPixel(page, 200, 150)).toEqual(WHITE);
  expect(await gpuPixels(page, [[200, 150]])).toEqual([WHITE]);
  expectClose(await screenPixel(page, 200, 150), WHITE);
  expect(await historyLabels(page)).toEqual(["New"]);
});

test("transparent documents show the checkerboard", async ({ page }) => {
  await newDocument(page, 400, 300, "transparent");
  expect((await cpuPixel(page, 10, 10))[3]).toBe(0);
  const px = await screenPixel(page, 10, 10);
  expect([255, 204]).toContain(px[0]); // checker cells are white or light grey
});

test("paints, undoes and redoes a brush stroke", async ({ page }) => {
  await newDocument(page);
  await page.keyboard.press("b");
  await drag(page, [50, 150], [350, 150]);

  expect(await cpuPixel(page, 200, 150)).toEqual(BLACK);
  expect(await gpuPixels(page, [[200, 150], [200, 50]])).toEqual([BLACK, WHITE]);
  expectClose(await screenPixel(page, 200, 150), BLACK);
  expect(await historyLabels(page)).toEqual(["New", "Brush Tool"]);

  await page.keyboard.press("Control+z");
  expect(await cpuPixel(page, 200, 150)).toEqual(WHITE);
  expect(await gpuPixels(page, [[200, 150]])).toEqual([WHITE]);

  await page.keyboard.press("Control+Shift+z");
  expect(await gpuPixels(page, [[200, 150]])).toEqual([BLACK]);

  // History panel entries are clickable too.
  await page.getByTestId("history-entry").first().click();
  expect(await cpuPixel(page, 200, 150)).toEqual(WHITE);
});

test("brush size and opacity come from the options bar", async ({ page }) => {
  await newDocument(page);
  await page.keyboard.press("b");
  await page.getByTestId("brush-size").fill("60");
  await page.getByTestId("brush-size").press("Enter");
  await page.getByTestId("brush-opacity").fill("50");
  await page.getByTestId("brush-opacity").press("Enter");
  await drag(page, [100, 150], [300, 150]);
  // 50% black over white inside the brush's hard core (80% of a 30px radius), clear outside it.
  expectClose(await cpuPixel(page, 200, 170), [128, 128, 128, 255], 1);
  expectClose((await gpuPixels(page, [[200, 170]]))[0], [128, 128, 128, 255], 1);
  expect(await cpuPixel(page, 200, 181)).toEqual([255, 255, 255, 255]);
});

test("the eraser reveals transparency on a layer", async ({ page }) => {
  await newDocument(page);
  await page.keyboard.press("e");
  await drag(page, [50, 150], [350, 150]);
  expect((await cpuPixel(page, 200, 150))[3]).toBe(0);
  expect(await historyLabels(page)).toEqual(["New", "Eraser"]);
});

test("bracket keys resize the brush", async ({ page }) => {
  await newDocument(page);
  await page.keyboard.press("b");
  await page.keyboard.press("]");
  await expect(page.getByTestId("brush-size")).toHaveValue("25");
  await page.keyboard.press("[");
  await page.keyboard.press("[");
  await expect(page.getByTestId("brush-size")).toHaveValue("15");
});
