import { expect, test } from "@playwright/test";
import { cpuPixel, docPoint, drag, expectClose, newDocument, screenPixel, settled, WHITE } from "./helpers";

test("a 12000×12000 document renders, zoomed out, at 100% and panned", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await newDocument(page, 12000, 12000);
  // A black square near the middle, and one near the far corner.
  await page.keyboard.press("m");
  await drag(page, [5000, 5000], [7000, 7000]);
  await page.keyboard.press("Alt+Backspace");
  await drag(page, [10000, 10000], [11500, 11500]);
  await page.keyboard.press("Alt+Backspace");
  await page.keyboard.press("Control+d");
  expect(await cpuPixel(page, 6000, 6000)).toEqual([0, 0, 0, 255]);
  // Where the squares start (dragged at a coarse zoom, so not exactly where asked).
  const edge = (y: number, from: number) =>
    page.evaluate(([y, from]) => {
      let x = from;
      while (window.__ps!.pixel!(x, y)[0] !== 0) x++;
      return x;
    }, [y, from]);
  const near = await edge(6000, 4900), far = await edge(10750, 9900);

  // Fitted: the whole document is on screen, drawn at about the screen's resolution.
  expectClose(await screenPixel(page, 6000, 6000), [0, 0, 0, 255]);
  expectClose(await screenPixel(page, 3000, 3000), WHITE);
  expectClose(await screenPixel(page, 10750, 10750), [0, 0, 0, 255]);

  // Pixel to Pixel, centred: the square's edge is exact.
  await page.keyboard.press("Control+1");
  await settled(page);
  const { x, y } = await docPoint(page, near, 6000);
  const box = (await page.getByTestId("viewport").boundingBox())!;
  // Bring the square's top-left corner into view.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(x - (box.x + box.width / 2), y - (box.y + box.height / 2));
  await settled(page);
  expectClose(await screenPixel(page, near - 1, 6000), WHITE, 0);
  expectClose(await screenPixel(page, near, 6000), [0, 0, 0, 255], 0);

  // Panned to the far corner.
  const to = await docPoint(page, far, 10750);
  await page.mouse.wheel(to.x - (box.x + box.width / 2), to.y - (box.y + box.height / 2));
  await settled(page);
  expectClose(await screenPixel(page, far - 1, 10750), WHITE, 0);
  expectClose(await screenPixel(page, far, 10750), [0, 0, 0, 255], 0);
  expect(errors).toEqual([]);
});
