import { describe, expect, it } from "vitest";
import { DEFAULT_BRUSH } from "../../core/brush";
import { addLayer, createDocument, fillTiles, updateLayer, type Doc } from "../../core/document";
import { rect } from "../../core/geometry";
import { rectMask } from "../../core/selection";
import { transformFloatingCpu } from "../../core/raster";
import { EMPTY_TILES, contentBounds, getPixel } from "../../core/tiles";
import type { FloatingLayer } from "../../gpu/renderer";
import { DEFAULT_SETTINGS } from "../editor";
import type { Overlay, ToolContext, ToolEvent, ToolId, ToolSettings } from "../types";
import { createTools } from "./index";
import { smartObjectLayer, smartSource } from "../../core/content";
import { convertToSmartObject, createLayer } from "../../core/document";
import { quadOf } from "../../core/warp";

const settings: ToolSettings = {
  ...DEFAULT_SETTINGS,
  brush: { ...DEFAULT_BRUSH, size: 10, hardness: 1, pressureSize: false },
  eraser: { ...DEFAULT_BRUSH, size: 10, hardness: 1, pressureSize: false },
};

/** A minimal in-memory editor: the same contract the real one implements with signals. */
function harness(doc: Doc, options: Partial<ToolSettings> = {}) {
  const s = {
    doc,
    history: [] as string[],
    preview: null as Doc | null,
    floating: null as FloatingLayer | null,
    overlay: null as Overlay | null,
    view: { zoom: 1, panX: 0, panY: 0 },
    fg: { r: 255, g: 0, b: 0 },
    tool: "move" as ToolId,
    pending: Promise.resolve() as Promise<void>,
    /** Rasterize prompts the tools raised. */
    prompts: [] as string[],
  };
  const ctx = (): ToolContext => ({
    doc: s.doc,
    view: s.view,
    settings: { ...settings, ...options },
    foreground: s.fg,
    preview: (d, f = null) => ((s.preview = d), (s.floating = f)),
    commit: (label, d) => (s.history.push(label), (s.doc = d), (s.preview = null), (s.floating = null)),
    commitAsync(label, pending) {
      s.pending = pending.then((d) => {
        s.history.push(label);
        s.doc = d;
        s.preview = null;
        s.floating = null;
      });
    },
    resample: async (f, mapping, filter, clip) => transformFloatingCpu(f, mapping, filter, clip),
    requireEditable(layer) {
      if (layer.content.kind === "pixels") return true;
      s.prompts.push(layer.content.kind);
      return false;
    },
    overlay: (o) => (s.overlay = o),
    requestRender: () => {},
    setView: (v) => (s.view = v),
    setForeground: (c) => (s.fg = c),
    setTool: (id) => (s.tool = id),
  });
  const ev = (x: number, y: number, mods: Partial<ToolEvent> = {}): ToolEvent => ({
    x, y, screenX: x, screenY: y, pressure: 1, shift: false, alt: false, mod: false, clicks: 1, ...mods,
  });
  const tools = createTools();
  /** Drags with whichever tool is current at each step (the Move tool can hand over to Free Transform). */
  const drag = async (id: ToolId, from: [number, number], to: [number, number], mods: Partial<ToolEvent> = {}) => {
    s.tool = id;
    const t = () => tools.byId[s.tool];
    t().down?.(ctx(), ev(...from, mods));
    const steps = 8;
    for (let i = 1; i <= steps; i++)
      t().move?.(ctx(), ev(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, mods));
    t().up?.(ctx(), ev(...to, mods));
    await s.pending;
  };
  return { s, ctx, ev, tools, drag };
}

const blank = () => addLayer(createDocument({ width: 100, height: 100 }));
const layerOf = (d: Doc) => d.layers.find((l) => l.id === d.activeLayerId)!;

