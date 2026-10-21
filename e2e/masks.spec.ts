import { expect, test, type Page } from "@playwright/test";
import { cpuPixel, drag, expectClose, expectHistory, gpuPixels, newDocument, rectOnLayer } from "./helpers";

/**
 * Layer masks as Photoshop's manual describes them, driven through the UI.
 * The document: a red layer over white, its mask with black painted over
 * the left half (so the left shows white, the right red).
 */
const RED = [255, 0, 0, 255], WHITE = [255, 255, 255, 255];
const L = [50, 75] as [number, number], R = [150, 75] as [number, number];

const maskThumb = (page: Page) => page.locator('[data-layer-name="Layer 1"]').getByTestId("mask-thumbnail");

async function maskedRed(page: Page) {
  await newDocument(page, 200, 150);
  await rectOnLayer(page, 0, 0, 200, 150, "ff0000");
  await page.getByTestId("add-mask").click();
  // The mask is targeted: black (D, then X: masks default to white on black) on the left half.
  await page.keyboard.press("d");
  await page.keyboard.press("x");
  await page.keyboard.press("m");
  await drag(page, [0, 0], [100, 150]);
  await page.keyboard.press("Alt+Backspace");
  await page.keyboard.press("Control+d");
  await expectHistory(page, "Deselect");
}

async function expectBoth(page: Page, at: [number, number], rgba: number[]) {
  expect(await cpuPixel(page, ...at)).toEqual(rgba);
  expectClose((await gpuPixels(page, [at]))[0], rgba);
}

test.describe("layer masks", () => {
  test.beforeEach(({ page }) => maskedRed(page));

  test("black hides, white reveals", async ({ page }) => {
    await expectBoth(page, L, WHITE);
    await expectBoth(page, R, RED);
  });

  test("Ctrl+I with the mask targeted inverts all of it", async ({ page }) => {
    await page.keyboard.press("Control+i");
    await expectHistory(page, "Invert");
    await expectBoth(page, L, RED);
    await expectBoth(page, R, WHITE);
  });

  test("the swatches show greys while the mask is targeted", async ({ page }) => {
    await expect(page.locator("[data-mask-target]")).toHaveCount(1);
    await page.locator('[data-layer-name="Layer 1"]').getByTestId("layer-thumbnail").click();
    await expect(page.locator("[data-mask-target]")).toHaveCount(0);
  });

  test("Alt-click the mask thumbnail shows the mask alone; again goes back", async ({ page }) => {
    await maskThumb(page).click({ modifiers: ["Alt"] });
    await expectBoth(page, L, [0, 0, 0, 255]);
    await expectBoth(page, R, WHITE);
    await maskThumb(page).click({ modifiers: ["Alt"] });
    await expectBoth(page, L, WHITE);
    await expectBoth(page, R, RED);
  });

  test("Shift-click the mask thumbnail disables it", async ({ page }) => {
    await maskThumb(page).click({ modifiers: ["Shift"] });
    await expect(maskThumb(page)).not.toHaveAttribute("data-enabled");
    await expectBoth(page, L, RED);
  });

  test("Ctrl-click the mask thumbnail loads it as a selection", async ({ page }) => {
    await maskThumb(page).click({ modifiers: ["Control"] });
    await expectHistory(page, "Load Selection");
    const bounds = await page.evaluate(() => (window.__ps!.editor as { active(): { doc(): { selection: { bounds: unknown } } } }).active().doc().selection.bounds);
    expect(bounds).toEqual({ x: 100, y: 0, w: 100, h: 150 });
  });

  test("Density lessens what it hides", async ({ page }) => {
    const density = page.getByTestId("mask-properties").getByTestId("slider-density").locator("input[type=number]");
    await density.fill("50");
    await density.press("Enter");
    await expectHistory(page, "Mask Density");
    await expectBoth(page, L, [255, 128, 128, 255]);
  });

  test("the trash with the mask targeted removes the mask, applying it if asked", async ({ page }) => {
    await page.getByTestId("delete-layer").click();
    await expect(page.getByTestId("choice-dialog")).toContainText("Apply mask to layer before removing?");
    await page.getByTestId("choice-0").click(); // Apply
    await expectHistory(page, "Apply Layer Mask");
    await expect(maskThumb(page)).toHaveCount(0);
    await expect(page.locator('[data-layer-name="Layer 1"]')).toHaveCount(1);
    await expectBoth(page, L, WHITE);
    await expectBoth(page, R, RED);
  });

  test("the eraser on a mask paints the background colour", async ({ page }) => {
    await page.keyboard.press("x"); // white foreground, black background: the eraser paints black, hiding
    await page.keyboard.press("e");
    await drag(page, [150, 20], [150, 130], 10);
    await expectHistory(page, "Eraser");
    await expectBoth(page, R, WHITE);
  });
});
