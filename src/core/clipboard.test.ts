import { describe, expect, it } from "vitest";
import { copyMerged, copyPixels, pasteCenter, pasteFloating } from "./clipboard";
import { activeLayer, addLayer, createDocument, fillPixels, updateLayer, type Doc } from "./document";
import { rect } from "./geometry";
import { rectMask } from "./selection";
import { NO_PIXELS, contentBounds, getPixel } from "./pixels";

/** A white canvas with a red square at (10, 10)–(30, 30) on its own layer. */
function doc(): Doc {
  const d = addLayer(createDocument({ width: 100, height: 100 }));
  return updateLayer(d, d.activeLayerId, { pixels: fillPixels(NO_PIXELS, rect(10, 10, 20, 20), { r: 255, g: 0, b: 0 }) });
}

describe("clipboard", () => {
  it("copies the selected pixels of the active layer", () => {
    const d = { ...doc(), selection: rectMask(100, 100, rect(20, 20, 50, 50)) };
    const f = copyPixels(d, activeLayer(d)!)!;
    expect(f.bounds).toEqual(rect(20, 20, 10, 10));
  });

  it("reports an empty copy as null", () => {
    const d = { ...doc(), selection: rectMask(100, 100, rect(60, 60, 10, 10)) };
    expect(copyPixels(d, activeLayer(d)!)).toBeNull();
  });

  it("copy merged takes the composite", () => {
    const d = { ...doc(), selection: rectMask(100, 100, rect(0, 0, 40, 40)) };
    const f = copyMerged(d)!;
    expect(f.bounds).toEqual(rect(0, 0, 40, 40));
    expect(getPixel(f.pixels, 5, 5)).toEqual([255, 255, 255, 255]);
    expect(getPixel(f.pixels, 15, 15)).toEqual([255, 0, 0, 255]);
  });

  it("pastes centred as a new layer and drops the selection; paste in place keeps position", () => {
    const d = { ...doc(), selection: rectMask(100, 100, rect(10, 10, 20, 20)) };
    const f = copyPixels(d, activeLayer(d)!)!;
    const centred = pasteFloating({ ...d, selection: null }, f, { x: 50, y: 50 });
    expect(centred.layers.length).toBe(3);
    expect(centred.selection).toBeNull();
    expect(contentBounds(activeLayer(centred)!.pixels)).toEqual(rect(40, 40, 20, 20));
    expect(contentBounds(activeLayer(pasteFloating(d, f, null))!.pixels)).toEqual(rect(10, 10, 20, 20));
  });

  it("centres paste on the selection, else the visible canvas", () => {
    const d = doc();
    expect(pasteCenter({ ...d, selection: rectMask(100, 100, rect(0, 0, 10, 20)) }, null)).toEqual({ x: 5, y: 10 });
    expect(pasteCenter(d, rect(50, -100, 200, 300))).toEqual({ x: 75, y: 50 });
    expect(pasteCenter(d, rect(500, 500, 10, 10))).toEqual({ x: 50, y: 50 });
  });
});
