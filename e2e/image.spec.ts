import { expect, test, type Page } from "@playwright/test";
import { cpuPixel, drag, expectHistory, newDocument, rectOnLayer, setForeground } from "./helpers";

type Ed = { active(): { doc(): { width: number; height: number; resolution?: number; layers: { content: { kind: string; style?: { stroke: { width: number } | null }; placement?: { quad: { x: number; y: number }[] } } }[] } } };
const doc = (page: Page) => page.evaluate(() => (window.__ps!.editor as Ed).active().doc());

test("a tool flyout picks a tool in one gesture: press, hold, slide, release", async ({ page }) => {
  await newDocument(page);
  const button = (await page.getByTestId("tool-rectangle").boundingBox())!;
  await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId("tool-flyout")).toBeVisible();
  const item = (await page.getByTestId("flyout-polygon").boundingBox())!;
  await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId("tool-polygon")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("tool-flyout")).toHaveCount(0);

  // Released back on the button, it stays open for a click.
  const again = (await page.getByTestId("tool-polygon").boundingBox())!;
  await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
  await page.mouse.down();
  await expect(page.getByTestId("tool-flyout")).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId("tool-flyout")).toBeVisible();
  await page.getByTestId("flyout-ellipse").click();
  await expect(page.getByTestId("tool-ellipse")).toHaveAttribute("aria-pressed", "true");
});

test("Image Size scales pixels, shapes and their strokes together; without Resample only the resolution changes", async ({ page }) => {
  await newDocument(page, 400, 300);
  await rectOnLayer(page, 10, 10, 50, 50, "ff0000");
  // A shape with a 4 px outside stroke.
  await setForeground(page, "00ff00");
  await page.keyboard.press("u");
  await page.getByTestId("shape-stroke").click();
  await page.getByTestId("hex-input").fill("0000ff");
  await page.getByTestId("hex-input").press("Enter");
  await page.getByTestId("color-ok").click();
  await page.getByTestId("shape-stroke-width").fill("4");
  await page.getByTestId("shape-stroke-width").press("Enter");
  await page.getByTestId("shape-stroke-align").selectOption("outside");
  await drag(page, [100, 100], [200, 150]);
  await expectHistory(page, "Rectangle Tool");

  await page.keyboard.press("Alt+Control+i");
  await expect(page.getByTestId("image-size")).toBeVisible();
  await expect(page.getByTestId("image-size-readout")).toHaveText("351.6K");
  await page.getByTestId("image-size-width-unit").selectOption("percent");
  await page.getByTestId("image-size-width").fill("200");
  await page.getByTestId("image-size-width").press("Tab");
  // Proportions are linked: the height follows.
  await expect(page.getByTestId("image-size-height")).toHaveValue("600");
  await expect(page.getByTestId("image-size-readout")).toHaveText("1.37M (was 351.6K)");
  await page.getByTestId("image-size-ok").click();
  await expectHistory(page, "Image Size");

  const d = await doc(page);
  expect([d.width, d.height]).toEqual([800, 600]);
  const shape = d.layers[2].content;
  expect(shape.style!.stroke!.width).toBe(8); // Scale Styles (on by default)
  expect(shape.placement!.quad[0]).toEqual({ x: 200, y: 200 });
  // Pixels: the red square doubled; the shape's fill and its (doubled) outside stroke.
  expect(await cpuPixel(page, 98, 98)).toEqual([255, 0, 0, 255]);
  expect(await cpuPixel(page, 300, 250)).toEqual([0, 255, 0, 255]);
  expect(await cpuPixel(page, 194, 250)).toEqual([0, 0, 255, 255]);
  expect(await cpuPixel(page, 190, 250)).toEqual([255, 255, 255, 255]);

  // Without Resample: same pixels, new resolution.
  await page.keyboard.press("Alt+Control+i");
  await page.getByTestId("image-size-resample").uncheck();
  await page.getByTestId("image-size-resolution").fill("300");
  await page.getByTestId("image-size-resolution").press("Tab");
  await expect(page.getByTestId("image-size-width")).toHaveValue("800");
  await page.getByTestId("image-size-ok").click();
  await expectHistory(page, "Image Size");
  const after = await doc(page);
  expect([after.width, after.height, after.resolution]).toEqual([800, 600, 300]);
});

test("the Image Size preview shows the result at 100%, follows the settings, and pans", async ({ page }) => {
  await newDocument(page, 400, 300);
  await rectOnLayer(page, 180, 130, 220, 170, "ff0000"); // a 40 px red square in the middle
  await page.keyboard.press("Alt+Control+i");
  const preview = page.getByTestId("image-size-preview").locator("canvas");
  const at = (x: number, y: number) =>
    preview.evaluate((c: HTMLCanvasElement, [x, y]) => [...c.getContext("2d")!.getImageData(x, y, 1, 1).data], [x, y]);
  // A 220 px window on the middle of the image: the square spans 90–130 of it.
  await expect.poll(() => at(100, 100)).toEqual([255, 0, 0, 255]);
  expect(await at(140, 110)).toEqual([255, 255, 255, 255]);

  // At 200% the square is 80 px, 70–150 of the window: the preview catches up.
  await page.getByTestId("image-size-width-unit").selectOption("percent");
  await page.getByTestId("image-size-width").fill("200");
  await page.getByTestId("image-size-width").press("Tab");
  await expect.poll(() => at(140, 110)).toEqual([255, 0, 0, 255]);

  // Dragging moves the image under the pointer.
  const box = (await page.getByTestId("image-size-preview").boundingBox())!;
  await page.mouse.move(box.x + 110, box.y + 110);
  await page.mouse.down();
  await page.mouse.move(box.x + 170, box.y + 110, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => at(190, 110)).toEqual([255, 0, 0, 255]);
  expect(await at(120, 110)).toEqual([255, 255, 255, 255]);
});
