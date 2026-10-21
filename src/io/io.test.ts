import { readPsd } from "ag-psd";
import { describe, expect, it } from "vitest";
import { addLayer, createDocument, createLayer, fillPixels, flatten, type Doc } from "../core/document";
import { rect } from "../core/geometry";
import { NO_PIXELS } from "../core/pixels";
import { CPU_RASTERIZERS, smartObjectLayer, smartSource } from "../core/content";
import { renderShape } from "../core/shape";
import { getPixel } from "../core/pixels";
import { quadOf } from "../core/warp";
import { readPsdDocument, writePsdDocument } from "./psd";

const cpu = CPU_RASTERIZERS;

function sampleDoc(): Doc {
  const d = createDocument({ width: 300, height: 200, background: { r: 10, g: 20, b: 30 } });
  const layer = createLayer({
    name: "Circle",
    opacity: 0.75,
    blendMode: "screen",
    // Extends off-canvas (negative coordinates) to check that is preserved.
    pixels: fillPixels(NO_PIXELS, rect(-20, 150, 100, 80), { r: 200, g: 100, b: 0 }),
  });
  return addLayer(d, layer);
}

describe("PSD", () => {
  it("writes layers, properties and a composite readable by ag-psd", () => {
    const doc = sampleDoc();
    const psd = readPsd(writePsdDocument(doc), { useImageData: true });
    expect(psd.width).toBe(300);
    expect(psd.children!.map((c) => [c.name, c.blendMode])).toEqual([["Background", "normal"], ["Circle", "screen"]]);
    expect(psd.children![1].opacity).toBeCloseTo(0.75, 2);
    expect(psd.imageData!.data.length).toBe(300 * 200 * 4);
  });

  it("round-trips through our reader", async () => {
    const doc = sampleDoc();
    const back = await readPsdDocument(new Uint8Array(writePsdDocument(doc)));
    expect(back.layers.map((l) => l.name)).toEqual(["Background", "Circle"]);
    expect(back.layers[1].blendMode).toBe("screen");
    expect(back.layers.map((l) => l.content.kind)).toEqual(["pixels", "pixels"]);
    expect(back.resolution).toBe(72);
    expect((await readPsdDocument(new Uint8Array(writePsdDocument({ ...doc, resolution: 300 })))).resolution).toBe(300);
    const guides = [{ orientation: "vertical", position: 12.5 }, { orientation: "horizontal", position: 40 }] as const;
    expect((await readPsdDocument(new Uint8Array(writePsdDocument({ ...doc, guides })))).guides).toEqual(guides);
    const a = flatten(doc);
    const b = flatten(back);
    let maxDiff = 0;
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
    expect(maxDiff).toBeLessThanOrEqual(1); // opacity is quantised to 8 bits in PSD
  });

  it("flattens groups, inheriting visibility", async () => {
    const { writePsd } = await import("ag-psd");
    const px = { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) };
    const buf = writePsd(
      {
        width: 2,
        height: 2,
        children: [{ name: "G", hidden: true, children: [{ name: "child", left: 0, top: 0, right: 1, bottom: 1, imageData: px }] }],
      },
      { generateThumbnail: false },
    );
    const doc = await readPsdDocument(buf);
    expect(doc.layers.map((l) => [l.name, l.visible])).toEqual([["child", false]]);
  });

  it("keeps smart objects live: placement, warp and embedded contents", async () => {
    const d = createDocument({ width: 200, height: 100 });
    const src = smartSource("Photo", 20, 10, fillPixels(NO_PIXELS, rect(0, 0, 20, 10), { r: 0, g: 200, b: 0 }));
    const placement = { source: rect(0, 0, 20, 10), quad: quadOf(rect(50, 20, 80, 40)), angle: 0, patch: null };
    const doc = addLayer(d, await smartObjectLayer(d, src, cpu, placement));
    const back = await readPsdDocument(new Uint8Array(writePsdDocument(doc)));
    const l = back.layers[1];
    expect(l.content.kind).toBe("smart");
    if (l.content.kind !== "smart") return;
    expect(l.content.placement.quad).toEqual(placement.quad);
    expect([l.content.source.width, l.content.source.height]).toEqual([20, 10]);
    // The embedded contents (written as a .psb) come back pixel-exact.
    expect(getPixel(l.content.source.pixels, 5, 5)).toEqual([0, 200, 0, 255]);
    expect(getPixel(l.pixels, 90, 40)).toEqual([0, 200, 0, 255]);
  });

  it("keeps solid-colour shapes live as vector paths", async () => {
    const d = createDocument({ width: 100, height: 100 });
    const geometry = { kind: "rectangle", radius: 10 } as const;
    const style = { fill: { r: 255, g: 0, b: 0 }, stroke: { color: { r: 0, g: 0, b: 255 }, width: 4, align: "center" as const } };
    const placement = { source: rect(0, 0, 60, 40), quad: quadOf(rect(20, 30, 60, 40)), angle: 0, patch: null };
    const tiles = renderShape(geometry, style, placement, rect(0, 0, 100, 100));
    const doc = addLayer(d, createLayer({ name: "Rectangle 1", pixels: tiles, content: { kind: "shape", geometry, style, placement } }));
    const back = await readPsdDocument(new Uint8Array(writePsdDocument(doc)));
    const l = back.layers[1];
    expect(l.content.kind).toBe("shape");
    if (l.content.kind !== "shape") return;
    expect(l.content.style).toEqual(style);
    expect(l.content.geometry.kind).toBe("path");
    // Re-rendering the imported path reproduces the original pixels.
    const again = renderShape(l.content.geometry, l.content.style, l.content.placement, rect(0, 0, 100, 100));
    let maxDiff = 0;
    const a = flatten({ ...doc, layers: [doc.layers[1]] });
    const b = flatten({ ...doc, layers: [{ ...doc.layers[1], pixels: again }] });
    for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
    expect(maxDiff).toBeLessThanOrEqual(2);
  });
});