describe("brush", () => {
  it("previews while painting and commits one history entry", async () => {
    const h = harness(blank());
    const brush = h.tools.byId.brush;
    brush.down!(h.ctx(), h.ev(20, 20));
    expect(h.s.preview).not.toBeNull();
    brush.move!(h.ctx(), h.ev(60, 20));
    expect(getPixel(layerOf(h.s.preview!).tiles, 40, 20)).toEqual([255, 0, 0, 255]);
    brush.up!(h.ctx(), h.ev(60, 20));
    expect(h.s.history).toEqual(["Brush Tool"]);
    expect(h.s.preview).toBeNull();
    // Dabs are evenly spaced, so the stroke may stop short of the release point by < 1 spacing.
    const b = contentBounds(layerOf(h.s.doc).tiles);
    expect([b.x, b.y, b.h]).toEqual([15, 15, 10]);
    expect(b.w).toBeGreaterThanOrEqual(48);
  });

  it("does not paint on hidden layers", async () => {
    const d = blank();
    const h = harness(updateLayer(d, d.activeLayerId, { visible: false }));
    await h.drag("brush", [10, 10], [50, 50]);
    expect(h.s.history).toEqual([]);
  });

  it("shift-click draws a straight line from the last stroke", async () => {
    const h = harness(blank());
    await h.drag("brush", [10, 50], [10, 50]);
    await h.drag("brush", [90, 50], [90, 50], { shift: true });
    expect(getPixel(layerOf(h.s.doc).tiles, 50, 50)[3]).toBe(255);
  });

  it("erases", async () => {
    const h = harness(createDocument({ width: 100, height: 100 }));
    await h.drag("eraser", [50, 50], [50, 50]);
    expect(getPixel(layerOf(h.s.doc).tiles, 50, 50)[3]).toBe(0);
    expect(h.s.history).toEqual(["Eraser"]);
  });
});

describe("selection tools", () => {
  it("marquee selects a rectangle; shift adds; a click deselects", async () => {
    const h = harness(blank());
    await h.drag("marquee-rect", [10, 10], [30, 20]);
    expect(h.s.doc.selection!.bounds).toEqual(rect(10, 10, 20, 10));
    expect(h.s.overlay).toBeNull();
    await h.drag("marquee-rect", [50, 50], [60, 60], { shift: true });
    expect(h.s.doc.selection!.bounds).toEqual(rect(10, 10, 50, 50));
    await h.drag("marquee-rect", [5, 5], [5, 5]);
    expect(h.s.doc.selection).toBeNull();
    expect(h.s.history).toEqual(["Rectangular Marquee", "Rectangular Marquee", "Deselect"]);
  });

  it("shows a live overlay while dragging", async () => {
    const h = harness(blank());
    const t = h.tools.byId["marquee-ellipse"];
    t.down!(h.ctx(), h.ev(10, 10));
    t.move!(h.ctx(), h.ev(40, 30));
    expect(h.s.overlay).toEqual({ kind: "marquee", shape: "ellipse", rect: rect(10, 10, 30, 20) });
  });

  it("lasso selects a polygon", async () => {
    const h = harness(blank());
    const t = h.tools.byId.lasso;
    t.down!(h.ctx(), h.ev(10, 10));
    for (const [x, y] of [[50, 10], [50, 50], [10, 50]]) t.move!(h.ctx(), h.ev(x, y));
    t.up!(h.ctx(), h.ev(10, 50));
    expect(h.s.doc.selection!.bounds).toEqual(rect(10, 10, 40, 40));
  });

  it("magic wand and paint bucket use the active layer", async () => {
    const d = createDocument({ width: 100, height: 100 });
    const id = d.activeLayerId;
    const h = harness(updateLayer(d, id, { tiles: fillTiles(layerOf(d).tiles, rect(0, 0, 50, 100), { r: 0, g: 0, b: 0 }) }));
    await h.drag("wand", [10, 10], [10, 10]);
    expect(h.s.doc.selection!.bounds).toEqual(rect(0, 0, 50, 100));
    h.s.doc = { ...h.s.doc, selection: null };
    await h.drag("bucket", [80, 80], [80, 80]);
    expect(getPixel(layerOf(h.s.doc).tiles, 80, 80)).toEqual([255, 0, 0, 255]);
    expect(getPixel(layerOf(h.s.doc).tiles, 10, 10)).toEqual([0, 0, 0, 255]);
  });
});

