import { expect, test, type Page } from "@playwright/test";
import { docPoint, drag, expectHistory, newDocument, rectOnLayer, settled } from "./helpers";

type Ed = {
  active(): { doc(): { guides?: { orientation: string; position: number }[]; selection: { bounds: { x: number; y: number; w: number; h: number } } | null } };
  viewOptions(): Record<string, unknown>;
};
const doc = (page: Page) => page.evaluate(() => (window.__ps!.editor as Ed).active().doc());
const menu = async (page: Page, title: string, command: string, sub?: string) => {
  await page.getByRole("menuitem", { name: title, exact: true }).click();
  if (sub) await page.getByRole("menuitem", { name: sub }).hover();
  await page.locator(`[data-command="${command}"]`).click();
};

test.beforeEach(async ({ page }) => {
  // View options are remembered; start from Photoshop's defaults.
  await page.addInitScript(() => localStorage.removeItem("picturestore.view"));
});

test("guides: dragged out of the rulers (snapping as they go), and a marquee snaps to them", async ({ page }) => {
  await newDocument(page, 400, 300);
  await page.keyboard.press("Control+r");
  await expect(page.getByTestId("ruler-top")).toBeVisible();
  // A vertical guide from the left ruler, dropped 4 px from the canvas centre: it snaps there.
  const left = (await page.getByTestId("ruler-left").boundingBox())!;
  const target = await docPoint(page, 196, 150);
  await page.mouse.move(left.x + 8, target.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await expect(page.getByTestId("guide-preview")).toHaveCount(1);
  await page.mouse.up();
  await expectHistory(page, "New Guide");
  expect((await doc(page)).guides).toEqual([{ orientation: "vertical", position: 200 }]);
  await expect(page.getByTestId("guide")).toHaveCount(1);

  // A marquee dragged to 5 px short of the guide ends on it.
  await page.keyboard.press("m");
  await drag(page, [100, 100], [195, 180]);
  expect((await doc(page)).selection!.bounds).toMatchObject({ x: 100, w: 100 });

  // Dropped back on the ruler, a new guide is cancelled.
  await page.mouse.move(left.x + 8, target.y);
  await page.mouse.down();
  await page.mouse.move(left.x + 30, target.y, { steps: 3 });
  await page.mouse.move(left.x + 8, target.y, { steps: 3 });
  await page.mouse.up();
  expect((await doc(page)).guides).toHaveLength(1);
});

test("the Move tool snaps a layer to another's edge, showing smart guides while it aligns", async ({ page }) => {
  await newDocument(page, 400, 300);
  await rectOnLayer(page, 20, 20, 60, 60, "ff0000");
  await rectOnLayer(page, 200, 200, 240, 240, "0000ff");
  await page.keyboard.press("v");
  const a = await docPoint(page, 220, 220), b = await docPoint(page, 43, 220);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 10 });
  await expect(page.getByTestId("smart-guide")).not.toHaveCount(0);
  await page.mouse.up();
  await expectHistory(page, "Move");
  await expect(page.getByTestId("smart-guide")).toHaveCount(0);
  // Its left edge (23) snapped to the red square's left edge (20).
  expect(await page.evaluate(() => window.__ps!.pixel!(20, 210))).toEqual([0, 0, 255, 255]);
  expect(await page.evaluate(() => window.__ps!.pixel!(19, 210))).toEqual([255, 255, 255, 255]);
});

test("View ▸ New Guide, Lock Guides and Clear Guides; Snap To and Show toggles", async ({ page }) => {
  await newDocument(page, 400, 300);
  await menu(page, "View", "view.newGuide");
  await page.getByTestId("guide-vertical").check();
  await page.getByTestId("guide-position").fill("1 in");
  await page.getByTestId("guide-ok").click();
  await expectHistory(page, "New Guide");
  expect((await doc(page)).guides).toEqual([{ orientation: "vertical", position: 72 }]);

  // Snap To ▸ Guides off: a marquee near it no longer snaps.
  await menu(page, "View", "view.snapTo.guides", "Snap To");
  await page.keyboard.press("m");
  await drag(page, [10, 10], [69, 100]);
  expect((await doc(page)).selection!.bounds.w).toBe(59);

  await page.keyboard.press("Control+;");
  await expect(page.getByTestId("guide")).toHaveCount(0);
  await page.keyboard.press("Control+;");
  await expect(page.getByTestId("guide")).toHaveCount(1);

  await page.keyboard.press("Control+'");
  await expect(page.getByTestId("grid-line")).not.toHaveCount(0);
  await page.keyboard.press("Control+h");
  await expect(page.getByTestId("grid-line")).toHaveCount(0);
  await expect(page.getByTestId("guide")).toHaveCount(0);
  await page.keyboard.press("Control+h");

  await menu(page, "View", "view.clearGuides");
  await expectHistory(page, "Clear Guides");
  expect((await doc(page)).guides).toEqual([]);
  await settled(page);
});

test("the grid's spacing follows Preferences ▸ Guides, Grid & Slices, and things snap to it", async ({ page }) => {
  await newDocument(page, 400, 300);
  await page.keyboard.press("Control+k");
  await page.getByTestId("prefs-pane-guides").click();
  await page.getByTestId("prefs-grid-every").fill("100");
  await page.getByTestId("prefs-grid-every").press("Tab");
  await page.getByTestId("prefs-grid-unit").selectOption("pixels");
  await page.getByTestId("prefs-grid-subdivisions").fill("4");
  await page.getByTestId("prefs-grid-subdivisions").press("Tab");
  await page.getByRole("button", { name: "OK" }).click();
  await page.keyboard.press("Control+'");
  // Lines every 25 px, edges included: 17 across 400 px and 13 down 300.
  await expect(page.getByTestId("grid-line")).toHaveCount(17 + 13);
  await page.keyboard.press("m");
  await drag(page, [27, 22], [123, 148]);
  expect((await doc(page)).selection!.bounds).toEqual({ x: 25, y: 25, w: 100, h: 125 });
});
