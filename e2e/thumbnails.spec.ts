import { expect, test } from "@playwright/test";
import { newDocument, rectOnLayer } from "./helpers";

test.use({ deviceScaleFactor: 2 });

test("layer thumbnails are drawn at the screen's resolution, so edges stay sharp", async ({ page }) => {
  await newDocument(page, 400, 300);
  await rectOnLayer(page, 0, 0, 200, 300);
  const thumb = page.locator('[data-testid=layer-row][data-layer-name="Layer 1"] [data-testid=layer-thumbnail] canvas');
  const { width, cssWidth, alpha } = await thumb.evaluate((c: HTMLCanvasElement) => {
    const row = c.getContext("2d")!.getImageData(0, Math.floor(c.height / 2), c.width, 1).data;
    return { width: c.width, cssWidth: c.getBoundingClientRect().width, alpha: [...row.filter((_, i) => i % 4 === 3)] };
  });
  // 36 CSS pixels wide, at 2 device pixels each.
  expect(cssWidth).toBe(36);
  expect(width).toBe(72);
  // The left half is opaque, the right clear, with at most one device pixel between.
  expect(alpha.slice(0, 35).every((a) => a === 255)).toBe(true);
  expect(alpha.slice(37).every((a) => a === 0)).toBe(true);
});