describe("move and transform", () => {
  const withSquare = () => {
    const d = blank();
    return updateLayer(d, d.activeLayerId, { tiles: fillTiles(EMPTY_TILES, rect(10, 10, 10, 10), { r: 0, g: 255, b: 0 }) });
  };

  it("moves the layer by whole pixels when dragged inside the controls", async () => {
    const h = harness(withSquare());
    await h.drag("move", [15, 15], [25.4, 35.6]);
    expect(contentBounds(layerOf(h.s.doc).tiles)).toEqual(rect(20, 31, 10, 10));
    expect(h.s.history).toEqual(["Move"]);
  });

  it("moves only selected pixels, and the selection with them", async () => {
    const h = harness({ ...withSquare(), selection: rectMask(100, 100, rect(10, 10, 5, 10)) });
    await h.drag("move", [12, 12], [52, 12]);
    const tiles = layerOf(h.s.doc).tiles;
    expect(getPixel(tiles, 12, 12)[3]).toBe(0);
    expect(getPixel(tiles, 17, 12)[3]).toBe(255);
    expect(getPixel(tiles, 52, 12)[3]).toBe(255);
    expect(h.s.doc.selection!.bounds).toEqual(rect(50, 10, 5, 10));
  });

  it("dragging a Move-tool handle hands over to Free Transform", async () => {
    const h = harness(withSquare());
    await h.drag("move", [20, 20], [30, 30]); // bottom-right corner handle
    expect(h.s.tool).toBe("transform");
    expect(h.s.overlay?.kind).toBe("transform");
    h.tools.transform.commit!(h.ctx());
    await h.s.pending;
    expect(h.s.history).toEqual(["Free Transform"]);
    expect(h.s.tool).toBe("move");
    expect(contentBounds(layerOf(h.s.doc).tiles)).toEqual(rect(10, 10, 20, 20));
  });

  it("the Move tool ignores handles when transform controls are off", async () => {
    const h = harness(withSquare());
    const off = { ...h.ctx(), settings: { ...settings, transform: { ...settings.transform, showControls: false } } };
    h.tools.byId.move.down!(off, h.ev(20, 20));
    expect(h.s.tool).toBe("move");
  });

  it("free transform previews through a floating layer and commits", async () => {
    const h = harness(withSquare());
    const t = h.tools.transform;
    expect(t.begin(h.ctx(), { returnTo: "brush" })).toBe(true);
    h.s.tool = "transform";
    expect(h.s.floating!.bounds).toEqual(rect(10, 10, 10, 10));
    t.down!(h.ctx(), h.ev(20, 20));
    t.move!(h.ctx(), h.ev(30, 30));
    t.up!(h.ctx(), h.ev(30, 30));
    expect(h.s.floating!.mapping.quad[2]).toEqual({ x: 30, y: 30 });
    t.commit!(h.ctx());
    await h.s.pending;
    expect(h.s.history).toEqual(["Free Transform"]);
    expect(h.s.tool).toBe("brush");
    expect(h.s.overlay).toBeNull();
    expect(contentBounds(layerOf(h.s.doc).tiles)).toEqual(rect(10, 10, 20, 20));
  });

  it("steps back within the session, then cancels without changing the document", async () => {
    const d = withSquare();
    const h = harness(d);
    const t = h.tools.transform;
    t.begin(h.ctx(), { returnTo: "move" });
    t.command(h.ctx(), "flip-horizontal");
    t.command(h.ctx(), "rotate-90-cw");
    expect(t.undo(h.ctx())).toBe(true);
    expect(t.undo(h.ctx())).toBe(true);
    expect(t.undo(h.ctx())).toBe(false);
    t.cancel!(h.ctx());
    expect(h.s.doc).toBe(d);
    expect(h.s.preview).toBeNull();
  });

  it("flips about the reference point", async () => {
    const d = blank();
    const h = harness(updateLayer(d, d.activeLayerId, { tiles: fillTiles(EMPTY_TILES, rect(10, 10, 5, 10), { r: 0, g: 0, b: 255 }) }));
    h.tools.transform.begin(h.ctx(), { returnTo: "move" });
    h.tools.transform.command(h.ctx(), "rotate-180");
    h.tools.transform.commit!(h.ctx());
    await h.s.pending;
    expect(contentBounds(layerOf(h.s.doc).tiles)).toEqual(rect(10, 10, 5, 10));
    expect(h.s.history).toEqual(["Free Transform"]);
  });

  it("double-clicking inside commits", async () => {
    const h = harness(withSquare());
    h.tools.transform.begin(h.ctx(), { returnTo: "move" });
    h.tools.transform.command(h.ctx(), "flip-vertical");
    h.tools.transform.down!(h.ctx(), h.ev(15, 15, { clicks: 2 }));
    await h.s.pending;
    expect(h.s.history).toEqual(["Free Transform"]);
  });

  it("refuses to transform an empty layer", () => {
    const h = harness(blank());
    expect(h.tools.transform.begin(h.ctx(), { returnTo: "move" })).toBe(false);
  });
});

