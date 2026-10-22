import { expect, test, type Locator, type Page } from "@playwright/test";
import { newDocument } from "./helpers";

/** Presses somewhere neutral: the History panel's tab, atop the dock (above any menu opened from a layer). */
const pressOutside = async (page: Page) => {
  const header = (await page.getByTestId("history-panel").locator("header").boundingBox())!;
  await page.mouse.click(header.x + header.width - 20, header.y + header.height / 2);
};

/** Each popover closes on a press outside it, and on Escape. */
async function dismisses(page: Page, open: () => Promise<void>, popover: Locator) {
  await open();
  await expect(popover).toBeVisible();
  await pressOutside(page);
  await expect(popover).toHaveCount(0);
  await open();
  await expect(popover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
}

test("every popover closes on an outside press and on Escape", async ({ page }) => {
  await newDocument(page);

  // Menu bar menus.
  await dismisses(page, () => page.getByRole("menuitem", { name: "File" }).click(), page.getByRole("menu"));
  // The layer context menu.
  await dismisses(page, () => page.getByTestId("layer-row").first().click({ button: "right" }), page.getByTestId("context-menu"));
  // A tool flyout.
  await dismisses(page, () => page.getByTestId("tool-marquee-rect").click({ button: "right" }), page.getByTestId("tool-flyout"));
  // The foreground colour picker.
  await dismisses(page, () => page.getByTestId("fg-swatch").click(), page.getByTestId("color-picker"));
  // A shape's fill picker.
  await page.keyboard.press("u");
  await dismisses(page, () => page.getByTestId("shape-fill").click(), page.getByTestId("shape-fill-popover"));
});

test("a popover's trigger toggles it, and pressing another trigger switches", async ({ page }) => {
  await newDocument(page);
  await page.keyboard.press("u");
  const fill = page.getByTestId("shape-fill-popover"), stroke = page.getByTestId("shape-stroke-popover");
  await page.getByTestId("shape-fill").click();
  await expect(fill).toBeVisible();
  await page.getByTestId("shape-fill").click();
  await expect(fill).toHaveCount(0);
  // One at a time: opening Stroke closes Fill.
  await page.getByTestId("shape-fill").click();
  await page.getByTestId("shape-stroke").click();
  await expect(fill).toHaveCount(0);
  await expect(stroke).toBeVisible();
  // "No Color" lives inside the picker.
  const none = stroke.getByTestId("color-none");
  const [p, n] = [(await stroke.boundingBox())!, (await none.boundingBox())!];
  expect(n.x >= p.x && n.y >= p.y && n.x + n.width <= p.x + p.width && n.y + n.height <= p.y + p.height).toBe(true);
  await none.click();
  await expect(stroke).toHaveCount(0);
  await expect(page.getByTestId("shape-stroke")).toHaveAttribute("data-color", "none");
});

test("in a dialog, Escape closes the popover first, then the dialog", async ({ page }) => {
  await newDocument(page);
  await page.keyboard.press("Alt+Control+i");
  await page.getByTestId("image-size-gear").click();
  await expect(page.getByTestId("image-size-scale-styles")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("image-size-scale-styles")).toHaveCount(0);
  await expect(page.getByTestId("image-size")).toBeVisible();
  // A press elsewhere in the dialog closes the popover but not the dialog.
  await page.getByTestId("image-size-gear").click();
  await page.getByTestId("image-size-readout").click();
  await expect(page.getByTestId("image-size-scale-styles")).toHaveCount(0);
  await expect(page.getByTestId("image-size")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("image-size")).toHaveCount(0);
});
