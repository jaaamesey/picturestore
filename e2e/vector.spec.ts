import { expect, test } from "@playwright/test";
import { cpuPixel, docPoint, drag, expectHistory, gpuPixels, newDocument, settled } from "./helpers";

/**
 * GPU shape rasterization against the CPU reference (core/shape.ts):
 * fills, strokes in all three alignments, rounded corners, stars, and
 * rotated, perspective and warped placements.
 */
test("GPU shape rendering matches the CPU reference, on screen and read back", async ({ page }) => {
  await page.goto("/?present=readback");
  await page.waitForFunction(() => !!window.__ps?.renderer);
  const result = await page.evaluate(async () => {
    const ps = window.__ps!;
    const ed = ps.editor as {
      openDocument(doc: unknown, name: string): void;
    };
    const ref = ps.reference!;
    const W = 640, H = 480;
    const id = (n: number) => `shape${n}`;
    const red = { r: 230, g: 30, b: 40 }, blue = { r: 20, g: 60, b: 220 }, green = { r: 10, g: 200, b: 90 };
    const unit = Array.from({ length: 16 }, (_, k) => ({ x: (k % 4) / 3, y: Math.floor(k / 4) / 3 }));
    const shapes = [
      {
        geometry: { kind: "rectangle", radius: 24 },
        style: { fill: red, stroke: { color: blue, width: 6, align: "center" } },
        placement: { source: { x: 0, y: 0, w: 200, h: 120 }, quad: [{ x: 20, y: 20 }, { x: 220, y: 20 }, { x: 220, y: 140 }, { x: 20, y: 140 }], angle: 0, patch: null },
      },
      {
        // Rotated, in perspective, with an inside stroke.
        geometry: { kind: "ellipse" },
        style: { fill: green, stroke: { color: red, width: 9, align: "inside" } },
        placement: { source: { x: 0, y: 0, w: 180, h: 140 }, quad: [{ x: 300, y: 40 }, { x: 520, y: 90 }, { x: 470, y: 230 }, { x: 280, y: 170 }], angle: 0.2, patch: null },
      },
      {
        // A star with an outside stroke and no fill, warped, partly off the canvas.
        geometry: { kind: "polygon", sides: 6, starRatio: 0.45 },
        style: { fill: null, stroke: { color: blue, width: 5, align: "outside" } },
        placement: {
          source: { x: 0, y: 0, w: 260, h: 260 },
          quad: [{ x: -60, y: 220 }, { x: 200, y: 220 }, { x: 200, y: 480 }, { x: -60, y: 480 }],
          angle: 0,
          patch: unit.map((p, k) => (k === 5 ? { x: p.x + 0.12, y: p.y - 0.08 } : k === 10 ? { x: p.x - 0.1, y: p.y + 0.1 } : p)),
        },
      },
      {
        // A thin line, exercising near-horizontal edges.
        geometry: { kind: "line" },
        style: { fill: red, stroke: null },
        placement: { source: { x: 0, y: 0, w: 300, h: 3 }, quad: [{ x: 300, y: 400 }, { x: 600, y: 430 }, { x: 599.7, y: 433 }, { x: 299.7, y: 403 }], angle: 0.1, patch: null },
      },
    ];
    const clip = { x: 0, y: 0, w: W, h: H };
    const layers = shapes.map((s, i) => ({
      id: id(i),
      name: `Shape ${i}`,
      visible: true,
      opacity: 1,
      blendMode: "normal",
      tiles: new Map(),
      content: { kind: "shape", ...s },
    }));
    // Display: layers carry no pixels, so everything on screen came from the GPU rasterizer.
    ed.openDocument({ width: W, height: H, layers, activeLayerId: id(0), selection: null }, "Vectors");
    await ps.settled!();
    const gpu = await ps.renderer!.readComposite();
    const reference = layers.map((l) => ({
      ...l,
      tiles: ref.renderShape(l.content.geometry as never, l.content.style as never, ref.placementMapping(l.content.placement as never), clip),
    }));
    const cpu = ref.flatten({ width: W, height: H, layers: reference, activeLayerId: id(0), selection: null } as never);
    const compare = (a: ArrayLike<number>, b: ArrayLike<number>) => {
      let max = 0, over1 = 0, painted = 0;
      for (let i = 0; i < a.length; i += 4) {
        let d = 0;
        // Compare premultiplied, so colour under ~zero alpha doesn't count.
        for (let c = 0; c < 4; c++) {
          const pa = c === 3 ? a[i + 3] : (a[i + c] * a[i + 3]) / 255, pb = c === 3 ? b[i + 3] : (b[i + c] * b[i + 3]) / 255;
          d = Math.max(d, Math.abs(pa - pb));
        }
        if (a[i + 3] || b[i + 3]) painted++;
        max = Math.max(max, d);
        if (d > 1.5) over1++;
      }
      return { max, over1, painted };
    };
    const display = compare(gpu, cpu);
    // Read back (what a commit stores) against the reference, shape by shape.
    const readback = [];
    for (const l of reference) {
      const tiles = await ps.renderer!.rasterizeShape(l.content.geometry as never, l.content.style as never, ref.placementMapping(l.content.placement as never), clip);
      readback.push(compare(ref.readRect(tiles, clip), ref.readRect(l.tiles, clip)));
    }
    return { display, readback };
  });
  expect(result.display.painted).toBeGreaterThan(50_000);
  expect(result.display.max).toBeLessThanOrEqual(2);
  expect(result.display.over1 / result.display.painted).toBeLessThan(0.002);
  for (const r of result.readback) {
    expect(r.max).toBeLessThanOrEqual(2);
    // Nearly every pixel within one level.
    expect(r.over1 / r.painted).toBeLessThan(0.002);
  }
  await settled(page);
});

test("moving a shape follows the pointer with its frame, without rasterizing it again", async ({ page }) => {
  await newDocument(page, 400, 300);
  await page.keyboard.press("u");
  await drag(page, [50, 50], [150, 120]);
  await expectHistory(page, "Rectangle Tool");
  await page.keyboard.press("v");
  const stats = () => page.evaluate(() => ({ ...window.__ps!.renderer!.stats }));
  const before = await stats();
  const a = await docPoint(page, 100, 85);
  const b = await docPoint(page, 160, 125);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
  // The frame is drawn where the shape is now, mid-drag.
  const box = (await page.getByTestId("move-controls").locator("polygon").boundingBox())!;
  const mid = await docPoint(page, 80, 70);
  expect(Math.abs(box.x - mid.x)).toBeLessThan(5); // (a stale frame would be 30 document pixels off)
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  await expectHistory(page, "Move");
  const after = await stats();
  expect(after.shapesRasterized - before.shapesRasterized).toBe(0);
  expect(after.shapesMoved - before.shapesMoved).toBeGreaterThan(3);
  // On screen it's where the committed pixels say.
  expect(await gpuPixels(page, [[115, 115], [105, 105]])).toEqual([await cpuPixel(page, 115, 115), await cpuPixel(page, 105, 105)]);
  expect(await cpuPixel(page, 115, 115)).toEqual([0, 0, 0, 255]);
});
