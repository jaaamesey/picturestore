import { describe, expect, it } from "vitest";
import { flatten } from "./composite";
import { addLayer, createDocument, createLayer, fillPixels, updateLayer, REVEAL_ALL } from "./document";
import { vec, rect } from "./geometry";
import { cornerKnot } from "./path";
import { NO_PIXELS } from "./pixels";
import { resolveVectorMasks } from "./vectorMask";

const square = (x: number, y: number, s: number) => ({
  subpaths: [{ closed: true, op: "combine" as const, knots: [cornerKnot(vec(x, y)), cornerKnot(vec(x + s, y)), cornerKnot(vec(x + s, y + s)), cornerKnot(vec(x, y + s))] }],
});

const docWithRed = () => {
  const d = createDocument({ width: 100, height: 100, background: { r: 255, g: 255, b: 255 } });
  const layer = createLayer({ name: "Red", pixels: fillPixels(NO_PIXELS, rect(0, 0, 100, 100), { r: 255, g: 0, b: 0 }) });
  return addLayer(d, layer);
};
const px = (d: ReturnType<typeof docWithRed>, x: number, y: number) => [...flatten(d, rect(x, y, 1, 1))];

describe("vector masks", () => {
  it("hide everything outside the path", () => {
    const d = docWithRed();
    const masked = updateLayer(d, d.activeLayerId, { vectorMask: { path: square(20, 20, 40), enabled: true } });
    expect(px(masked, 30, 30)).toEqual([255, 0, 0, 255]);
    expect(px(masked, 70, 70)).toEqual([255, 255, 255, 255]);
    expect(px(masked, 10, 30)).toEqual([255, 255, 255, 255]);
  });

  it("are soft at the edge of a path that isn't on pixel boundaries", () => {
    const d = docWithRed();
    const masked = updateLayer(d, d.activeLayerId, { vectorMask: { path: square(20.5, 20, 40), enabled: true } });
    const edge = px(masked, 20, 30);
    expect(edge[1]).toBeGreaterThan(100);
    expect(edge[1]).toBeLessThan(160);
  });

  it("apply together with the layer mask, and disabled ones do nothing", () => {
    const d = docWithRed();
    const id = d.activeLayerId;
    const both = updateLayer(d, id, {
      mask: { ...REVEAL_ALL, pixels: fillPixels(NO_PIXELS, rect(0, 0, 100, 100), { r: 0, g: 0, b: 0 }, null, 0), background: 255 },
      vectorMask: { path: square(20, 20, 40), enabled: true },
    });
    expect(px(both, 30, 30)).toEqual([255, 0, 0, 255]);
    const half = updateLayer(both, id, { mask: { ...REVEAL_ALL, pixels: fillPixels(NO_PIXELS, rect(0, 0, 40, 100), { r: 128, g: 128, b: 128 }), background: 255 } });
    expect(px(half, 30, 30)[1]).toBeGreaterThan(100);
    expect(px(half, 50, 30)).toEqual([255, 0, 0, 255]);
    expect(px(updateLayer(both, id, { vectorMask: { path: square(20, 20, 40), enabled: false } }), 70, 70)).toEqual([255, 0, 0, 255]);
  });

  it("is resolved once per document state, and untouched layers come back as the same array", () => {
    const d = docWithRed();
    expect(resolveVectorMasks(d.layers, 100, 100)).toBe(d.layers);
    const masked = updateLayer(d, d.activeLayerId, { vectorMask: { path: square(0, 0, 10), enabled: true } });
    const a = resolveVectorMasks(masked.layers, 100, 100);
    expect(a).not.toBe(masked.layers);
    expect(resolveVectorMasks(masked.layers, 100, 100)).toBe(a);
  });
});
