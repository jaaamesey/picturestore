import { expect, test, type Page } from "@playwright/test";
import { BLACK, WHITE, cpuPixel, docPoint, drag, expectHistory, gpuPixels, historyLabels, newDocument, rectOnLayer, setForeground, settled, withKeys } from "./helpers";

test.describe("Move tool transform controls", () => {
  test("shows controls by default; dragging a handle hands over to Free Transform", async ({ page }) => {
    await newDocument(page);
    await rectOnLayer(page, 100, 100, 150, 150);
    await page.keyboard.press("v");
    await expect(page.getByTestId("show-transform-controls")).toBeChecked();
    await expect(page.getByTestId("move-controls")).toBeVisible();
    await drag(page, [150, 150], [200, 200]); // bottom-right handle, proportional by default
    await expect(page.getByTestId("transform-box")).toBeVisible();
    await page.keyboard.press("Enter");
    await expectHistory(page, "Free Transform");
    expect(await cpuPixel(page, 190, 190)).toEqual(BLACK);
    expect(await cpuPixel(page, 205, 190)).toEqual(WHITE);
    await expect(page.getByTestId("move-controls")).toBeVisible(); // back to the Move tool
  });

  test("controls can be turned off; dragging then just moves", async ({ page }) => {
    await newDocument(page);
    await rectOnLayer(page, 100, 100, 150, 150);
    await page.keyboard.press("v");
    await page.getByTestId("show-transform-controls").uncheck();
    await expect(page.getByTestId("move-controls")).toHaveCount(0);
    await drag(page, [149, 149], [199, 149]);
    await expectHistory(page, "Move");
    expect(await gpuPixels(page, [[175, 125], [110, 125]])).toEqual([BLACK, WHITE]);
  });

  test("dragging inside the box moves by whole pixels", async ({ page }) => {
    await newDocument(page);
    await rectOnLayer(page, 100, 100, 150, 150);
    await page.keyboard.press("v");
    await drag(page, [125, 125], [225, 175]);
    await expectHistory(page, "Move");
    expect(await gpuPixels(page, [[125, 125], [225, 175]])).toEqual([WHITE, BLACK]);
  });
});