describe("navigation", () => {
  it("eyedropper samples the composite", async () => {
    const h = harness(createDocument({ width: 10, height: 10, background: { r: 1, g: 2, b: 3 } }));
    await h.drag("eyedropper", [5, 5], [5, 5]);
    expect(h.s.fg).toEqual({ r: 1, g: 2, b: 3 });
  });
  it("hand pans and zoom zooms about the cursor", async () => {
    const h = harness(blank());
    await h.drag("hand", [10, 10], [30, 50]);
    expect(h.s.view).toEqual({ zoom: 1, panX: 20, panY: 40 });
    await h.drag("zoom", [100, 100], [100, 100]);
    expect(h.s.view.zoom).toBe(2);
  });
});

describe("shape tools", () => {
  it("draws a live shape layer named after the tool, filled with the foreground", async () => {
    const h = harness(blank());
    await h.drag("rectangle", [10, 20], [50, 60]);
    expect(h.s.history).toEqual(["Rectangle Tool"]);
    const l = layerOf(h.s.doc);
    expect(l.name).toBe("Rectangle 1");
    expect(l.content.kind).toBe("shape");
    expect(getPixel(l.tiles, 30, 40)).toEqual([255, 0, 0, 255]);
    expect(contentBounds(l.tiles)).toEqual(rect(10, 20, 40, 40));
    await h.drag("rectangle", [60, 60], [90, 90]);
    expect(layerOf(h.s.doc).name).toBe("Rectangle 2");
  });

  it("constrains with Shift and draws from the centre with Alt (pressed after starting)", async () => {
    const h = harness(blank());
    const t = h.tools.byId.ellipse;
    t.down!(h.ctx(), h.ev(50, 50));
    t.move!(h.ctx(), h.ev(70, 60, { shift: true, alt: true }));
    t.up!(h.ctx(), h.ev(70, 60, { shift: true, alt: true }));
    expect(contentBounds(layerOf(h.s.doc).tiles)).toEqual(rect(30, 30, 40, 40));
  });

  it("draws lines along the drag with the configured weight", async () => {
    const h = harness(blank());
    await h.drag("line", [10, 50], [90, 50]);
    const l = layerOf(h.s.doc);
    expect(contentBounds(l.tiles)).toEqual(rect(10, 49, 80, 2));
  });

  it("fills pixels into the active layer in Pixels mode, and won't draw onto a shape", async () => {
    const h = harness(blank(), { shape: { ...DEFAULT_SETTINGS.shape, mode: "pixels" } });
    await h.drag("rectangle", [10, 10], [30, 30]);
    expect(h.s.doc.layers.length).toBe(2);
    expect(layerOf(h.s.doc).content.kind).toBe("pixels");
    expect(getPixel(layerOf(h.s.doc).tiles, 20, 20)).toEqual([255, 0, 0, 255]);

    const shapes = harness(blank());
    await shapes.drag("rectangle", [10, 10], [30, 30]);
    const px = harness(shapes.s.doc, { shape: { ...DEFAULT_SETTINGS.shape, mode: "pixels" } });
    await px.drag("rectangle", [50, 50], [60, 60]);
    expect(px.s.prompts).toEqual(["shape"]);
    expect(px.s.history).toEqual([]);
  });

  it("moves a shape by its placement, re-rendering it exactly", async () => {
    const h = harness(blank());
    await h.drag("rectangle", [10, 10], [30, 30]);
    await h.drag("move", [20, 20], [45, 25]);
    const l = layerOf(h.s.doc);
    expect(h.s.history).toEqual(["Rectangle Tool", "Move"]);
    expect(contentBounds(l.tiles)).toEqual(rect(35, 15, 20, 20));
    expect(l.content.kind === "shape" && l.content.placement.quad[0]).toEqual({ x: 35, y: 15 });
  });
});

