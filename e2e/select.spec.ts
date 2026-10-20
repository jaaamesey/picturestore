import { expect, test } from "@playwright/test";
import { BLACK, WHITE, click, cpuPixel, docPoint, drag, gpuPixels, historyLabels, newDocument, setForeground } from "./helpers";

test("rectangular marquee constrains fill and painting", async ({ page }) => {
  await newDocument(page);
  await page.keyboard.press("m");
  await drag(page, [100, 100], [200, 200]);
  await page.keyboard.press("Alt+Backspace");
  expect(await gpuPixels(page, [[150, 150], [99, 150], [200, 150], [150, 99]])).toEqual([BLACK, WHITE, WHITE, WHITE]);

  await setForeground(page, "ff0000");
  await page.keyboard.press("b");
  await drag(page, [20, 150], [380, 150]);
  expect(await cpuPixel(page, 150, 150)).toEqual([255, 0, 0, 255]);
  expect(await cpuPixel(page, 300, 150)).toEqual(WHITE);
  expect(await historyLabels(page)).toEqual(["New", "Rectangular Marquee", "Fill", "Brush Tool"]);

  await page.keyboard.press("Control+d");
  await page.keyboard.press("Delete");
  expect((await cpuPixel(page, 300, 150))[3]).toBe(0); // no selection: clears the whole layer
});

test("shift adds and alt subtracts selections", async ({ page }) => {
  await newDocument(page);
  await page.keyboard.press("m");
  await drag(page, [0, 0], [100, 100]);
  await page.keyboard.down("Shift");
  await drag(page, [200, 0], [300, 100]);
  await page.keyboard.up("Shift");
  await page.keyboard.down("Alt");
  await drag(page, [50, 0], [250, 50]);
  await page.keyboard.up("Alt");
  await page.keyboard.press("Alt+Backspace");
  expect(await gpuPixels(page, [[25, 75], [275, 75], [25, 25], [150, 75]])).toEqual([BLACK, BLACK, BLACK, WHITE]);
  expect(await cpuPixel(page, 75, 25)).toEqual(WHITE);
});

test("select all, inverse and the elliptical marquee", async ({ page }) => {
  await newDocument(page);
  await page.keyboard.press("Shift+m"); // cycle to the elliptical marquee
  await page.keyboard.press("m");
  await expect(page.getByTestId("tool-marquee-rect")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Shift+m");
  await expect(page.getByTestId("tool-marquee-ellipse")).toHaveAttribute("aria-pressed", "true");
  await drag(page, [100, 50], [300, 250]);
  await page.keyboard.press("Control+Shift+i");
  await page.keyboard.press("Alt+Backspace");
  expect(await gpuPixels(page, [[200, 150], [102, 52]])).toEqual([WHITE, BLACK]);
});

test("lasso and magic wand", async ({ page }) => {
  await newDocument(page);
  await page.keyboard.press("l");
  const pts: [number, number][] = [[50, 50], [250, 50], [250, 250], [50, 250]];
  const first = await docPoint(page, ...pts[0]);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const p of pts.slice(1)) {
    const q = await docPoint(page, ...p);
    await page.mouse.move(q.x, q.y, { steps: 5 });
  }
  await page.mouse.up();
  await page.keyboard.press("Alt+Backspace");
  await page.keyboard.press("Control+d");
  expect(await cpuPixel(page, 150, 150)).toEqual(BLACK);

  await page.keyboard.press("w");
  await click(page, 150, 150);
  await setForeground(page, "00ff00");
  await page.keyboard.press("Alt+Backspace");
  expect(await cpuPixel(page, 150, 150)).toEqual([0, 255, 0, 255]);
  expect(await cpuPixel(page, 350, 150)).toEqual(WHITE);
});

test("paint bucket fills a contiguous region", async ({ page }) => {
  await newDocument(page);
  await page.keyboard.press("m");
  await drag(page, [0, 0], [200, 300]);
  await page.keyboard.press("Alt+Backspace");
  await page.keyboard.press("Control+d");
  await setForeground(page, "0000ff");
  await page.keyboard.press("g");
  await click(page, 300, 150);
  expect(await gpuPixels(page, [[300, 150], [100, 150]])).toEqual([[0, 0, 255, 255], BLACK]);
});
