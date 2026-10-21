import { describe, expect, it } from "vitest";
import {
  activeLayer, addLayer, clearPixels, createDocument, createLayer, duplicateLayer, fillPixels, moveLayer,
  moveLayerRelative,
  removeLayer, updateLayer, layerFromBackground,
} from "./document";
import { flatten, mergeDown } from "./composite";
import { isClipped } from "./layers";
import { rect } from "./geometry";
import { rectMask } from "./selection";
import { NO_PIXELS, getPixel } from "./pixels";

const px = (d: Uint8ClampedArray, w: number, x: number, y: number) => [...d.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];

describe("layers", () => {
  it("creates a white background", () => {
    const d = createDocument({ width: 3, height: 2 });
    expect(d.layers).toHaveLength(1);
    expect(px(flatten(d), 3, 2, 1)).toEqual([255, 255, 255, 255]);
    expect(createDocument({ width: 3, height: 2, background: null }).layers[0].pixels.size).toBe(0);
  });

  it("adds above the active layer with a fresh name and activates it", () => {
    let d = createDocument({ width: 2, height: 2 });
    d = addLayer(d);
    d = addLayer(d);
    expect(d.layers.map((l) => l.name)).toEqual(["Background", "Layer 1", "Layer 2"]);
    expect(activeLayer(d)!.name).toBe("Layer 2");
  });

  it("removes, keeping at least one layer and a valid active layer", () => {
    let d = addLayer(createDocument({ width: 2, height: 2 }));
    d = removeLayer(d, d.activeLayerId);
    expect(d.layers).toHaveLength(1);
    expect(activeLayer(d)).toBeDefined();
    expect(removeLayer(d, d.layers[0].id)).toBe(d);
  });

  it("moves layers above or below a target, in either direction", () => {
    // Bottom to top: A B C D
    let d = createDocument({ width: 2, height: 2, background: null });
    const [a] = d.layers;
    d = addLayer(addLayer(addLayer(updateLayer(d, a.id, { name: "A" }), createLayer({ name: "B" })), createLayer({ name: "C" })), createLayer({ name: "D" }));
    const id = (n: string) => d.layers.find((l) => l.name === n)!.id;
    const order = (x: typeof d) => x.layers.map((l) => l.name).join("");
    expect(order(moveLayerRelative(d, id("D"), id("B"), "above"))).toBe("ABDC"); // downwards, above the target
    expect(order(moveLayerRelative(d, id("D"), id("B"), "below"))).toBe("ADBC");
    expect(order(moveLayerRelative(d, id("A"), id("C"), "above"))).toBe("BCAD"); // upwards
    expect(order(moveLayerRelative(d, id("A"), id("C"), "below"))).toBe("BACD");
    expect(order(moveLayerRelative(d, id("A"), id("D"), "above"))).toBe("BCDA"); // to the very top
    expect(order(moveLayerRelative(d, id("C"), id("B"), "above"))).toBe("ABCD"); // already there: no-op
    expect(moveLayerRelative(d, id("C"), id("C"), "above")).toBe(d);
  });

  it("reorders and duplicates", () => {
    let d = addLayer(createDocument({ width: 2, height: 2, background: null }));
    d = moveLayer(d, d.activeLayerId, 0);
    expect(d.layers[0].name).toBe("Layer 2");
    d = duplicateLayer(d, d.layers[0].id);
    expect(d.layers.map((l) => l.name)).toEqual(["Layer 2", "Layer 2 copy", "Layer 1"]);
    expect(d.layers[1].pixels).toBe(d.layers[0].pixels);
  });

  it("keeps the Background at the bottom, where it can't be moved or clipped to", () => {
    let d = addLayer(createDocument({ width: 2, height: 2 }));
    const [bg, l1] = d.layers;
    expect(bg.isBackground).toBe(true);
    expect(moveLayer(d, l1.id, 0)).toBe(d);
    expect(moveLayer(d, bg.id, 1)).toBe(d);
    expect(moveLayerRelative(d, l1.id, bg.id, "below").layers.map((l) => l.name)).toEqual(["Background", "Layer 1"]);
    d = addLayer(d, createLayer({ name: "x" }), bg.id, "below");
    expect(d.layers[0].isBackground).toBe(true);
    const clipped = updateLayer(d, l1.id, { clipped: true });
    expect(isClipped(clipped.layers, 2)).toBe(false);
    // Its duplicate is an ordinary layer; Layer from Background makes it one too.
    expect(duplicateLayer(d, bg.id).layers[1].isBackground).toBe(false);
    expect(layerFromBackground(d, bg.id).layers[0]).toMatchObject({ isBackground: false, name: "Layer 0" });
  });

  it("transparent documents start with Layer 1, not a Background", () => {
    const d = createDocument({ width: 2, height: 2, background: null });
    expect(d.layers[0].name).toBe("Layer 1");
    expect(d.layers[0].isBackground).toBeFalsy();
  });

  it("new layers made over a clipped layer join its clipping group", () => {
    let d = addLayer(createDocument({ width: 2, height: 2 }), createLayer({ name: "base" }));
    d = addLayer(d, createLayer({ name: "c", clipped: true }));
    d = addLayer(d, createLayer({ name: "n" }));
    expect(d.layers.map((l) => [l.name, l.clipped])).toEqual([["Background", false], ["base", false], ["c", true], ["n", true]]);
  });
});

