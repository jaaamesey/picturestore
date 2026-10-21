import { expect, test, type Page } from "@playwright/test";
import { cpuPixel, drag, expectHistory, historyLabels, newDocument, rectOnLayer, setForeground } from "./helpers";

type Ed = { active(): { doc(): { width: number; height: number; resolution?: number; layers: { content: { kind: string; style?: { stroke: { width: number } | null }; placement?: { quad: { x: number; y: number }[] } } }[] } } };
const doc = (page: Page) => page.evaluate(() => (window.__ps!.editor as Ed).active().doc());

test("a tool flyout picks a tool in one gesture: press, drag off, slide, release", async ({ page }) => {
  await newDocument(page);
  const centre = async (testId: string) => {
    const b = (await page.getByTestId(testId).boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };
  // A click (or trackpad tap) selects the tool and never shows the flyout.
  const rectTool = await centre("tool-rectangle");
  await page.mouse.move(rectTool.x, rectTool.y);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByTestId("tool-rectangle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("tool-flyout")).toHaveCount(0);

  // Press and drag off the button: it opens at once (no hold timer), fading in.
  await page.mouse.down();
  await page.mouse.move(rectTool.x + 30, rectTool.y, { steps: 3 });
  const flyout = page.getByTestId("tool-flyout");
  await expect(flyout).toBeVisible();
  expect(await flyout.evaluate((el) => getComputedStyle(el).animationName)).toBe("fade-in");
  const item = await centre("flyout-polygon");
  await page.mouse.move(item.x, item.y, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId("tool-polygon")).toHaveAttribute("aria-pressed", "true");
  await expect(flyout).toHaveCount(0);

  // Released somewhere that isn't a tool, it stays open for a click.
  const polygon = await centre("tool-polygon");
  await page.mouse.move(polygon.x, polygon.y);
  await page.mouse.down();
  await page.mouse.move(polygon.x + 30, polygon.y + 200, { steps: 3 });
  await page.mouse.up();
  await expect(flyout).toBeVisible();
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
  // History already ends with the first Image Size: wait for the second.
  await expect.poll(async () => (await historyLabels(page)).filter((l) => l === "Image Size").length).toBe(2);
  const after = await doc(page);
  expect([after.width, after.height, after.resolution]).toEqual([800, 600, 300]);
});

test("the Image Size preview fits the whole result, zooms relative to that, and pans when zoomed", async ({ page }) => {
  await newDocument(page, 400, 300);
  await rectOnLayer(page, 180, 130, 220, 170, "ff0000"); // a 40 px red square in the middle
  await page.keyboard.press("Alt+Control+i");
  const canvas = page.getByTestId("image-size-preview").locator("canvas");
  const at = (x: number, y: number) =>
    canvas.evaluate((c: HTMLCanvasElement, [x, y]) => [...c.getContext("2d")!.getImageData(x, y, 1, 1).data], [x, y]);
  const size = () => canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height, c.getBoundingClientRect().width]);
  // Fitted into the 260 px area (×0.65), rendered at the area's own resolution.
  await expect.poll(size).toEqual([260, 195, 260]);
  expect(await at(130, 97)).toEqual([255, 0, 0, 255]);
  expect(await at(150, 97)).toEqual([255, 255, 255, 255]);

  // Twice the size still renders no more pixels than the area has.
  await page.getByTestId("image-size-width-unit").selectOption("percent");
  await page.getByTestId("image-size-width").fill("200");
  await page.getByTestId("image-size-width").press("Tab");
  await expect(page.getByTestId("image-size-readout")).toHaveText("1.37M (was 351.6K)");
  await expect.poll(size).toEqual([260, 195, 260]);

  // 800% of the fit: 100 image pixels across, shown magnified (at the image's own resolution).
  await page.getByTestId("image-size-zoom").selectOption("8");
  await expect.poll(async () => (await size())[0]).toBe(100);
  // The window is centred on the square (360–440): it spans 10–90 of it.
  await expect.poll(async () => [await at(5, 50), await at(50, 50)]).toEqual([[255, 255, 255, 255], [255, 0, 0, 255]]);

  // Drag right by 130 CSS px = 50 image px: the square moves right with the pointer.
  const box = (await page.getByTestId("image-size-preview").boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 130);
  await page.mouse.down();
  await page.mouse.move(box.x + 230, box.y + 130, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => [await at(30, 50), await at(70, 50)]).toEqual([[255, 255, 255, 255], [255, 0, 0, 255]]);
});

