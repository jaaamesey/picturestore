import { readPsd } from "ag-psd";
import { describe, expect, it } from "vitest";
import { addLayer, createDocument, createLayer, fillTiles, flatten, type Doc } from "../core/document";
import { rect } from "../core/geometry";
import { EMPTY_TILES } from "../core/tiles";
import { readPsdDocument, writePsdDocument } from "./psd";

function sampleDoc(): Doc {
  const d = createDocument({ width: 300, height: 200, background: { r: 10, g: 20, b: 30 } });
  const layer = createLayer({
    name: "Circle",
    opacity: 0.75,
    blendMode: "screen",
    // Extends off-canvas (negative coordinates) to check that is preserved.
    tiles: fillTiles(EMPTY_TILES, rect(-20, 150, 100, 80), { r: 200, g: 100, b: 0 }),
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

  it("round-trips through our reader", () => {
    const doc = sampleDoc();
    const back = readPsdDocument(new Uint8Array(writePsdDocument(doc)));
    expect(back.layers.map((l) => l.name)).toEqual(["Background", "Circle"]);
    expect(back.layers[1].blendMode).toBe("screen");
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
    const doc = readPsdDocument(buf);
    expect(doc.layers.map((l) => [l.name, l.visible])).toEqual([["child", false]]);
  });
});
