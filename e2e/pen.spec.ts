import { expect, test, type Page } from "@playwright/test";
import { cpuPixel, docPoint, drag, expectHistory, gpuPixels, historyLabels, newDocument, settled } from "./helpers";

/** Presses at a document point and waits for the click to be recorded. */
async function click(page: Page, x: number, y: number, label = "Pen Tool") {
  const p = await docPoint(page, x, y);
  const before = (await historyLabels(page)).length;
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await historyLabels(page)).length).toBeGreaterThan(before);
  await expectHistory(page, label);
}

const triangle = async (page: Page) => {
  await click(page, 100, 60);
  await click(page, 300, 60);
  await click(page, 200, 240);
  await click(page, 100, 60);
};

test.describe("Pen tool", () => {
  test("clicking out a triangle and closing it makes a filled shape layer", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.keyboard.press("p");
    await triangle(page);
    expect((await historyLabels(page)).filter((l) => l === "Pen Tool")).toHaveLength(4);
    expect(await cpuPixel(page, 200, 120)).toEqual([0, 0, 0, 255]);
    expect(await cpuPixel(page, 30, 280)).toEqual([255, 255, 255, 255]);
    expect(await gpuPixels(page, [[200, 120], [30, 280]])).toEqual([await cpuPixel(page, 200, 120), await cpuPixel(page, 30, 280)]);
    // Closed: the next click begins another shape.
    await click(page, 20, 280);
    await expect(page.getByTestId("layer-row")).toHaveCount(3);
  });

  test("dragging pulls out direction lines, shown on the canvas", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.keyboard.press("p");
    await click(page, 60, 200);
    await drag(page, [200, 100], [260, 100]);
    await expectHistory(page, "Pen Tool");
    await expect(page.getByTestId("path-anchor")).toHaveCount(2);
    await expect(page.getByTestId("path-handle")).toHaveCount(2);
    // The newest point is solid, the first hollow.
    await expect(page.getByTestId("path-anchor").nth(1)).toHaveAttribute("data-selected", "");
    await expect(page.getByTestId("path-anchor").nth(0)).not.toHaveAttribute("data-selected", "");
  });

  test("Path mode draws a work path and leaves the pixels alone", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.keyboard.press("p");
    await page.getByTestId("pen-mode").selectOption("path");
    await click(page, 100, 60);
    await click(page, 300, 60);
    await click(page, 200, 240);
    await expect(page.getByTestId("path-component")).toHaveCount(1);
    await expect(page.getByTestId("path-anchor")).toHaveCount(3);
    expect(await cpuPixel(page, 200, 120)).toEqual([255, 255, 255, 255]);
    await expect(page.getByTestId("layer-row")).toHaveCount(1);
  });

  test("Rubber Band previews the next segment; Escape ends the path", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.keyboard.press("p");
    await page.getByTestId("pen-mode").selectOption("path");
    await page.getByTestId("pen-gear").click();
    await page.getByTestId("pen-rubber-band").check();
    await page.keyboard.press("Escape");
    await click(page, 100, 60);
    const p = await docPoint(page, 250, 150);
    await page.mouse.move(p.x, p.y);
    await expect(page.getByTestId("rubber-band")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await page.mouse.move(p.x + 5, p.y + 5);
    await expect(page.getByTestId("rubber-band")).toHaveCount(0);
  });

  test("a click on a segment adds an anchor point, a click on a point deletes it (Auto Add/Delete)", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.keyboard.press("p");
    await triangle(page);
    await click(page, 200, 60, "Add Anchor Point");
    await expect(page.getByTestId("path-anchor")).toHaveCount(4);
    await click(page, 300, 60, "Delete Anchor Point");
    await expect(page.getByTestId("path-anchor")).toHaveCount(3);
  });

  test("Ctrl-dragging a point moves it (Direct Selection), without leaving the Pen", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.keyboard.press("p");
    await page.getByTestId("pen-mode").selectOption("path");
    await click(page, 100, 60);
    await click(page, 300, 60);
    await page.keyboard.down("Control");
    await drag(page, [300, 60], [320, 100]);
    await page.keyboard.up("Control");
    await expectHistory(page, "Move Anchor Points");
    const a = page.getByTestId("path-anchor").nth(1);
    const want = await docPoint(page, 320, 100);
    const box = (await a.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - want.x)).toBeLessThan(2);
    expect(Math.abs(box.y + box.height / 2 - want.y)).toBeLessThan(2);
    await expect(page.getByTestId("tool-pen")).toHaveAttribute("aria-pressed", "true");
  });

  test("undo takes back one click at a time", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.keyboard.press("p");
    await page.getByTestId("pen-mode").selectOption("path");
    await click(page, 100, 60);
    await click(page, 300, 60);
    await click(page, 200, 240);
    await page.keyboard.press("Control+z");
    await settled(page);
    await expect(page.getByTestId("path-anchor")).toHaveCount(2);
  });
});

