import { expect, test, type Locator, type Page } from "@playwright/test";
import { newDocument } from "./helpers";

/** Whether an element lies entirely within the window. */
async function onScreen(page: Page, el: Locator) {
  const b = (await el.boundingBox())!;
  const v = page.viewportSize()!;
  return b.x >= 0 && b.y >= 0 && b.x + b.width <= v.width && b.y + b.height <= v.height;
}

test("a context menu opened at the window's corner stays fully on screen", async ({ page }) => {
  await newDocument(page);
  const v = page.viewportSize()!;
  // The canvas's context menu, right-clicked near the bottom-right corner of the viewport area.
  const viewport = (await page.getByTestId("viewport").boundingBox())!;
  await page.mouse.click(viewport.x + viewport.width - 3, viewport.y + viewport.height - 3, { button: "right" });
  const menu = page.getByTestId("context-menu");
  await expect(menu).toBeVisible();
  expect(await onScreen(page, menu)).toBe(true);
  await page.keyboard.press("Escape");
  // And from the bottom of the Layers panel.
  await page.getByTestId("layer-row").first().click({ button: "right", position: { x: 200, y: 20 } });
  expect(await onScreen(page, menu)).toBe(true);
  expect(v.width).toBeGreaterThan(0);
});

test("a submenu that would run off the right edge opens on the left of its menu", async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 700 });
  await newDocument(page, 200, 150);
  await page.getByRole("menuitem", { name: "Image" }).click();
  await page.getByRole("menuitem", { name: "Adjustments" }).hover();
  const sub = page.getByRole("menuitem", { name: "Levels…" });
  await expect(sub).toBeVisible();
  expect(await onScreen(page, sub.locator("xpath=ancestor::*[@role='menu'][1]"))).toBe(true);
});

test("menu rows line up: no check-mark gap in menus without checkable items", async ({ page }) => {
  await newDocument(page);
  await page.getByRole("menuitem", { name: "Edit" }).click();
  // Where each label's text starts.
  const x = (name: string) =>
    page.getByRole("menu").getByText(name, { exact: true }).evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el.childNodes[el.childNodes.length - 1]);
      return r.getBoundingClientRect().x;
    });
  // "Undo" (a command) and "Transform" (a submenu) start at the same place.
  expect(Math.abs((await x("Undo")) - (await x("Transform")))).toBeLessThan(1);
});
