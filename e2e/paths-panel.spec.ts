import { expect, test, type Page } from "@playwright/test";
import { cpuPixel, docPoint, drag, expectHistory, historyLabels, newDocument, settled } from "./helpers";

async function pen(page: Page, x: number, y: number) {
  const p = await docPoint(page, x, y);
  const before = (await historyLabels(page)).length;
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await historyLabels(page)).length).toBeGreaterThan(before);
  await settled(page);
}

/** A work path in the shape of a triangle, with the Paths panel in front. */
async function triangle(page: Page) {
  await page.keyboard.press("p");
  await page.getByTestId("pen-mode").selectOption("path");
  for (const [x, y] of [[100, 60], [300, 60], [200, 240], [100, 60]]) await pen(page, x, y);
  await page.getByTestId("panel-tab-paths").click();
  await expect(page.getByTestId("path-row")).toHaveCount(1);
}

const selection = (page: Page) =>
  page.evaluate(() => (window.__ps!.editor as { active(): { doc(): { selection: { bounds: unknown } | null } } }).active().doc().selection?.bounds ?? null);

test.describe("Paths panel", () => {
  test("the work path is listed in italics; double-clicking saves it and names it", async ({ page }) => {
    await newDocument(page, 400, 300);
    await triangle(page);
    await expect(page.getByTestId("path-row")).toHaveAttribute("data-kind", "work");
    await expect(page.getByTestId("path-row")).toContainText("Work Path");
    await page.getByTestId("path-row").dblclick();
    await expect(page.getByTestId("path-rename")).toBeFocused();
    await page.getByTestId("path-rename").fill("Triangle");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("path-row")).toHaveCount(1);
    await expect(page.getByTestId("path-row")).toHaveAttribute("data-kind", "saved");
    await expect(page.getByTestId("path-row")).toContainText("Triangle");
  });

  test("Load Path as Selection selects what the path covers", async ({ page }) => {
    await newDocument(page, 400, 300);
    await triangle(page);
    await page.getByTestId("path-row").click();
    await page.getByTestId("paths-selection").click();
    await expectHistory(page, "Make Selection");
    expect(await selection(page)).toEqual({ x: 100, y: 60, w: 200, h: 180 });
  });

  test("Alt-click opens Make Selection's dialog, with feather and an operation", async ({ page }) => {
    await newDocument(page, 400, 300);
    await triangle(page);
    await page.getByTestId("path-row").click();
    await page.getByTestId("paths-selection").click({ modifiers: ["Alt"] });
    await expect(page.getByTestId("path-dialog")).toBeVisible();
    await page.getByTestId("path-feather").fill("10");
    await page.getByTestId("path-feather").press("Tab");
    await page.getByTestId("path-dialog-ok").click();
    await expectHistory(page, "Make Selection");
    const b = (await selection(page)) as { x: number; w: number };
    expect(b.x).toBeLessThan(95);
    expect(b.w).toBeGreaterThan(205);
  });

  test("Fill Path fills the area with the foreground colour", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.getByTestId("new-layer").click();
    await triangle(page);
    await page.getByTestId("path-row").click();
    await page.getByTestId("paths-fill").click();
    await expectHistory(page, "Fill Path");
    expect(await cpuPixel(page, 200, 100)).toEqual([0, 0, 0, 255]);
    expect(await cpuPixel(page, 50, 250)).toEqual([255, 255, 255, 255]);
  });

  test("Stroke Path paints along the path with the brush", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.getByTestId("new-layer").click();
    await triangle(page);
    await page.getByTestId("path-row").click();
    await page.getByTestId("paths-stroke").click();
    await expectHistory(page, "Stroke Path");
    expect((await cpuPixel(page, 200, 60))[0]).toBeLessThan(128);
    expect(await cpuPixel(page, 200, 150)).toEqual([255, 255, 255, 255]);
  });

  test("Make Work Path turns a selection into a path", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.keyboard.press("m");
    await drag(page, [50, 50], [150, 120]);
    await page.getByTestId("panel-tab-paths").click();
    await page.getByTestId("paths-work").click();
    await expectHistory(page, "Make Work Path");
    await expect(page.getByTestId("path-row")).toHaveAttribute("data-kind", "work");
    await expect(page.getByTestId("path-row")).toHaveClass(/bg-accent-soft/);
  });

  test("New Path adds an empty saved path; Delete removes it, and undo brings it back", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.getByTestId("panel-tab-paths").click();
    await page.getByTestId("paths-new").click();
    await expect(page.getByTestId("path-row")).toContainText("Path 1");
    await page.getByTestId("paths-delete").click();
    await expect(page.getByTestId("path-row")).toHaveCount(0);
    await page.keyboard.press("Control+z");
    await expect(page.getByTestId("path-row")).toHaveCount(1);
  });

  test("drawing with the Pen in a selected saved path adds to it, not to a work path", async ({ page }) => {
    await newDocument(page, 400, 300);
    await page.getByTestId("panel-tab-paths").click();
    await page.getByTestId("paths-new").click();
    await page.keyboard.press("p");
    await page.getByTestId("pen-mode").selectOption("path");
    await pen(page, 100, 100);
    await pen(page, 200, 100);
    await expect(page.getByTestId("path-row")).toHaveCount(1);
    await expect(page.getByTestId("path-row")).toHaveAttribute("data-kind", "saved");
  });
});
