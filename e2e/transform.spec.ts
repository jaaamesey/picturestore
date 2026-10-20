import { expect, test } from "@playwright/test";
import { BLACK, WHITE, cpuPixel, drag, gpuPixels, historyLabels, newDocument } from "./helpers";

async function squareOnLayer(page: import("@playwright/test").Page) {
  await page.getByTestId("new-layer").click();
  await page.keyboard.press("m");
  await drag(page, [100, 100], [150, 150]);
  await page.keyboard.press("Alt+Backspace");
}

test("free transform scales the selection and commits on Enter", async ({ page }) => {
  await newDocument(page);
  await squareOnLayer(page);
  await page.keyboard.press("Control+Alt+t");
  await expect(page.getByTestId("transform-box")).toBeVisible();
  // Corner handles scale proportionally by default.
  await drag(page, [150, 150], [200, 200]);
  expect(await gpuPixels(page, [[190, 190]])).toEqual([BLACK]); // previewed on the GPU before committing
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("transform-box")).toHaveCount(0);
  expect(await cpuPixel(page, 190, 190)).toEqual(BLACK);
  expect(await cpuPixel(page, 205, 205)).toEqual(WHITE);
  expect(await historyLabels(page)).toContain("Free Transform");
});

test("free transform rotates and cancels with Escape", async ({ page }) => {
  await newDocument(page);
  await squareOnLayer(page);
  await page.keyboard.press("Control+Alt+t");
  await drag(page, [170, 125], [125, 170]); // outside the box: rotate 90° about the centre
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("transform-box")).toHaveCount(0);
  expect(await cpuPixel(page, 125, 125)).toEqual(BLACK);
  expect(await historyLabels(page)).not.toContain("Free Transform");
});

test("free transform accepts numeric input", async ({ page }) => {
  await newDocument(page);
  await squareOnLayer(page);
  await page.keyboard.press("Control+Alt+t");
  const w = page.getByTestId("options-bar").getByRole("spinbutton").nth(2);
  await w.fill("200");
  await w.press("Enter");
  await page.getByTestId("transform-commit").click();
  // Scaled 200% horizontally about the centre: 75..175.
  expect(await cpuPixel(page, 80, 125)).toEqual(BLACK);
  expect(await cpuPixel(page, 170, 125)).toEqual(BLACK);
  expect(await cpuPixel(page, 70, 125)).toEqual(WHITE);
});

test("move tool drags layer pixels", async ({ page }) => {
  await newDocument(page);
  await squareOnLayer(page);
  await page.keyboard.press("Control+d");
  await page.keyboard.press("v");
  await drag(page, [125, 125], [225, 175]);
  expect(await gpuPixels(page, [[125, 125], [225, 175]])).toEqual([WHITE, BLACK]);
  expect(await historyLabels(page)).toContain("Move");
});