describe("smart objects", () => {
  const green = fillTiles(EMPTY_TILES, rect(0, 0, 10, 10), { r: 0, g: 255, b: 0 });
  const withSmart = async () => {
    const d = blank();
    const placement = { source: rect(0, 0, 10, 10), quad: quadOf(rect(20, 20, 10, 10)), angle: 0, patch: null };
    const layer = await smartObjectLayer(d, smartSource("img", 10, 10, green), async (f, m, filter, clip) => transformFloatingCpu(f, m, filter, clip), placement);
    return addLayer(d, layer);
  };

  it("asks to rasterize before painting", async () => {
    const h = harness(await withSmart());
    await h.drag("brush", [25, 25], [26, 26]);
    expect(h.s.prompts).toEqual(["smart"]);
    expect(h.s.history).toEqual([]);
  });

  it("re-renders from the source on every transform, so scaling down and up is lossless", async () => {
    const h = harness(await withSmart());
    h.tools.transform.begin(h.ctx(), { returnTo: "move" });
    h.tools.transform.setState(h.ctx(), { ...h.tools.transform.state()!, quad: quadOf(rect(20, 20, 2, 2)) });
    h.tools.transform.commit!(h.ctx());
    await h.s.pending;
    h.tools.transform.begin(h.ctx(), { returnTo: "move" });
    h.tools.transform.setState(h.ctx(), { ...h.tools.transform.state()!, quad: quadOf(rect(20, 20, 40, 40)) });
    h.tools.transform.commit!(h.ctx());
    await h.s.pending;
    const l = layerOf(h.s.doc);
    expect(h.s.history).toEqual(["Free Transform", "Free Transform"]);
    expect(getPixel(l.tiles, 40, 40)).toEqual([0, 255, 0, 255]);
    expect(contentBounds(l.tiles)).toEqual(rect(20, 20, 40, 40));
  });

  it("transforms the whole smart object regardless of the selection", async () => {
    const d = await withSmart();
    const h = harness({ ...d, selection: rectMask(100, 100, rect(0, 0, 22, 22)) });
    h.tools.transform.begin(h.ctx(), { returnTo: "move" });
    expect(h.tools.transform.state()!.quad).toEqual(quadOf(rect(20, 20, 10, 10)));
  });

  it("Place Embedded commits even without a transform, and cancelling discards the layer", async () => {
    const d = blank();
    const placed = addLayer(d, createLayerFor(d));
    const h = harness(d);
    h.tools.transform.begin(h.ctx(), { returnTo: "move", place: { doc: placed, label: "Place Embedded" } });
    h.tools.transform.cancel!(h.ctx());
    expect(h.s.doc).toBe(d);
    h.tools.transform.begin(h.ctx(), { returnTo: "move", place: { doc: placed, label: "Place Embedded" } });
    h.tools.transform.commit!(h.ctx());
    await h.s.pending;
    expect(h.s.history).toEqual(["Place Embedded"]);
    expect(h.s.doc.layers.length).toBe(3);
  });

  it("converts pixels to a smart object in place", () => {
    const d = withSquareDoc();
    const c = convertToSmartObject(d, d.activeLayerId);
    const l = layerOf(c);
    expect(l.content.kind).toBe("smart");
    expect(l.tiles).toBe(layerOf(d).tiles);
  });
});

/** A smart object layer (not yet in `d`), as Place Embedded makes. */
function createLayerFor(d: Doc) {
  const l = createLayer({ name: "img", tiles: fillTiles(EMPTY_TILES, rect(0, 0, 100, 100), { r: 1, g: 2, b: 3 }) });
  return layerOf(convertToSmartObject(addLayer(d, l), l.id));
}

function withSquareDoc() {
  const d = blank();
  return updateLayer(d, d.activeLayerId, { tiles: fillTiles(EMPTY_TILES, rect(10, 10, 10, 10), { r: 9, g: 9, b: 9 }) });
}