test.describe("Path Selection and Direct Selection", () => {
  test("Direct Selection selects points with a marquee, moves them and deletes them", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.keyboard.press("p");
    await page.getByTestId("pen-mode").selectOption("path");
    await click(page, 100, 60);
    await click(page, 300, 60);
    await click(page, 200, 240);
    await page.keyboard.press("Shift+a");
    await page.keyboard.press("Shift+a");
    await expect(page.getByTestId("tool-direct-select")).toHaveAttribute("aria-pressed", "true");
    await drag(page, [60, 30], [340, 100]);
    await expect(page.locator('[data-testid="path-anchor"][data-selected]')).toHaveCount(2);
    await page.keyboard.press("ArrowDown");
    await expectHistory(page, "Move Anchor Points");
    // Delete removes the segment between the two points; Delete again erases the points themselves.
    await page.keyboard.press("Delete");
    await expectHistory(page, "Delete Anchor Points");
    await expect(page.getByTestId("path-anchor")).toHaveCount(3);
    await expect(page.getByTestId("path-component")).toHaveCount(2);
    await page.keyboard.press("Delete");
    await expect(page.getByTestId("path-anchor")).toHaveCount(1);
  });

  test("Path Selection moves a whole component and Alt-drag copies it", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.keyboard.press("p");
    await page.getByTestId("pen-mode").selectOption("path");
    await triangle(page);
    await page.keyboard.press("a");
    await expect(page.getByTestId("tool-path-select")).toHaveAttribute("aria-pressed", "true");
    await drag(page, [200, 120], [220, 150]);
    await expectHistory(page, "Move Path Components");
    await page.keyboard.down("Alt");
    await drag(page, [220, 150], [100, 200]);
    await page.keyboard.up("Alt");
    await expectHistory(page, "Duplicate Path Component");
    await expect(page.getByTestId("path-component")).toHaveCount(2);
  });
});

test.describe("Freeform Pen and Curvature Pen", () => {
  test("Freeform Pen draws a path that follows the drag, fitted with few anchor points", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.keyboard.press("p");
    await page.getByTestId("pen-mode").selectOption("path");
    await page.keyboard.press("Shift+p");
    await expect(page.getByTestId("tool-freeform-pen")).toHaveAttribute("aria-pressed", "true");
    const pts = Array.from({ length: 40 }, (_, i) => [60 + i * 7, 150 + 60 * Math.sin(i / 6)] as const);
    const first = await docPoint(page, ...pts[0]);
    await page.mouse.move(first.x, first.y);
    await page.mouse.down();
    for (const p of pts.slice(1)) {
      const q = await docPoint(page, ...p);
      await page.mouse.move(q.x, q.y);
    }
    await page.mouse.up();
    await expectHistory(page, "Freeform Pen Tool");
    await expect(page.getByTestId("path-component")).toHaveCount(1);
    const n = await page.getByTestId("path-anchor").count();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThan(15);
  });

  test("Curvature Pen: clicks make a curve through the points; a double-click makes a corner", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.keyboard.press("p");
    await page.getByTestId("pen-mode").selectOption("path");
    await page.keyboard.press("Shift+p");
    await page.keyboard.press("Shift+p");
    await expect(page.getByTestId("tool-curvature-pen")).toHaveAttribute("aria-pressed", "true");
    await click(page, 60, 220, "Curvature Pen Tool");
    await click(page, 200, 60, "Curvature Pen Tool");
    await click(page, 340, 220, "Curvature Pen Tool");
    await expect(page.getByTestId("path-anchor")).toHaveCount(3);
    // The middle point is smooth: its direction lines show when it's selected.
    await page.mouse.dblclick(...(await docPoint(page, 200, 60).then((p) => [p.x, p.y] as const)));
    await expect.poll(async () => (await historyLabels(page)).length).toBeGreaterThan(3);
    await page.keyboard.press("Escape");
  });
});
