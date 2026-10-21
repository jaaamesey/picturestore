import { describe, expect, it } from "vitest";
import { defaultAdjustment, type Adjustment } from "./adjustments";
import { adjustPixels, flatten, mergeDown, mergeGroup } from "./composite";
import { compile } from "./adjustments";
import { HIDE_ALL, REVEAL_ALL, createDocument, createGroup, createLayer, fillPixels, type Doc, type Layer } from "./document";
import { rect } from "./geometry";
import { findLayer } from "./layers";
import { NO_PIXELS, getPixel, type Pixels } from "./pixels";
import { rectMask } from "./selection";

const W = 2;
const fill = (r: number, g: number, b: number, area = rect(0, 0, W, 1)): Pixels => fillPixels(NO_PIXELS, area, { r, g, b });
const doc = (...layers: Layer[]): Doc => ({ width: W, height: 1, layers, activeLayerId: layers[0].id, selection: null });
const px = (d: Doc, x: number) => [...flatten(d).subarray(x * 4, x * 4 + 4)];
const layer = (pixels: Pixels, props: Partial<Layer> = {}) => createLayer({ name: "l", pixels, ...props });
const adjustment = (adjustment: Adjustment, props: Partial<Layer> = {}) => createLayer({ name: "a", content: { kind: "adjustment", adjustment }, mask: REVEAL_ALL, ...props });

const blue = () => layer(fill(0, 0, 255));
/** Red on the left pixel only. */
const redLeft = (props: Partial<Layer> = {}) => layer(fill(255, 0, 0, rect(0, 0, 1, 1)), props);
const green = (props: Partial<Layer> = {}) => layer(fill(0, 255, 0), props);

describe("clipping masks", () => {
  it("show clipped layers only where the base layer is", () => {
    const d = doc(blue(), redLeft(), green({ clipped: true }));
    expect(px(d, 0)).toEqual([0, 255, 0, 255]);
    expect(px(d, 1)).toEqual([0, 0, 255, 255]);
  });

  it("blend the group with the base's opacity and mode", () => {
    const d = doc(blue(), redLeft({ opacity: 0.5 }), green({ clipped: true }));
    expect(px(d, 0)).toEqual([0, 128, 128, 255]);
    const multiplied = doc(layer(fill(255, 255, 0)), redLeft({ blendMode: "multiply" }), layer(fill(255, 255, 255, rect(0, 0, 1, 1)), { clipped: true }));
    expect(px(multiplied, 0)).toEqual([255, 255, 0, 255]);
  });

  it("blend clipped layers with the base alone, not with what's below", () => {
    // Multiplying white base with red: red, whatever the blue below.
    const d = doc(blue(), layer(fill(255, 255, 255, rect(0, 0, 1, 1))), layer(fill(255, 0, 0), { clipped: true, blendMode: "multiply" }));
    expect(px(d, 0)).toEqual([255, 0, 0, 255]);
    expect(px(d, 1)).toEqual([0, 0, 255, 255]);
  });

  it("hide with their base", () => {
    expect(px(doc(blue(), redLeft({ visible: false }), green({ clipped: true })), 0)).toEqual([0, 0, 255, 255]);
  });

  it("keep partial base coverage", () => {
    const d = doc(layer(fill(255, 0, 0), { opacity: 1 }), green({ clipped: true, opacity: 0.5 }));
    expect(px(d, 0)).toEqual([128, 128, 0, 255]);
  });

  it("can't clip the bottom layer of a container", () => {
    expect(px(doc(green({ clipped: true })), 1)).toEqual([0, 255, 0, 255]);
    const g = createGroup("g", [green({ clipped: true })]);
    expect(px(doc(blue(), g), 1)).toEqual([0, 255, 0, 255]);
  });

  it("let a clipped adjustment change only the base", () => {
    const d = doc(blue(), redLeft(), adjustment({ kind: "invert" }, { clipped: true }));
    expect(px(d, 0)).toEqual([0, 255, 255, 255]);
    expect(px(d, 1)).toEqual([0, 0, 255, 255]);
  });

  it("clip to a group's contents", () => {
    const d = doc(blue(), createGroup("g", [redLeft()]), green({ clipped: true }));
    expect(px(d, 0)).toEqual([0, 255, 0, 255]);
    expect(px(d, 1)).toEqual([0, 0, 255, 255]);
  });

  it("clip to an adjustment layer's mask", () => {
    const half = { ...HIDE_ALL, pixels: fill(255, 255, 255, rect(0, 0, 1, 1)) };
    const d = doc(blue(), adjustment({ kind: "invert" }, { mask: half }), green({ clipped: true }));
    expect(px(d, 0)).toEqual([0, 255, 0, 255]);
    expect(px(d, 1)).toEqual([0, 0, 255, 255]);
  });
});

