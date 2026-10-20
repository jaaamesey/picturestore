import { expect, test } from "@playwright/test";
import { docPoint, newDocument } from "./helpers";

test("zooms with shortcuts and pans with the space bar", async ({ page }) => {
  await newDocument(page);
  const zoom = page.getByTestId("zoom-level");
  await expect(zoom).toHaveText("100%");
  await page.keyboard.press("Control+=");
  await expect(zoom).toHaveText("200%");
  await page.keyboard.press("Control+-");
  await page.keyboard.press("Control+-");
  await expect(zoom).toHaveText("66.7%");
  await page.keyboard.press("Control+1");
  await expect(zoom).toHaveText("100%");

  const before = await docPoint(page, 0, 0);
  await page.keyboard.down("Space");
  await page.mouse.move(before.x + 100, before.y + 100);
  await page.mouse.down();
  await page.mouse.move(before.x + 150, before.y + 130, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  const after = await docPoint(page, 0, 0);
  expect([after.x - before.x, after.y - before.y]).toEqual([50, 30]);
});

test("ctrl+wheel zooms about the cursor", async ({ page }) => {
  await newDocument(page);
  const p = await docPoint(page, 100, 100);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -300);
  await page.keyboard.up("Control");
  await expect(page.getByTestId("zoom-level")).not.toHaveText("100%");
  const q = await docPoint(page, 100, 100);
  expect(Math.abs(q.x - p.x)).toBeLessThan(1);
  expect(Math.abs(q.y - p.y)).toBeLessThan(1);
});
