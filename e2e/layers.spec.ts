import { expect, test } from "@playwright/test";
import { cpuPixel, drag, expectClose, gpuPixels, newDocument, setForeground } from "./helpers";
import { BLEND_MODES } from "../src/core/blend";

test("adds, renames, hides and deletes layers", async ({ page }) => {
  await newDocument(page);
  await page.getByTestId("new-layer").click();
  await page.getByTestId("new-layer").click();
  const rows = page.getByTestId("layer-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toHaveAttribute("data-layer-name", "Layer 2");

  await rows.first().locator("span").dblclick();
  await page.keyboard.type("Sky");
  await page.keyboard.press("Enter");
  await expect(rows.first()).toHaveAttribute("data-layer-name", "Sky");

  await setForeground(page, "ff0000");
  await page.keyboard.press("Alt+Backspace");
  expect(await cpuPixel(page, 10, 10)).toEqual([255, 0, 0, 255]);
  await rows.first().getByTestId("layer-visibility").click();
  expect(await gpuPixels(page, [[10, 10]])).toEqual([[255, 255, 255, 255]]);

  await page.getByTestId("delete-layer").click();
  await expect(rows).toHaveCount(2);
});

test("GPU compositing matches the CPU reference for every blend mode", async ({ page }) => {
  await newDocument(page);
  // Backdrop: two colours on the background layer.
  await setForeground(page, "3080c0");
  await page.keyboard.press("m");
  await drag(page, [0, 0], [200, 300]);
  await page.keyboard.press("Alt+Backspace");
  // Source: a translucent layer with two colours overlapping both backdrop colours.
  await page.getByTestId("new-layer").click();
  await setForeground(page, "c04020");
  await drag(page, [100, 0], [300, 150]);
  await page.keyboard.press("Alt+Backspace");
  await setForeground(page, "e0d060");
  await drag(page, [100, 150], [300, 300]);
  await page.keyboard.press("Alt+Backspace");
  await page.keyboard.press("Control+d");
  await page.getByTestId("layer-opacity").fill("70");
  await page.getByTestId("layer-opacity").press("Enter");

  const points: [number, number][] = [[150, 75], [250, 75], [150, 225], [250, 225], [50, 50]];
  for (const mode of BLEND_MODES) {
    await page.getByTestId("blend-mode").selectOption(mode);
    const gpu = await gpuPixels(page, points);
    for (let i = 0; i < points.length; i++) expectClose(gpu[i], await cpuPixel(page, ...points[i]), 2);
  }
});
