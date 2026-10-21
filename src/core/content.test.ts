import { describe, expect, it } from "vitest";
import { initialPlacement, placementMapping, resizeCanvas, resizedPlacement, smartObjectLayer, smartSource, CPU_RASTERIZERS } from "./content";
import { addLayer, convertToSmartObject, createDocument, createLayer, fillTiles, rasterizeLayer } from "./document";
import { rect } from "./geometry";
import { EMPTY_TILES, contentBounds, getPixel, tilesFromImage } from "./tiles";
import { IDENTITY_PATCH, mapPoint, quadOf, type Mapping } from "./warp";
import type { Placement } from "./document";

const cpu = CPU_RASTERIZERS;

describe("smart objects", () => {
  const checker = new Uint8ClampedArray(64 * 64 * 4).map((_, i) => (i % 4 === 3 ? 255 : (Math.floor(i / 4) % 64) * 4));
  const source = smartSource("photo.png", 64, 64, tilesFromImage(64, 64, checker));

  it("places centred, shrinking only when larger than the canvas", () => {
    expect(initialPlacement(64, 32, 200, 100).quad[0]).toEqual({ x: 68, y: 34 });
    const big = initialPlacement(400, 100, 200, 100);
    expect(big.quad[1].x - big.quad[0].x).toBe(200);
    expect(big.quad[2].y - big.quad[1].y).toBe(50);
  });

  it("renders through its placement and re-renders losslessly from the source", async () => {
    const doc = createDocument({ width: 200, height: 200, background: null });
    const layer = await smartObjectLayer(doc, source, cpu);
    expect(layer.content.kind).toBe("smart");
    expect(contentBounds(layer.tiles)).toEqual(rect(68, 68, 64, 64));
    // Shrink to 8×8 then back to 64×64: the source is untouched, so detail returns.
    if (layer.content.kind !== "smart") throw new Error();
    const tiny = { ...layer.content.placement, quad: quadOf(rect(0, 0, 8, 8)) };
    const back = { ...tiny, quad: quadOf(rect(0, 0, 64, 64)) };
    const restored = await cpu.resample({ tiles: source.tiles, bounds: rect(0, 0, 64, 64) }, placementMapping(back), "bicubic", rect(0, 0, 200, 200));
    expect(getPixel(restored, 10, 5)).toEqual(getPixel(source.tiles, 10, 5));
  });

  it("converts pixel layers in place and rasterizes back", () => {
    const d0 = createDocument({ width: 100, height: 100 });
    const d1 = addLayer(d0, createLayer({ name: "L", tiles: fillTiles(EMPTY_TILES, rect(10, 20, 30, 40), { r: 1, g: 2, b: 3 }) }));
    const smart = convertToSmartObject(d1, d1.activeLayerId);
    const layer = smart.layers[1];
    if (layer.content.kind !== "smart") throw new Error("expected smart object");
    expect(layer.content.source.width).toBe(30);
    expect(layer.content.placement.quad[0]).toEqual({ x: 10, y: 20 });
    expect(getPixel(layer.content.source.tiles, 0, 0)).toEqual([1, 2, 3, 255]);
    expect(layer.tiles).toBe(d1.layers[1].tiles); // pixels unchanged
    expect(rasterizeLayer(smart, layer.id).layers[1].content.kind).toBe("pixels");
  });
});

describe("resizing smart object contents (Canvas Size in Edit Contents)", () => {
  /** Where source pixel (x, y) lands in the document. */
  const at = (m: Mapping, x: number, y: number) => mapPoint(m, x / m.source.w, y / m.source.h);
  const close = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
  };
  // Scaled 2×, rotated 30° and in perspective.
  const rotated: Placement = {
    source: rect(0, 0, 100, 50),
    quad: [{ x: 100, y: 100 }, { x: 273, y: 200 }, { x: 230, y: 290 }, { x: 60, y: 180 }],
    angle: Math.PI / 6,
    patch: null,
  };

  it("keeps the transform and centres the new contents on the old", () => {
    // 20 px of new canvas on every side: old pixel (x, y) is new pixel (x + 20, y + 20).
    const next = resizedPlacement(rotated, 140, 90);
    expect(next.source).toEqual(rect(0, 0, 140, 90));
    for (const [x, y] of [[0, 0], [100, 50], [37, 12], [50, 25]]) close(at(placementMapping(next), x + 20, y + 20), at(placementMapping(rotated), x, y));
  });

  it("is exact under a warp, too", () => {
    const warped: Placement = { ...rotated, patch: IDENTITY_PATCH.map((p, k) => (k === 5 ? { x: p.x + 0.1, y: p.y - 0.05 } : p)) };
    const next = resizedPlacement(warped, 60, 50); // cropped 20 px off each side
    for (const [x, y] of [[0, 0], [60, 50], [13, 41]]) close(at(placementMapping(next), x, y), at(placementMapping(warped), x + 20, y));
  });

  it("is a no-op at the same size", () => {
    expect(resizedPlacement(rotated, 100, 50)).toBe(rotated);
  });
});

describe("Canvas Size", () => {
  it("places content by the anchor and keeps what falls outside", async () => {
    const d = createDocument({ width: 100, height: 100, background: { r: 255, g: 0, b: 0 } });
    const centred = await resizeCanvas(d, 200, 50, { x: 0.5, y: 0.5 }, cpu);
    expect([centred.width, centred.height]).toEqual([200, 50]);
    expect(contentBounds(centred.layers[0].tiles)).toEqual(rect(50, -25, 100, 100));
    const topLeft = await resizeCanvas(d, 150, 150, { x: 0, y: 0 }, cpu);
    expect(contentBounds(topLeft.layers[0].tiles)).toEqual(rect(0, 0, 100, 100));
  });

  it("moves smart objects' placements and re-renders them for the new canvas", async () => {
    const d = createDocument({ width: 100, height: 100 });
    const src = smartSource("s", 10, 10, fillTiles(EMPTY_TILES, rect(0, 0, 10, 10), { r: 0, g: 0, b: 255 }));
    const doc = addLayer(d, await smartObjectLayer(d, src, cpu, { source: rect(0, 0, 10, 10), quad: quadOf(rect(90, 90, 20, 20)), angle: 0, patch: null }));
    // Part of it was off the old canvas; on the bigger one it's all rendered.
    const big = await resizeCanvas(doc, 200, 200, { x: 0, y: 0 }, cpu);
    expect(contentBounds(big.layers[1].tiles)).toEqual(rect(90, 90, 20, 20));
  });
});