describe("groups", () => {
  it("pass through: contents blend as if ungrouped", () => {
    const flat = doc(blue(), redLeft({ blendMode: "screen" }));
    const grouped = doc(blue(), createGroup("g", [redLeft({ blendMode: "screen" })]));
    expect(px(grouped, 0)).toEqual(px(flat, 0));
    expect(px(grouped, 0)).toEqual([255, 0, 255, 255]);
  });

  it("isolated (Normal): contents composite on their own first", () => {
    const g = { ...createGroup("g", [redLeft({ blendMode: "screen" })]), blendMode: "normal" as const };
    expect(px(doc(blue(), g), 0)).toEqual([255, 0, 0, 255]);
  });

  it("pass through with opacity fades between before and after", () => {
    const g = { ...createGroup("g", [redLeft()]), opacity: 0.5 };
    expect(px(doc(blue(), g), 0)).toEqual([128, 0, 128, 255]);
  });

  it("nest, and hide with their contents", () => {
    const inner = createGroup("inner", [redLeft()]);
    expect(px(doc(blue(), createGroup("outer", [inner])), 0)).toEqual([255, 0, 0, 255]);
    expect(px(doc(blue(), { ...createGroup("outer", [inner]), visible: false }), 0)).toEqual([0, 0, 255, 255]);
  });

  it("limit adjustments inside isolated groups to their contents", () => {
    const inv = adjustment({ kind: "invert" });
    const pass = doc(blue(), createGroup("g", [redLeft(), inv]));
    expect(px(pass, 1)).toEqual([255, 255, 0, 255]); // reaches the blue below
    const isolated = doc(blue(), { ...createGroup("g", [redLeft(), inv]), blendMode: "normal" });
    expect(px(isolated, 0)).toEqual([0, 255, 255, 255]);
    expect(px(isolated, 1)).toEqual([0, 0, 255, 255]);
  });

  it("apply their mask to everything inside", () => {
    const g = { ...createGroup("g", [green()]), mask: { ...REVEAL_ALL, pixels: fill(0, 0, 0, rect(1, 0, 1, 1)) } };
    const d = doc(blue(), g);
    expect(px(d, 0)).toEqual([0, 255, 0, 255]);
    expect(px(d, 1)).toEqual([0, 0, 255, 255]);
  });
});

describe("layer masks", () => {
  it("hide where black, reveal where white, partially in between", () => {
    const mask = { ...REVEAL_ALL, pixels: fillPixels(NO_PIXELS, rect(1, 0, 1, 1), { r: 0, g: 0, b: 0 }) };
    const d = doc(blue(), green({ mask }));
    expect(px(d, 0)).toEqual([0, 255, 0, 255]);
    expect(px(d, 1)).toEqual([0, 0, 255, 255]);
    const grey = { ...HIDE_ALL, pixels: fill(128, 128, 128) };
    expect(px(doc(blue(), green({ mask: grey })), 0)).toEqual([0, 128, 127, 255]);
  });

  it("have no effect while disabled", () => {
    expect(px(doc(blue(), green({ mask: { ...HIDE_ALL, enabled: false } })), 0)).toEqual([0, 255, 0, 255]);
  });
});

