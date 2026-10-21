import { describe, expect, it } from "vitest";
import { initialPlacement, placementMapping, smartObjectLayer, smartSource, type Resample } from "./content";
import { addLayer, convertToSmartObject, createDocument, createLayer, fillTiles, rasterizeLayer } from "./document";
import { rect } from "./geometry";
import { transformFloatingCpu } from "./raster";
import { EMPTY_TILES, contentBounds, getPixel, tilesFromImage } from "./tiles";
import { quadOf } from "./warp";

const cpu: Resample = async (f, m, filter, clip) => transformFloatingCpu(f, m, filter, clip);

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
    const restored = await cpu({ tiles: source.tiles, bounds: rect(0, 0, 64, 64) }, placementMapping(back), "bicubic", rect(0, 0, 200, 200));
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