describe("compositing", () => {
  const base = createDocument({ width: 2, height: 1, background: { r: 0, g: 0, b: 255 } });
  const red = fillPixels(NO_PIXELS, rect(0, 0, 1, 1), { r: 255, g: 0, b: 0 });

  it("respects opacity, visibility and blend mode", () => {
    const d = addLayer(base, createLayer({ name: "r", pixels: red, opacity: 0.5 }));
    expect(px(flatten(d), 2, 0, 0)).toEqual([128, 0, 128, 255]);
    expect(px(flatten(updateLayer(d, d.activeLayerId, { visible: false })), 2, 0, 0)).toEqual([0, 0, 255, 255]);
    const mul = updateLayer(d, d.activeLayerId, { opacity: 1, blendMode: "multiply" });
    expect(px(flatten(mul), 2, 0, 0)).toEqual([0, 0, 0, 255]);
  });

  it("merges down", () => {
    const d = mergeDown(addLayer(base, createLayer({ name: "r", pixels: red })), "missing");
    expect(d.layers).toHaveLength(2);
    const top = addLayer(base, createLayer({ name: "r", pixels: red, opacity: 0.5 }));
    const merged = mergeDown(top, top.activeLayerId);
    expect(merged.layers).toHaveLength(1);
    expect(merged.activeLayerId).toBe(base.layers[0].id);
    expect(px(flatten(merged), 2, 0, 0)).toEqual(px(flatten(top), 2, 0, 0));
  });
});

describe("fill and clear", () => {
  it("fills only within the selection", () => {
    const sel = rectMask(4, 4, rect(0, 0, 2, 2));
    const t = fillPixels(NO_PIXELS, rect(0, 0, 4, 4), { r: 9, g: 9, b: 9 }, sel);
    expect(getPixel(t, 1, 1)).toEqual([9, 9, 9, 255]);
    expect(getPixel(t, 3, 3)[3]).toBe(0);
  });
  it("clears the selection or everything", () => {
    const t = fillPixels(NO_PIXELS, rect(0, 0, 4, 4), { r: 9, g: 9, b: 9 });
    const cleared = clearPixels(t, rectMask(4, 4, rect(0, 0, 2, 4)));
    expect(getPixel(cleared, 0, 0)[3]).toBe(0);
    expect(getPixel(cleared, 3, 0)[3]).toBe(255);
    expect(clearPixels(t, null).size).toBe(0);
  });
});
