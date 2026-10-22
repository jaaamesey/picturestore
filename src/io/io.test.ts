import { readPsd } from "ag-psd";
import { describe, expect, it } from "vitest";
import { addLayer, createDocument, createLayer, fillPixels, type Doc } from "../core/document";
import { flatten } from "../core/composite";
import { ADJUSTMENTS, defaultAdjustment, type Adjustment } from "../core/adjustments";
import { HIDE_ALL, REVEAL_ALL, createGroup } from "../core/document";
import { childrenOf } from "../core/layers";
import { rect } from "../core/geometry";
import { NO_PIXELS } from "../core/pixels";
import { CPU_RASTERIZERS, smartObjectLayer, smartSource } from "../core/content";
import { renderShape } from "../core/shape";
import { getPixel } from "../core/pixels";
import { quadOf } from "../core/warp";
import { readPsdDocument, writePsdDocument } from "./psd";

const cpu = CPU_RASTERIZERS;
const corner = (x: number, y: number) => ({ anchor: { x, y }, in: { x, y }, out: { x, y }, smooth: false });

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

  it("keeps groups, nesting, clipping and pass-through", async () => {
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
    const [g] = doc.layers;
    expect([g.name, g.visible, g.content.kind]).toEqual(["G", false, "group"]);
    expect(childrenOf(g).map((l) => l.name)).toEqual(["child"]);
  });

  it("round-trips groups, clipping masks, layer masks and adjustment layers", async () => {
    const d = createDocument({ width: 4, height: 2, background: { r: 0, g: 0, b: 255 } });
    const red = createLayer({ name: "red", pixels: fillPixels(NO_PIXELS, rect(0, 0, 2, 2), { r: 255, g: 0, b: 0 }) });
    const green = createLayer({
      name: "green",
      clipped: true,
      pixels: fillPixels(NO_PIXELS, rect(0, 0, 4, 2), { r: 0, g: 255, b: 0 }),
      mask: { ...REVEAL_ALL, pixels: fillPixels(NO_PIXELS, rect(1, 0, 1, 2), { r: 0, g: 0, b: 0 }) },
    });
    const levels = defaultAdjustment("levels") as Extract<Adjustment, { kind: "levels" }>;
    const adj = createLayer({
      name: "Levels 1",
      opacity: 0.5,
      content: { kind: "adjustment", adjustment: { ...levels, channels: { ...levels.channels, rgb: { ...levels.channels.rgb, inWhite: 200, gamma: 1.5 } } } },
      mask: HIDE_ALL,
    });
    const group = { ...createGroup("G", [red, green]), blendMode: "normal" as const };
    const doc = { ...d, layers: [...d.layers, group, adj, createLayer({ name: "inv", content: { kind: "adjustment", adjustment: { kind: "invert" } }, mask: REVEAL_ALL })] };
    const back = await readPsdDocument(new Uint8Array(writePsdDocument(doc)));
    const [, g2, a2, i2] = back.layers;
    expect(g2.blendMode).toBe("normal");
    const [r2, gr2] = childrenOf(g2);
    expect([r2.clipped, gr2.clipped]).toEqual([false, true]);
    expect(gr2.mask?.background).toBe(255);
    expect(a2.content).toEqual(adj.content);
    expect(a2.mask?.background).toBe(0);
    expect(i2.content).toEqual({ kind: "adjustment", adjustment: { kind: "invert" } });
    const a = flatten(doc), b = flatten(back);
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(1);
  });

  it.each(ADJUSTMENTS.map((a) => a.kind))("round-trips %s adjustment layers", (kind) => {
    const adjustment = defaultAdjustment(kind);
    const d = createDocument({ width: 2, height: 2 });
    const doc = addLayer(d, createLayer({ name: "a", content: { kind: "adjustment", adjustment }, mask: REVEAL_ALL }));
    return readPsdDocument(new Uint8Array(writePsdDocument(doc))).then((back) => expect(back.layers[1].content).toEqual({ kind: "adjustment", adjustment }));
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

  it("keeps the work path and saved paths in the Paths resources, and Photoshop's own tools can still read the file", async () => {
    const square = (x: number, y: number, s: number, op: "combine" | "subtract" = "combine") => ({
      closed: true,
      op,
      knots: [corner(x, y), corner(x + s, y), corner(x + s, y + s), corner(x, y + s)],
    });
    const curve = {
      closed: false,
      op: "combine" as const,
      knots: [{ anchor: { x: 10, y: 100 }, in: { x: 10, y: 100 }, out: { x: 40, y: 20 }, smooth: false }, { anchor: { x: 120, y: 100 }, in: { x: 90, y: 180 }, out: { x: 150, y: 20 }, smooth: true }],
    };
    const doc: Doc = {
      ...sampleDoc(),
      paths: [
        { id: "a", name: "Outline", path: { subpaths: [square(20, 20, 100), square(50, 50, 30, "subtract")] } },
        { id: "b", name: "Curve ünï", path: { subpaths: [curve] } },
      ],
      workPath: { subpaths: [square(5, 5, 10)] },
    };
    const bytes = writePsdDocument(doc);
    // Still a valid PSD for other readers.
    expect(readPsd(bytes, { useImageData: true }).children!.map((c) => c.name)).toEqual(["Background", "Circle"]);
    const back = await readPsdDocument(new Uint8Array(bytes));
    expect(back.paths!.map((p) => p.name)).toEqual(["Outline", "Curve ünï"]);
    const [outline, open] = back.paths!;
    expect(outline.path.subpaths.map((s) => [s.closed, s.op, s.knots.length])).toEqual([[true, "combine", 4], [true, "subtract", 4]]);
    expect(outline.path.subpaths[0].knots[1].anchor.x).toBeCloseTo(120, 3);
    expect(open.path.subpaths[0].closed).toBe(false);
    expect(open.path.subpaths[0].knots[1].out.x).toBeCloseTo(150, 3);
    expect(open.path.subpaths[0].knots[1].smooth).toBe(true);
    expect(open.path.subpaths[0].knots[0].smooth).toBe(false);
    expect(back.workPath!.subpaths).toHaveLength(1);
    // A document without paths has no resources for them.
    const none = await readPsdDocument(new Uint8Array(writePsdDocument(sampleDoc())));
    expect(none.paths).toBeUndefined();
    expect(none.workPath).toBeUndefined();
  });

  it("keeps a vector mask on an ordinary layer and applies it again on reading", async () => {
    const base = sampleDoc();
    const id = base.activeLayerId;
    const path = { subpaths: [{ closed: true, op: "combine" as const, knots: [corner(10, 10), corner(110, 10), corner(110, 110), corner(10, 110)] }] };
    const doc = { ...base, layers: base.layers.map((l) => (l.id === id ? { ...l, opacity: 1, blendMode: "normal" as const, pixels: fillPixels(NO_PIXELS, rect(0, 0, 300, 200), { r: 200, g: 100, b: 0 }), vectorMask: { path, enabled: true } } : l)) };
    const bytes = writePsdDocument(doc);
    const psd = readPsd(bytes, { useImageData: true });
    expect(psd.children![1].vectorMask!.paths).toHaveLength(1);
    const back = await readPsdDocument(new Uint8Array(bytes));
    const layer = back.layers[1];
    expect(layer.content.kind).toBe("pixels");
    expect(layer.vectorMask!.enabled).toBe(true);
    expect(layer.vectorMask!.path.subpaths[0].knots[2].anchor.x).toBeCloseTo(110, 3);
    expect([...flatten(back, rect(50, 50, 1, 1))].slice(0, 3)).toEqual([200, 100, 0]);
    expect([...flatten(back, rect(200, 150, 1, 1))].slice(0, 3)).toEqual([10, 20, 30]);
    const disabled = { ...doc, layers: doc.layers.map((l) => (l.id === id ? { ...l, vectorMask: { path, enabled: false } } : l)) };
    expect((await readPsdDocument(new Uint8Array(writePsdDocument(disabled)))).layers[1].vectorMask!.enabled).toBe(false);
  });
});
