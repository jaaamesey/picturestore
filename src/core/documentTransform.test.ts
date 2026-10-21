import { describe, expect, it } from "vitest";
import { CPU_RASTERIZERS, placementMapping } from "./content";
import { addLayer, createDocument, createLayer, fillPixels, resolutionOf, type Doc, type Placement } from "./document";
import { flatten } from "./composite";
import { affine3, imageSize, imageSizeWindow, resizeCanvas, transformPlacement } from "./documentTransform";
import { rect, scaling, type Vec2 } from "./geometry";
import { rectMask } from "./selection";
import { renderShape } from "./shape";
import { NO_PIXELS, contentBounds, getPixel } from "./pixels";
import { IDENTITY_PATCH, mapPoint, quadOf } from "./warp";

const cpu = CPU_RASTERIZERS;
const red = { r: 255, g: 0, b: 0 }, blue = { r: 0, g: 0, b: 255 };

/** A 200×100 document: a red square (pixels) and a shape with a 4 px centred stroke. */
function doc(): Doc {
  const d = createDocument({ width: 200, height: 100, background: null });
  const pixels = createLayer({ name: "px", pixels: fillPixels(NO_PIXELS, rect(10, 10, 20, 20), red) });
  const geometry = { kind: "rectangle", radius: 5 } as const;
  const style = { fill: null, stroke: { color: blue, width: 4, align: "center" as const } };
  const placement = { source: rect(0, 0, 60, 40), quad: quadOf(rect(100, 30, 60, 40)), angle: 0, patch: null };
  const shape = createLayer({
    name: "shape",
    pixels: renderShape(geometry, style, placementMapping(placement), rect(0, 0, 200, 100)),
    content: { kind: "shape", geometry, style, placement },
  });
  return { ...addLayer(addLayer(d, pixels), shape), selection: rectMask(200, 100, rect(10, 10, 20, 20)) };
}

describe("document transforms", () => {
  it("Image Size scales pixels, vectors, stroke widths and the selection together", async () => {
    const d = doc();
    const big = await imageSize(d, { width: 400, height: 200, resolution: 144, filter: "bicubic", scaleStyles: true }, cpu);
    expect([big.width, big.height, resolutionOf(big)]).toEqual([400, 200, 144]);
    expect(contentBounds(big.layers[1].pixels)).toEqual(rect(20, 20, 40, 40));
    const s = big.layers[2].content;
    if (s.kind !== "shape") throw new Error();
    expect(s.placement.quad).toEqual(quadOf(rect(200, 60, 120, 80)));
    // The stroke scales with the image (Scale Styles), so the outline looks the same, just bigger.
    expect(s.style.stroke!.width).toBe(8);
    const outline = contentBounds(big.layers[2].pixels);
    expect(outline).toEqual(rect(196, 56, 128, 88));
    expect(big.selection!.bounds).toEqual(rect(20, 20, 40, 40));
  });

  it("leaves stroke widths alone without Scale Styles, or when not proportional (as Photoshop does)", async () => {
    const off = await imageSize(doc(), { width: 400, height: 200, resolution: 72, filter: "bicubic", scaleStyles: false }, cpu);
    const stretched = await imageSize(doc(), { width: 400, height: 100, resolution: 72, filter: "bicubic", scaleStyles: true }, cpu);
    for (const d of [off, stretched]) {
      const s = d.layers[2].content;
      expect(s.kind === "shape" && s.style.stroke!.width).toBe(4);
    }
    // Geometry still follows the (non-uniform) scale.
    const s = stretched.layers[2].content;
    expect(s.kind === "shape" && s.placement.quad).toEqual(quadOf(rect(200, 30, 120, 40)));
  });

  it("Canvas Size is the same transform: a whole-pixel translation, copied exactly", async () => {
    const d = doc();
    const moved = await resizeCanvas(d, 300, 100, { x: 1, y: 0.5 }, cpu);
    expect(contentBounds(moved.layers[1].pixels)).toEqual(rect(110, 10, 20, 20));
    expect(getPixel(moved.layers[1].pixels, 115, 15)).toEqual([255, 0, 0, 255]);
    expect(moved.selection!.bounds).toEqual(rect(110, 10, 20, 20));
  });

  it("transforms placements exactly, warps included", () => {
    const warped: Placement = {
      source: rect(0, 0, 10, 10),
      quad: [{ x: 5, y: 5 }, { x: 40, y: 10 }, { x: 35, y: 50 }, { x: 0, y: 30 }] as const,
      angle: 0.3,
      patch: IDENTITY_PATCH.map((p, k) => (k === 6 ? { x: p.x + 0.1, y: p.y + 0.05 } : p)),
    };
    const m = scaling(2, 3);
    const t = transformPlacement(warped, affine3(m));
    const at = (p: Placement, s: number, u: number): Vec2 => mapPoint(placementMapping(p), s, u);
    for (const [s, u] of [[0, 0], [0.3, 0.7], [1, 1], [0.5, 0.2]]) {
      const before = at(warped, s, u), after = at(t, s, u);
      expect(after.x).toBeCloseTo(before.x * 2, 9);
      expect(after.y).toBeCloseTo(before.y * 3, 9);
    }
  });
});

describe("Image Size preview windows", () => {
  it("are exactly the same window of the full result: pixels, shapes and strokes", async () => {
    const d = doc();
    const o = { width: 500, height: 250, resolution: 72, filter: "bicubic" as const, scaleStyles: true };
    const full = await imageSize(d, o, cpu);
    const window = rect(230, 60, 120, 90); // over the shape's top-left corner
    const part = await imageSizeWindow(d, o, window, cpu);
    expect([part.width, part.height]).toEqual([120, 90]);
    const a = flatten(full, window), b = flatten(part);
    let max = 0;
    for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
    expect(max).toBeLessThanOrEqual(1);
    // And something is actually in it.
    expect(b.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
  });

  it("cover reductions too, where the filter reaches further", async () => {
    const d = doc();
    const o = { width: 50, height: 25, resolution: 72, filter: "bicubic" as const, scaleStyles: true };
    const full = await imageSize(d, o, cpu);
    const window = rect(0, 0, 30, 20);
    const a = flatten(full, window), b = flatten(await imageSizeWindow(d, o, window, cpu));
    let max = 0;
    for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
    expect(max).toBeLessThanOrEqual(1);
  });
});
