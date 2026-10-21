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

test("drag and drop places layers above or below the row, in either direction", async ({ page }) => {
  await newDocument(page);
  for (let i = 0; i < 3; i++) await page.getByTestId("new-layer").click();
  const names = () => page.getByTestId("layer-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-layer-name")));
  const row = (n: string) => page.locator(`[data-layer-name="${n}"]`);
  const upperHalf = { x: 60, y: 8 };
  const lowerHalf = { x: 60, y: 36 };
  expect(await names()).toEqual(["Layer 3", "Layer 2", "Layer 1", "Background"]);

  // Downwards onto the upper half of a lower row: lands directly above it (this used to land below).
  await row("Layer 3").dragTo(row("Layer 1"), { targetPosition: upperHalf });
  expect(await names()).toEqual(["Layer 2", "Layer 3", "Layer 1", "Background"]);

  // Upwards onto the lower half of a higher row: lands directly below it.
  await row("Background").dragTo(row("Layer 2"), { targetPosition: lowerHalf });
  expect(await names()).toEqual(["Layer 2", "Background", "Layer 3", "Layer 1"]);

  // To the very top.
  await row("Layer 1").dragTo(row("Layer 2"), { targetPosition: upperHalf });
  expect(await names()).toEqual(["Layer 1", "Layer 2", "Background", "Layer 3"]);
  await expect(page.getByTestId("history-entry").last()).toHaveText("Layer Order");
  // Dropped rows settle into their slots and nothing is left offset or lifted.
  const rows = page.getByTestId("layer-row");
  await expect.poll(() => rows.evaluateAll((r) => r.flatMap((x) => x.getAnimations()).length)).toBe(0);
  expect(await rows.evaluateAll((r) => r.map((x) => [getComputedStyle(x).transform, x.hasAttribute("data-dragging")]))).toEqual(
    Array(4).fill(["none", false]),
  );
});

test("while dragging, other rows slide aside to open the gap; Escape cancels and everything settles", async ({ page }) => {
  await newDocument(page);
  for (let i = 0; i < 2; i++) await page.getByTestId("new-layer").click();
  const row = (n: string) => page.locator(`[data-layer-name="${n}"]`);
  const names = () => page.getByTestId("layer-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-layer-name")));
  // New rows animate into place: measure once they've settled, or the press can land on another row.
  await expect.poll(() => page.getByTestId("layer-row").evaluateAll((rows) => rows.flatMap((r) => r.getAnimations()).length)).toBe(0);
  const box = (await row("Background").boundingBox())!;
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.down();
  // Up past the middle of "Layer 1" (one row up), not yet that of "Layer 2".
  await page.mouse.move(box.x + 60, box.y + box.height / 2 - box.height * 1.3, { steps: 6 });
  await expect(row("Background")).toHaveAttribute("data-dragging", "");
  await expect.poll(() => row("Layer 1").evaluate((el) => el.style.transform)).toBe(`translateY(${box.height}px)`);
  await expect.poll(() => row("Layer 2").evaluate((el) => el.style.transform)).toBe("");

  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(row("Background")).not.toHaveAttribute("data-dragging");
  expect(await names()).toEqual(["Layer 2", "Layer 1", "Background"]);
  // Settled: no animations left, nothing offset.
  await expect.poll(() => page.getByTestId("layer-row").evaluateAll((rows) => rows.flatMap((r) => r.getAnimations()).length)).toBe(0);
  const offsets = await page.getByTestId("layer-row").evaluateAll((rows) => rows.map((r) => getComputedStyle(r).transform));
  expect(offsets.every((t) => t === "none")).toBe(true);
  await expect(page.getByTestId("history-entry")).toHaveCount(3); // New + 2 × New Layer: nothing recorded
});

test("reorders from anywhere animate, interrupt smoothly, and always end in place", async ({ page }) => {
  await newDocument(page);
  for (let i = 0; i < 3; i++) await page.getByTestId("new-layer").click();
  const names = () => page.getByTestId("layer-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-layer-name")));
  await page.getByTestId("layer-row").last().click(); // Background
  await page.keyboard.press("Control+]");
  // The moved rows are animating towards their new places…
  const running = () => page.getByTestId("layer-row").evaluateAll((rows) => rows.filter((r) => r.getAnimations().length > 0).length);
  expect(await running()).toBeGreaterThan(0);
  // …and a reorder mid-flight continues from where they're drawn.
  await page.keyboard.press("Control+Shift+]");
  expect(await names()).toEqual(["Background", "Layer 3", "Layer 2", "Layer 1"]);
  await expect.poll(running).toBe(0);
  const tops = await page.getByTestId("layer-row").evaluateAll((rows) => rows.map((r) => Math.round(r.getBoundingClientRect().top - rows[0].getBoundingClientRect().top)));
  expect(tops).toEqual([0, 44, 88, 132]);
  await expect(page.getByTestId("history-entry").last()).toHaveText("Bring to Front");
  await page.keyboard.press("Control+z");
  expect(await names()).toEqual(["Layer 3", "Layer 2", "Background", "Layer 1"]);
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