test("Image Size previews render in a worker, keeping the main thread free", async ({ page }) => {
  await newDocument(page, 2400, 1800);
  await rectOnLayer(page, 0, 0, 2400, 1800, "336699");
  await page.keyboard.press("Alt+Control+i");
  await expect.poll(() => page.getByTestId("image-size-preview").locator("canvas").evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(0);
  await page.evaluate(() => {
    (window as unknown as { __long: number[] }).__long = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => (window as unknown as { __long: number[] }).__long.push(e.duration))).observe({ type: "longtask" });
  });
  for (const v of ["37", "61", "83", "150"]) {
    await page.getByTestId("image-size-width-unit").selectOption("percent");
    await page.getByTestId("image-size-width").fill(v);
    await page.getByTestId("image-size-width").press("Tab");
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(500);
  const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
  expect(Math.max(0, ...long)).toBeLessThan(100);
});

test("Image Size after its preview resizes the whole image, not the previewed part", async ({ page }) => {
  await newDocument(page, 600, 400);
  // A single pixel layer (the common photo case) with content in its corners, far from the middle.
  await setForeground(page, "ff0000");
  await page.keyboard.press("m");
  await drag(page, [0, 0], [40, 40]);
  await page.keyboard.press("Alt+Backspace");
  await setForeground(page, "0000ff");
  await page.keyboard.press("m");
  await drag(page, [560, 360], [600, 400]);
  await page.keyboard.press("Alt+Backspace");
  await page.keyboard.press("Control+d");
  await page.keyboard.press("Alt+Control+i");
  await page.getByTestId("image-size-width-unit").selectOption("percent");
  await page.getByTestId("image-size-width").fill("150");
  await page.getByTestId("image-size-width").press("Tab");
  // Let a preview of the new size render first.
  await page.waitForTimeout(600);
  await page.getByTestId("image-size-ok").click();
  await expectHistory(page, "Image Size");
  expect(await cpuPixel(page, 10, 10)).toEqual([255, 0, 0, 255]);
  expect(await cpuPixel(page, 890, 590)).toEqual([0, 0, 255, 255]);
});

test("Image Size keeps the zoom and what you were looking at; Canvas Size keeps content still", async ({ page }) => {
  await newDocument(page, 2000, 1500);
  await rectOnLayer(page, 1500, 1000, 1520, 1020, "ff0000"); // a small square off-centre
  type View = { zoom: number; panX: number; panY: number };
  const ed = () => page.evaluate(() => {
    const e = window.__ps!.editor as { active(): { view(): View }; viewportSize(): { width: number; height: number }; setView(v: View): void };
    return { view: e.active().view(), viewport: e.viewportSize() };
  });
  // Zoom in on the square: 400%, centred on it.
  const { viewport } = await ed();
  await page.evaluate(([w, h]) => {
    (window.__ps!.editor as { setView(v: View): void }).setView({ zoom: 4, panX: w / 2 - 1510 * 4, panY: h / 2 - 1010 * 4 });
  }, [viewport.width, viewport.height]);
  await page.keyboard.press("Alt+Control+i");
  await page.getByTestId("image-size-width-unit").selectOption("percent");
  await page.getByTestId("image-size-width").fill("50");
  await page.getByTestId("image-size-width").press("Tab");
  await page.getByTestId("image-size-ok").click();
  await expectHistory(page, "Image Size");
  // (Small enough to fit, an axis would be centred instead; this one isn't.)
  const after = await ed();
  expect(after.view.zoom).toBe(4);
  // The square's centre (now 755, 505) is still in the middle of the viewport.
  expect(Math.abs(after.view.panX + 755 * 4 - viewport.width / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.view.panY + 505 * 4 - viewport.height / 2)).toBeLessThanOrEqual(1);

  // Canvas Size: 100 px more on the left; the square doesn't move on screen.
  await page.keyboard.press("Alt+Control+c");
  await page.getByTestId("canvas-relative").check();
  await page.getByTestId("canvas-width").fill("100");
  await page.getByTestId("canvas-width").press("Tab");
  await page.getByTestId("canvas-anchor-1-0.5").click();
  await page.getByTestId("canvas-ok").click();
  await expectHistory(page, "Canvas Size");
  const grown = await ed();
  expect(grown.view.zoom).toBe(4);
  expect(grown.view.panX + 855 * 4).toBeCloseTo(after.view.panX + 755 * 4, 0);
  expect(grown.view.panY).toBe(after.view.panY);
});