test.describe("Free Transform", () => {
  test.beforeEach(async ({ page }) => {
    await newDocument(page);
    await rectOnLayer(page, 100, 100, 200, 200);
    await page.keyboard.press("Control+Alt+t");
    await expect(page.getByTestId("transform-box")).toBeVisible();
  });

  test("Shift scales a corner non-proportionally", async ({ page }) => {
    await withKeys(page, ["Shift"], () => drag(page, [200, 200], [300, 220]));
    await page.keyboard.press("Enter");
    await expectHistory(page, "Free Transform");
    expect(await cpuPixel(page, 290, 215)).toEqual(BLACK);
    expect(await cpuPixel(page, 290, 240)).toEqual(WHITE);
  });

  test("Ctrl drags a single corner (distort)", async ({ page }) => {
    await withKeys(page, ["Control"], () => drag(page, [200, 200], [260, 260]));
    await page.keyboard.press("Enter");
    await expectHistory(page, "Free Transform");
    expect(await cpuPixel(page, 240, 240)).toEqual(BLACK);
    expect(await cpuPixel(page, 105, 105)).toEqual(BLACK); // opposite corner untouched
    expect(await cpuPixel(page, 105, 240)).toEqual(WHITE);
  });

  test("Ctrl+Alt+Shift applies perspective symmetrically", async ({ page }) => {
    await withKeys(page, ["Control", "Alt", "Shift"], () => drag(page, [100, 100], [130, 100]));
    await page.keyboard.press("Enter");
    await expectHistory(page, "Free Transform");
    expect(await cpuPixel(page, 110, 103)).toEqual(WHITE); // top-left pulled in
    expect(await cpuPixel(page, 190, 103)).toEqual(WHITE); // top-right mirrored
    expect(await cpuPixel(page, 150, 103)).toEqual(BLACK);
    expect(await cpuPixel(page, 103, 197)).toEqual(BLACK); // bottom edge unchanged
  });

  test("Skew mode from the context menu slides an edge along its axis", async ({ page }) => {
    const p = await docPoint(page, 150, 150);
    await page.mouse.click(p.x, p.y, { button: "right" });
    await page.getByTestId("context-menu").getByText("Skew").click();
    await expect(page.getByTestId("transform-box")).toHaveAttribute("data-mode", "skew");
    await drag(page, [150, 100], [190, 130]); // top handle: only the x component counts
    await page.keyboard.press("Enter");
    await expectHistory(page, "Skew");
    expect(await cpuPixel(page, 120, 103)).toEqual(WHITE);
    expect(await cpuPixel(page, 235, 103)).toEqual(BLACK);
  });

  test("Ctrl+Z steps back within the session; Escape cancels", async ({ page }) => {
    await drag(page, [200, 200], [250, 250]);
    await drag(page, [150, 150], [170, 150]);
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("transform-box")).toHaveCount(0);
    expect(await historyLabels(page)).not.toContain("Free Transform");
    expect(await gpuPixels(page, [[195, 195], [205, 205]])).toEqual([BLACK, WHITE]);
  });

  test("numeric entry: W with the link scales both axes about the reference point", async ({ page }) => {
    await page.getByTestId("transform-w").fill("50");
    await page.getByTestId("transform-w").press("Enter");
    await expect(page.getByTestId("transform-h")).toHaveValue("50");
    await page.getByTestId("transform-commit").click();
    await expectHistory(page, "Free Transform");
    expect(await cpuPixel(page, 130, 130)).toEqual(BLACK);
    expect(await cpuPixel(page, 120, 120)).toEqual(WHITE);
  });

  test("the reference point is hidden until toggled, and Alt-click moves it", async ({ page }) => {
    await expect(page.getByTestId("reference-point")).toHaveCount(0);
    await page.getByTestId("toggle-reference").check();
    await expect(page.getByTestId("reference-point")).toBeVisible();
    const p = await docPoint(page, 100, 100);
    await withKeys(page, ["Alt"], () => page.mouse.click(p.x, p.y + 20));
    await expect(page.getByTestId("transform-x")).toHaveValue("100");
  });

  test("warp: dragging the surface deforms it, and the GPU commit matches the CPU reference", async ({ page }) => {
    await page.getByTestId("transform-warp").click();
    await expect(page.getByTestId("transform-box")).toHaveAttribute("data-mode", "warp");
    await drag(page, [150, 170], [175, 230]);
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown> & typeof window;
      const ed = w.__ps!.editor as { active(): { floating(): { pixels: { pixels: unknown; bounds: unknown; mapping: unknown } } } };
      const f = ed.active().floating().pixels;
      w.__expected = w.__ps!.reference!.transformFloatingCpu(f as never, f.mapping as never, "bicubic");
    });
    await page.keyboard.press("Enter");
    await expectHistory(page, "Warp");
    const stats = await compareLayerWithExpected(page);
    expect(stats.pixels).toBeGreaterThan(5000);
    expect(stats.mismatched / stats.pixels).toBeLessThan(0.01);
    expect(await cpuPixel(page, 175, 225)).toEqual(BLACK); // pulled down
  });
});

test.describe("Edit ▸ Transform commands", () => {
  test("Flip Horizontal applies immediately, mirroring about the centre", async ({ page }) => {
    await newDocument(page);
    await rectOnLayer(page, 100, 100, 150, 150);
    // Make the shape asymmetric: a red half on the same layer.
    await setForeground(page, "ff0000");
    await page.keyboard.press("m");
    await drag(page, [150, 100], [200, 150]);
    await page.keyboard.press("Alt+Backspace");
    await page.keyboard.press("Control+d");
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await page.getByText("Transform", { exact: true }).hover();
    await page.locator('[data-command="edit.transform.flipHorizontal"]').click();
    await expectHistory(page, "Free Transform");
    expect(await cpuPixel(page, 125, 125)).toEqual([255, 0, 0, 255]);
    expect(await cpuPixel(page, 175, 125)).toEqual(BLACK);
  });
});

/** Compares the active layer with the CPU reference stashed in `window.__expected`. */
async function compareLayerWithExpected(page: Page) {
  await settled(page);
  return page.evaluate(() => {
    const w = window as unknown as Record<string, unknown> & typeof window;
    const ed = w.__ps!.editor as { active(): { doc(): { layers: { id: string; pixels: Map<number, unknown> }[]; activeLayerId: string } } };
    const doc = ed.active().doc();
    const layer = doc.layers.find((l) => l.id === doc.activeLayerId)!;
    const expected = w.__expected as Map<number, unknown>;
    const area = { x: 0, y: 0, w: 400, h: 300 };
    const a = w.__ps!.reference!.readRect(layer.pixels as never, area);
    const b = w.__ps!.reference!.readRect(expected as never, area);
    let pixels = 0, mismatched = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (a[i + 3] === 0 && b[i + 3] === 0) continue;
      pixels++;
      const d = Math.max(...[0, 1, 2, 3].map((c) => Math.abs(a[i + c] - b[i + c])));
      if (d > 3) mismatched++;
    }
    return { pixels, mismatched };
  });
}
