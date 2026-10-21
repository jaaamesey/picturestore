import { expect, test } from "@playwright/test";
import { cpuPixel, drag, expectClose, expectHistory, gpuPixels, historyLabels, newDocument, setForeground } from "./helpers";

test("under GPU memory pressure the canvas is drawn at reduced quality, and commits stay exact", async ({ page }) => {
  // One atlas page holds 64 full-resolution tiles; this document needs 121.
  await newDocument(page, 2600, 2600, "white", "&gpuAtlasPages=1");
  await setForeground(page, "ff0000");
  await page.keyboard.press("Alt+Backspace");
  const indicator = page.getByTestId("memory-indicator");
  await expect(indicator).toBeVisible();
  await expect(indicator).toHaveAttribute("data-gpu-level", "1");
  expectClose((await gpuPixels(page, [[1300, 1300]]))[0], [255, 0, 0, 255]);

  // Transforms still commit at full resolution (on the GPU, or the CPU when it can't).
  await page.keyboard.press("m");
  await drag(page, [0, 0], [100, 100]);
  await page.keyboard.press("Delete");
  await page.keyboard.press("Control+d");
  await page.keyboard.press("Alt+Control+t");
  await page.getByTestId("transform-x").fill("1301");
  await page.getByTestId("transform-x").press("Enter");
  await page.getByTestId("transform-commit").click();
  await expectHistory(page, "Free Transform");
  // Moved one pixel right: single-pixel edges show the layer itself is untouched by the display's reduction.
  expect(await cpuPixel(page, 100, 50)).toEqual([0, 0, 0, 0]);
  expect(await cpuPixel(page, 101, 50)).toEqual([255, 0, 0, 255]);

  await indicator.click();
  await expect(page.getByTestId("memory-details")).toContainText("1/2 resolution");
  await page.getByRole("button", { name: "Retry full quality" }).click();
  // Still too big for one page: it comes straight back to reduced quality.
  await expect(indicator).toHaveAttribute("data-gpu-level", "1");
});

test("Preferences: History States limits undo history, and persists", async ({ page }) => {
  await newDocument(page);
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("preferences")).toBeVisible();
  await expect(page.getByTestId("prefs-pane-general")).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("prefs-pane-cursors")).toBeDisabled();
  await page.getByTestId("prefs-pane-performance").click();
  await page.getByTestId("prefs-history-states").fill("3");
  await page.getByTestId("prefs-ok").click();
  await expect(page.getByTestId("preferences")).toHaveCount(0);

  for (let i = 0; i < 5; i++) await page.getByTestId("new-layer").click();
  expect(await historyLabels(page)).toEqual(["New Layer", "New Layer", "New Layer"]);

  await page.reload();
  await page.keyboard.press("Control+k");
  await page.getByTestId("prefs-pane-performance").click();
  await expect(page.getByTestId("prefs-history-states")).toHaveValue("3");
  // Cancel discards edits.
  await page.getByTestId("prefs-history-states").fill("20");
  await page.getByTestId("prefs-cancel").click();
  await page.keyboard.press("Control+k");
  await page.getByTestId("prefs-pane-performance").click();
  await expect(page.getByTestId("prefs-history-states")).toHaveValue("3");
});

test("history is freed to stay within Memory Usage, never the documents themselves", async ({ page }) => {
  await newDocument(page, 4000, 4000);
  await page.keyboard.press("Control+k");
  await page.getByTestId("prefs-pane-performance").click();
  await page.getByTestId("prefs-memory").fill("128");
  await page.getByTestId("prefs-ok").click();
  // Each full-canvas fill retains 64 MB.
  for (const hex of ["ff0000", "00ff00", "0000ff"]) {
    await setForeground(page, hex);
    await page.keyboard.press("Alt+Backspace");
  }
  await expect(page.getByTestId("memory-indicator")).toHaveAttribute("data-ram", "limited");
  expect((await historyLabels(page)).length).toBeLessThan(4);
  expect(await cpuPixel(page, 2000, 2000)).toEqual([0, 0, 255, 255]);
});

test("unsaved work is recovered after the tab goes away", async ({ page }) => {
  await newDocument(page);
  await setForeground(page, "336699");
  await page.keyboard.press("Alt+Backspace");
  await page.evaluate(() => window.__ps!.saveRecovery!());
  await page.reload();
  await expect(page.getByTestId("confirm-dialog")).toContainText("unsaved document");
  await page.getByTestId("confirm-ok").click();
  await expect(page.getByTestId("doc-tab")).toHaveCount(1);
  await expect(page.getByTestId("doc-tab")).toContainText("*");
  expect(await cpuPixel(page, 10, 10)).toEqual([0x33, 0x66, 0x99, 255]);

  // Recovered once; saving or declining clears it.
  await page.reload();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
});