describe("adjustment layers", () => {
  it("change everything below, keeping transparency", () => {
    const d = doc(redLeft(), adjustment({ kind: "invert" }));
    expect(px(d, 0)).toEqual([0, 255, 255, 255]);
    expect(px(d, 1)).toEqual([0, 0, 0, 0]);
  });

  it("apply through opacity, mask and blend mode", () => {
    expect(px(doc(blue(), adjustment({ kind: "invert" }, { opacity: 0.5 })), 0)).toEqual([128, 128, 128, 255]);
    const masked = { ...REVEAL_ALL, pixels: fill(0, 0, 0, rect(1, 0, 1, 1)) };
    const d = doc(blue(), adjustment({ kind: "invert" }, { mask: masked }));
    expect(px(d, 0)).toEqual([255, 255, 0, 255]);
    expect(px(d, 1)).toEqual([0, 0, 255, 255]);
    // Luminosity mode: only the adjustment's lightness lands.
    const lum = px(doc(layer(fill(255, 0, 0)), adjustment({ kind: "invert" }, { blendMode: "luminosity" })), 0);
    expect(lum[0]).toBeGreaterThan(lum[1]);
  });

  it("don't affect layers above them", () => {
    expect(px(doc(blue(), adjustment({ kind: "invert" }), redLeft()), 0)).toEqual([255, 0, 0, 255]);
  });
});

describe("merging", () => {
  it("merges an adjustment down into the layer below", () => {
    const d = doc(blue(), adjustment(defaultAdjustment("invert")));
    const merged = mergeDown(d, d.layers[1].id);
    expect(merged.layers).toHaveLength(1);
    expect(getPixel(merged.layers[0].pixels, 0, 0)).toEqual([255, 255, 0, 255]);
  });

  it("merges a clipping group into its base (Merge Clipping Mask)", () => {
    const d = doc(blue(), redLeft(), green({ clipped: true }));
    const merged = mergeDown(d, d.layers[1].id);
    expect(merged.layers).toHaveLength(2);
    expect(getPixel(merged.layers[1].pixels, 0, 0)).toEqual([0, 255, 0, 255]);
    expect(getPixel(merged.layers[1].pixels, 1, 0)[3]).toBe(0);
    expect(px(merged, 1)).toEqual(px(d, 1));
  });

  it("merges a clipped layer into its base", () => {
    const d = doc(blue(), redLeft(), green({ clipped: true }));
    const merged = mergeDown(d, d.layers[2].id);
    expect(merged.layers.map((l) => l.id)).toEqual([d.layers[0].id, d.layers[1].id]);
    expect([px(merged, 0), px(merged, 1)]).toEqual([px(d, 0), px(d, 1)]);
  });

  it("merges a group into one layer", () => {
    const g = createGroup("g", [redLeft(), green({ clipped: true, opacity: 0.5 })]);
    const d = doc(blue(), g);
    const merged = mergeGroup(d, g.id);
    const l = findLayer(merged.layers, g.id)!;
    expect(l.content.kind).toBe("pixels");
    expect(l.blendMode).toBe("normal");
    expect([px(merged, 0), px(merged, 1)]).toEqual([px(d, 0), px(d, 1)]);
  });
});

describe("adjustPixels", () => {
  it("applies an adjustment within the selection's coverage", () => {
    const pixels = fill(255, 0, 0);
    const out = adjustPixels(pixels, compile({ kind: "invert" }), rectMask(W, 1, rect(1, 0, 1, 1)));
    expect(getPixel(out, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(getPixel(out, 1, 0)).toEqual([0, 255, 255, 255]);
  });
});

it("composites a default document", () => {
  expect(px(createDocument({ width: W, height: 1 }), 0)).toEqual([255, 255, 255, 255]);
});
