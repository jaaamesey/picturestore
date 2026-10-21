import { describe, expect, it } from "vitest";
import { DEFAULT_BRUSH } from "../../core/brush";
import { addLayer, createDocument, fillPixels, updateLayer, type Doc } from "../../core/document";
import { rect } from "../../core/geometry";
import { rectMask } from "../../core/selection";
import { NO_PIXELS, contentBounds, getPixel } from "../../core/pixels";
import type { FloatingLayer, View } from "../../gpu/renderer";
import { DEFAULT_SETTINGS } from "../editor";
import type { Overlay, ToolContext, ToolEvent, ToolId, ToolSettings, Writable } from "../types";
import { createTools } from "./index";
import { moveFrame } from "./transform";
import { screenToDoc } from "../view";
import { createSnapper } from "../snapping";
import { defaultPreferences } from "../preferences";
import { DEFAULT_VIEW_OPTIONS, type SnapToOptions } from "../viewOptions";
import type { SmartGuide } from "../../core/snap";
import { CPU_RASTERIZERS, smartObjectLayer, smartSource, wholePixelMove } from "../../core/content";
import { convertToSmartObject, createLayer } from "../../core/document";
import { IDENTITY_PATCH, quadOf } from "../../core/warp";

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
    view: { zoom: 1, panX: 0, panY: 0 } as View,
    fg: { r: 255, g: 0, b: 0 },
    tool: "move" as ToolId,
    pending: Promise.resolve() as Promise<void>,
    /** Rasterize prompts the tools raised. */
    prompts: [] as string[],
    /** Snapping is off unless a test turns it on. */
    snapTo: null as SnapToOptions | null,
    smartGuides: [] as readonly SmartGuide[],
    lockGuides: false,
    settings: structuredClone({ ...settings, ...options }) as Writable<ToolSettings>,
  };
  const ctx = (): ToolContext => ({
    doc: s.doc,
    view: s.view,
    settings: structuredClone(s.settings),
    foreground: s.fg,
    preview: (d, f = null) => ((s.preview = d), (s.floating = f)),
    commit: (label, d) => (s.history.push(label), (s.doc = d), (s.preview = null), (s.floating = null)),
    commitAsync(label, pending, landed) {
      s.pending = pending.then((d) => {
        s.history.push(label);
        s.doc = d;
        s.preview = null;
        s.floating = null;
        landed?.();
      });
    },
    raster: CPU_RASTERIZERS,
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
    viewport: { width: 800, height: 600 },
    viewOptions: { ...DEFAULT_VIEW_OPTIONS, snap: !!s.snapTo, lockGuides: s.lockGuides },
    snap: createSnapper(s.doc, s.view.zoom, s.snapTo, defaultPreferences(), (g) => (s.smartGuides = g)),
    updateSettings: (fn) => fn(s.settings),
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
    expect(getPixel(layerOf(h.s.preview!).pixels, 40, 20)).toEqual([255, 0, 0, 255]);
    brush.up!(h.ctx(), h.ev(60, 20));
    expect(h.s.history).toEqual(["Brush Tool"]);
    expect(h.s.preview).toBeNull();
    // Dabs are evenly spaced, so the stroke may stop short of the release point by < 1 spacing.
    const b = contentBounds(layerOf(h.s.doc).pixels);
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
    expect(getPixel(layerOf(h.s.doc).pixels, 50, 50)[3]).toBe(255);
  });

  it("erases", async () => {
    const h = harness(createDocument({ width: 100, height: 100 }));
    await h.drag("eraser", [50, 50], [50, 50]);
    expect(getPixel(layerOf(h.s.doc).pixels, 50, 50)[3]).toBe(0);
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
    const h = harness(updateLayer(d, id, { pixels: fillPixels(layerOf(d).pixels, rect(0, 0, 50, 100), { r: 0, g: 0, b: 0 }) }));
    await h.drag("wand", [10, 10], [10, 10]);
    expect(h.s.doc.selection!.bounds).toEqual(rect(0, 0, 50, 100));
    h.s.doc = { ...h.s.doc, selection: null };
    await h.drag("bucket", [80, 80], [80, 80]);
    expect(getPixel(layerOf(h.s.doc).pixels, 80, 80)).toEqual([255, 0, 0, 255]);
    expect(getPixel(layerOf(h.s.doc).pixels, 10, 10)).toEqual([0, 0, 0, 255]);
  });
});

describe("move and transform", () => {
  const withSquare = () => {
    const d = blank();
    return updateLayer(d, d.activeLayerId, { pixels: fillPixels(NO_PIXELS, rect(10, 10, 10, 10), { r: 0, g: 255, b: 0 }) });
  };

  it("moves the layer by whole pixels when dragged inside the controls", async () => {
    const h = harness(withSquare());
    await h.drag("move", [15, 15], [25.4, 35.6]);
    expect(contentBounds(layerOf(h.s.doc).pixels)).toEqual(rect(20, 31, 10, 10));
    expect(h.s.history).toEqual(["Move"]);
  });

  it("moves only selected pixels, and the selection with them", async () => {
    const h = harness({ ...withSquare(), selection: rectMask(100, 100, rect(10, 10, 5, 10)) });
    await h.drag("move", [12, 12], [52, 12]);
    const pixels = layerOf(h.s.doc).pixels;
    expect(getPixel(pixels, 12, 12)[3]).toBe(0);
    expect(getPixel(pixels, 17, 12)[3]).toBe(255);
    expect(getPixel(pixels, 52, 12)[3]).toBe(255);
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
    expect(contentBounds(layerOf(h.s.doc).pixels)).toEqual(rect(10, 10, 20, 20));
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
    expect(contentBounds(layerOf(h.s.doc).pixels)).toEqual(rect(10, 10, 20, 20));
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
    const h = harness(updateLayer(d, d.activeLayerId, { pixels: fillPixels(NO_PIXELS, rect(10, 10, 5, 10), { r: 0, g: 0, b: 255 }) }));
    h.tools.transform.begin(h.ctx(), { returnTo: "move" });
    h.tools.transform.command(h.ctx(), "rotate-180");
    h.tools.transform.commit!(h.ctx());
    await h.s.pending;
    expect(contentBounds(layerOf(h.s.doc).pixels)).toEqual(rect(10, 10, 5, 10));
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
    expect(getPixel(l.pixels, 30, 40)).toEqual([255, 0, 0, 255]);
    expect(contentBounds(l.pixels)).toEqual(rect(10, 20, 40, 40));
    await h.drag("rectangle", [60, 60], [90, 90]);
    expect(layerOf(h.s.doc).name).toBe("Rectangle 2");
  });

  it("constrains with Shift and draws from the centre with Alt (pressed after starting)", async () => {
    const h = harness(blank());
    const t = h.tools.byId.ellipse;
    t.down!(h.ctx(), h.ev(50, 50));
    t.move!(h.ctx(), h.ev(70, 60, { shift: true, alt: true }));
    t.up!(h.ctx(), h.ev(70, 60, { shift: true, alt: true }));
    await h.s.pending;
    expect(contentBounds(layerOf(h.s.doc).pixels)).toEqual(rect(30, 30, 40, 40));
  });

  it("draws lines along the drag with the configured weight", async () => {
    const h = harness(blank());
    await h.drag("line", [10, 50], [90, 50]);
    const l = layerOf(h.s.doc);
    expect(contentBounds(l.pixels)).toEqual(rect(10, 49, 80, 2));
  });

  it("fills pixels into the active layer in Pixels mode, and won't draw onto a shape", async () => {
    const h = harness(blank(), { shape: { ...DEFAULT_SETTINGS.shape, mode: "pixels" } });
    await h.drag("rectangle", [10, 10], [30, 30]);
    expect(h.s.doc.layers.length).toBe(2);
    expect(layerOf(h.s.doc).content.kind).toBe("pixels");
    expect(getPixel(layerOf(h.s.doc).pixels, 20, 20)).toEqual([255, 0, 0, 255]);

    const shapes = harness(blank());
    await shapes.drag("rectangle", [10, 10], [30, 30]);
    const px = harness(shapes.s.doc, { shape: { ...DEFAULT_SETTINGS.shape, mode: "pixels" } });
    await px.drag("rectangle", [50, 50], [60, 60]);
    expect(px.s.prompts).toEqual(["shape"]);
    expect(px.s.history).toEqual([]);
  });

  it("previews shapes as vectors (the renderer draws them), and commits their pixels", async () => {
    const h = harness(blank());
    const t = h.tools.byId.rectangle;
    t.down!(h.ctx(), h.ev(10, 10));
    t.move!(h.ctx(), h.ev(30, 30));
    // Nothing is rasterized while drawing: the preview is the shape itself.
    expect(layerOf(h.s.preview!).content.kind).toBe("shape");
    expect(layerOf(h.s.preview!).pixels.size).toBe(0);
    t.up!(h.ctx(), h.ev(30, 30));
    await h.s.pending;
    expect(contentBounds(layerOf(h.s.doc).pixels)).toEqual(rect(10, 10, 20, 20));

    const move = h.tools.byId.move;
    move.down!(h.ctx(), h.ev(20, 20));
    move.move!(h.ctx(), h.ev(45, 25));
    const p = layerOf(h.s.preview!).content;
    expect(p.kind === "shape" && p.placement.quad[0]).toEqual({ x: 35, y: 15 });
    expect(h.s.floating).toBeNull();
    move.up!(h.ctx(), h.ev(45, 25));
    await h.s.pending;
    expect(contentBounds(layerOf(h.s.doc).pixels)).toEqual(rect(35, 15, 20, 20));
  });

  it("the Move tool's frame follows the content while dragging", async () => {
    const h = harness(blank());
    await h.drag("rectangle", [10, 10], [30, 30]);
    const move = h.tools.byId.move;
    move.down!(h.ctx(), h.ev(20, 20));
    move.move!(h.ctx(), h.ev(45, 25));
    expect(h.s.overlay).toEqual({ kind: "frame", state: expect.objectContaining({ quad: quadOf(rect(35, 15, 20, 20)) }) });
    move.up!(h.ctx(), h.ev(45, 25));
    expect(h.s.overlay).toBeNull();
  });

  it("moves warped shapes as they are (recognisably moved), while their frame hugs the warp", async () => {
    const d = blank();
    const geometry = { kind: "rectangle", radius: 0 } as const;
    const style = { fill: { r: 1, g: 2, b: 3 }, stroke: null };
    const patch = IDENTITY_PATCH.map((p, k) => (k === 1 || k === 2 ? { x: p.x, y: p.y - 0.5 } : p));
    const placement = { source: rect(0, 0, 20, 20), quad: quadOf(rect(20, 40, 20, 20)), angle: 0, patch };
    const content = { kind: "shape" as const, geometry, style, placement };
    const h = harness(addLayer(d, createLayer({ name: "warped", content })));
    // The frame's top is above the quad's: the warp pulls the top edge up.
    expect(moveFrame(h.s.doc)!.quad[0].y).toBeLessThan(40);
    const move = h.tools.byId.move;
    move.down!(h.ctx(), h.ev(30, 50));
    move.move!(h.ctx(), h.ev(37, 52));
    const shown = layerOf(h.s.preview!).content;
    expect(shown.kind === "shape" && wholePixelMove(content, shown)).toEqual({ x: 7, y: 2 });
  });

  it("moves a shape by its placement, re-rendering it exactly", async () => {
    const h = harness(blank());
    await h.drag("rectangle", [10, 10], [30, 30]);
    await h.drag("move", [20, 20], [45, 25]);
    const l = layerOf(h.s.doc);
    expect(h.s.history).toEqual(["Rectangle Tool", "Move"]);
    expect(contentBounds(l.pixels)).toEqual(rect(35, 15, 20, 20));
    expect(l.content.kind === "shape" && l.content.placement.quad[0]).toEqual({ x: 35, y: 15 });
  });
});

describe("smart objects", () => {
  const green = fillPixels(NO_PIXELS, rect(0, 0, 10, 10), { r: 0, g: 255, b: 0 });
  const withSmart = async () => {
    const d = blank();
    const placement = { source: rect(0, 0, 10, 10), quad: quadOf(rect(20, 20, 10, 10)), angle: 0, patch: null };
    const layer = await smartObjectLayer(d, smartSource("img", 10, 10, green), CPU_RASTERIZERS, placement);
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
    expect(getPixel(l.pixels, 40, 40)).toEqual([0, 255, 0, 255]);
    expect(contentBounds(l.pixels)).toEqual(rect(20, 20, 40, 40));
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
    expect(l.pixels).toBe(layerOf(d).pixels);
  });
});

/** A smart object layer (not yet in `d`), as Place Embedded makes. */
function createLayerFor(d: Doc) {
  const l = createLayer({ name: "img", pixels: fillPixels(NO_PIXELS, rect(0, 0, 100, 100), { r: 1, g: 2, b: 3 }) });
  return layerOf(convertToSmartObject(addLayer(d, l), l.id));
}

function withSquareDoc() {
  const d = blank();
  return updateLayer(d, d.activeLayerId, { pixels: fillPixels(NO_PIXELS, rect(10, 10, 10, 10), { r: 9, g: 9, b: 9 }) });
}

describe("rasterize prompts", () => {
  it("pass along how to carry on, for single-click actions", async () => {
    const d = blank();
    const shape = createLayer({ name: "s", content: { kind: "shape", geometry: { kind: "ellipse" }, style: { fill: { r: 0, g: 0, b: 0 }, stroke: null }, placement: { source: rect(0, 0, 10, 10), quad: quadOf(rect(0, 0, 10, 10)), angle: 0, patch: null } } });
    const h = harness(addLayer(d, shape));
    let proceed: ((c: ToolContext) => void) | undefined;
    const ctx = { ...h.ctx(), requireEditable: (_: unknown, p?: (c: ToolContext) => void) => ((proceed = p), false) };
    h.tools.byId.bucket.down!(ctx, h.ev(50, 50));
    expect(proceed).toBeDefined();
    // Once rasterized, carrying on fills.
    const rasterized = updateLayer(h.s.doc, shape.id, { content: { kind: "pixels" } });
    h.s.doc = rasterized;
    proceed!(h.ctx());
    expect(h.s.history).toEqual(["Paint Bucket"]);
  });
});

describe("crop", () => {
  /** A 100×100 document: white background, and a red 20×20 square at (40, 40) on the active layer. */
  const doc = () => {
    const d = blank();
    return updateLayer(d, d.activeLayerId, { pixels: fillPixels(NO_PIXELS, rect(40, 40, 20, 20), { r: 255, g: 0, b: 0 }) });
  };
  /** Pointer events at screen points, through the current (possibly rotated) view. */
  const pointer = (h: ReturnType<typeof harness>) => {
    const at = (x: number, y: number, mods: Partial<ToolEvent> = {}): ToolEvent => {
      const d = screenToDoc(h.s.view, { x, y });
      return { ...h.ev(d.x, d.y, mods), screenX: x, screenY: y };
    };
    const tool = () => h.tools.byId[h.s.tool];
    return async (from: [number, number], to: [number, number], mods: Partial<ToolEvent> = {}) => {
      tool().down!(h.ctx(), at(...from, mods));
      for (let i = 1; i <= 8; i++) tool().move!(h.ctx(), at(from[0] + ((to[0] - from[0]) * i) / 8, from[1] + ((to[1] - from[1]) * i) / 8, mods));
      tool().up!(h.ctx(), at(...to, mods));
      await h.s.pending;
    };
  };
  const cropBox = (h: ReturnType<typeof harness>) => (h.s.overlay?.kind === "crop" ? h.s.overlay.box : null);
  const start = (d: Doc, crop: Partial<ToolSettings["crop"]> = {}) => {
    const h = harness(d, { crop: { ...settings.crop, ...crop } });
    h.s.tool = "crop";
    h.tools.crop.activate!(h.ctx());
    return { h, drag: pointer(h) };
  };

  it("shows the whole canvas at once, and an untouched box crops nothing", () => {
    const { h } = start(doc());
    expect(cropBox(h)).toEqual({ cx: 50, cy: 50, w: 100, h: 100, angle: 0 });
    h.tools.crop.commit!(h.ctx());
    expect(h.s.history).toEqual([]);
    expect(h.s.overlay).toBeNull();
  });

  it("starts from the selection's bounds", () => {
    const { h } = start({ ...doc(), selection: rectMask(100, 100, rect(10, 20, 30, 40)) });
    expect(cropBox(h)).toEqual({ cx: 25, cy: 40, w: 30, h: 40, angle: 0 });
  });

  it("draws a box, crops to it exactly, then hides it until the next click", async () => {
    const { h, drag } = start(doc(), { classic: true });
    await drag([30, 30], [70, 60]);
    expect(cropBox(h)).toEqual({ cx: 50, cy: 45, w: 40, h: 30, angle: 0 });
    h.tools.crop.commit!(h.ctx());
    await h.s.pending;
    expect(h.s.history).toEqual(["Crop"]);
    expect([h.s.doc.width, h.s.doc.height]).toEqual([40, 30]);
    expect(contentBounds(layerOf(h.s.doc).pixels)).toEqual(rect(10, 10, 20, 20));
    expect(h.s.overlay).toBeNull();
    await drag([5, 5], [5, 5]);
    expect(cropBox(h)).toEqual({ cx: 20, cy: 15, w: 40, h: 30, angle: 0 });
  });

  it("keeps cropped pixels beyond the canvas unless Delete Cropped Pixels is on", async () => {
    for (const deletePixels of [false, true]) {
      const { h, drag } = start(doc(), { classic: true, deletePixels });
      await drag([50, 0], [50, 0]); // a click on an edge changes nothing
      await drag([20, 15], [50, 100]);
      h.tools.crop.commit!(h.ctx());
      await h.s.pending;
      expect(contentBounds(layerOf(h.s.doc).pixels)).toEqual(deletePixels ? rect(20, 25, 10, 20) : rect(20, 25, 20, 20));
    }
  });

  it("resizes from a handle, snapping to the canvas edge, and grows the canvas beyond it", async () => {
    const { h, drag } = start(doc(), { classic: true });
    h.s.snapTo = { guides: true, grid: false, layers: true, bounds: true };
    await drag([100, 50], [97, 50]); // snaps back to the edge
    expect(cropBox(h)!.w).toBe(100);
    await drag([100, 50], [130, 50]);
    expect(cropBox(h)).toEqual({ cx: 65, cy: 50, w: 130, h: 100, angle: 0 });
    h.tools.crop.commit!(h.ctx());
    await h.s.pending;
    expect(h.s.doc.width).toBe(130);
    // The added canvas is transparent (there's no locked Background layer to fill).
    expect(getPixel(h.s.doc.layers[0].pixels, 120, 50)[3]).toBe(0);
  });

  it("turns the image under a fixed box (the view rotates), and crops it rotated", async () => {
    const { h, drag } = start(doc());
    // Drag outside the box, a quarter turn clockwise about its centre (50, 50).
    await drag([150, 50], [50, 150]);
    expect(h.s.view.rotation).toBeCloseTo(Math.PI / 2, 9);
    const b = cropBox(h)!;
    expect(b.angle).toBeCloseTo(-Math.PI / 2, 9);
    expect([b.cx, b.cy]).toEqual([50, 50]);
    h.tools.crop.commit!(h.ctx());
    await h.s.pending;
    expect([h.s.doc.width, h.s.doc.height]).toEqual([100, 100]);
    expect(h.s.view.rotation ?? 0).toBe(0);
  });

  it("straightens: the line comes out level and the box shrinks to leave no empty corners", async () => {
    const { h, drag } = start(doc(), { classic: true });
    await drag([10, 40], [90, 50], { mod: true });
    const b = cropBox(h)!;
    expect(b.angle).toBeCloseTo(Math.atan2(10, 80), 9);
    expect(b.w).toBeLessThan(100);
    h.tools.crop.commit!(h.ctx());
    await h.s.pending;
    expect([h.s.doc.width, h.s.doc.height]).toEqual([Math.round(b.w), Math.round(b.h)]);
    // No transparent corners.
    expect(getPixel(h.s.doc.layers[0].pixels, 1, 1)[3]).toBe(255);
  });

  it("fits the box to a ratio, and resamples to W x H x Resolution", async () => {
    const { h, drag } = start(doc(), {
      classic: true,
      constraint: { mode: "size", width: { value: 2, unit: "inches" }, height: { value: 1, unit: "inches" }, resolution: 100 },
    });
    expect(cropBox(h)).toEqual({ cx: 50, cy: 50, w: 100, h: 50, angle: 0 });
    await drag([100, 75], [100, 75]);
    h.tools.crop.commit!(h.ctx());
    await h.s.pending;
    expect([h.s.doc.width, h.s.doc.height, h.s.doc.resolution]).toEqual([200, 100, 100]);
  });

  it("Escape resets the box and the view", async () => {
    const { h, drag } = start(doc());
    const view = h.s.view;
    await drag([150, 50], [50, 150]);
    h.tools.crop.cancel!(h.ctx());
    expect(h.s.view).toEqual(view);
    expect(cropBox(h)).toEqual({ cx: 50, cy: 50, w: 100, h: 100, angle: 0 });
  });

  it("switching tools crops", async () => {
    const { h, drag } = start(doc(), { classic: true });
    await drag([30, 30], [70, 60]);
    // The editor commits tools that commit on switch.
    expect(h.tools.crop.commitOnSwitch).toBe(true);
  });

  it("toggles its options from the keyboard", () => {
    const { h } = start(doc(), { classic: true });
    const key = (key: string, shift = false) => h.tools.crop.key!(h.ctx(), { key, shift });
    expect(key("h")).toBe(true);
    expect(h.s.settings.crop.showCropped).toBe(false);
    expect(key("o")).toBe(true);
    expect(h.s.settings.crop.overlay).toBe("grid");
    expect(key("p")).toBe(true);
    expect(h.s.settings.crop.classic).toBe(false);
    // I is the Eyedropper until the box is adjusted.
    expect(key("i")).toBe(false);
    expect(key("x")).toBe(true);
    expect(key("b")).toBe(false);
  });
});

describe("perspective crop", () => {
  it("straightens four clicked corners onto a rectangle", async () => {
    const d = blank();
    const h = harness(d);
    h.s.tool = "perspective-crop";
    const t = h.tools.byId["perspective-crop"];
    t.activate!(h.ctx());
    for (const [x, y] of [[10, 10], [90, 20], [80, 90], [20, 80]]) {
      t.down!(h.ctx(), h.ev(x, y));
      t.up!(h.ctx(), h.ev(x, y));
    }
    expect(h.s.overlay).toMatchObject({ kind: "perspective-crop", valid: true });
    t.commit!(h.ctx());
    await h.s.pending;
    expect(h.s.history).toEqual(["Perspective Crop"]);
    // Opaque everywhere: the quad lay within the white background.
    expect(getPixel(h.s.doc.layers[0].pixels, 1, 1)[3]).toBe(255);
    expect(getPixel(h.s.doc.layers[0].pixels, h.s.doc.width - 2, h.s.doc.height - 2)[3]).toBe(255);
  });

  it("refuses a quad that folds over itself", () => {
    const h = harness(blank());
    const t = h.tools.byId["perspective-crop"];
    h.s.tool = "perspective-crop";
    t.activate!(h.ctx());
    t.down!(h.ctx(), h.ev(10, 10));
    t.move!(h.ctx(), h.ev(60, 60));
    t.up!(h.ctx(), h.ev(60, 60));
    // Drag a corner across the opposite one.
    t.down!(h.ctx(), h.ev(10, 10));
    t.move!(h.ctx(), h.ev(80, 80));
    t.up!(h.ctx(), h.ev(80, 80));
    expect(h.s.overlay).toMatchObject({ valid: false });
    t.commit!(h.ctx());
    expect(h.s.history).toEqual([]);
  });
});

describe("snapping", () => {
  const ALL = { guides: true, grid: false, layers: true, bounds: true };
  /** 100×100: a 24×24 square at (10, 10) on one layer, and a 20×20 one at (60, 60) on the active one. */
  const twoSquares = () => {
    const d = blank();
    const other = createLayer({ name: "other", pixels: fillPixels(NO_PIXELS, rect(10, 10, 24, 24), { r: 0, g: 0, b: 255 }) });
    const withOther = { ...d, layers: [d.layers[0], other, d.layers[1]] };
    return updateLayer(withOther, d.activeLayerId, { pixels: fillPixels(NO_PIXELS, rect(60, 60, 20, 20), { r: 255, g: 0, b: 0 }) });
  };

  it("marquee corners snap to guides and the canvas edge", async () => {
    const h = harness({ ...blank(), guides: [{ orientation: "vertical", position: 40 }] });
    h.s.snapTo = ALL;
    await h.drag("marquee-rect", [3, 4], [37, 97]);
    expect(h.s.doc.selection!.bounds).toEqual(rect(0, 0, 40, 100));
  });

  it("the Move tool snaps a layer's edges and centre to other layers, with smart guides; Ctrl suspends it", async () => {
    const h = harness(twoSquares());
    h.s.snapTo = ALL;
    // Moved 24 left, its left edge (36) is 2 from the other square's right edge (34); its centre is 4 from the canvas's.
    const t = h.tools.byId.move;
    h.s.tool = "move";
    t.down!(h.ctx(), h.ev(70, 70));
    t.move!(h.ctx(), h.ev(46, 70));
    expect(h.s.smartGuides).toContainEqual({ axis: "x", at: 34, from: 10, to: 80 });
    t.up!(h.ctx(), h.ev(46, 70));
    await h.s.pending;
    expect(contentBounds(layerOf(h.s.doc).pixels)).toEqual(rect(34, 60, 20, 20));

    const h2 = harness(twoSquares());
    h2.s.snapTo = ALL;
    await h2.drag("move", [70, 70], [46, 70], { mod: true });
    expect(contentBounds(layerOf(h2.s.doc).pixels)).toEqual(rect(36, 60, 20, 20));
  });

  it("nothing snaps with snapping off", async () => {
    const h = harness(twoSquares());
    await h.drag("move", [70, 70], [46, 70]);
    expect(contentBounds(layerOf(h.s.doc).pixels)).toEqual(rect(36, 60, 20, 20));
  });

  it("Free Transform corners snap where they land", async () => {
    const h = harness(twoSquares());
    h.s.snapTo = ALL;
    h.tools.transform.begin(h.ctx(), { returnTo: "move" });
    h.s.tool = "transform";
    const t = h.tools.transform;
    // Bottom-right corner (80, 80) dragged to (97, 98): snaps to the canvas corner.
    t.down!(h.ctx(), h.ev(80, 80));
    t.move!(h.ctx(), h.ev(97, 98, { shift: true }));
    expect(t.state()!.quad[2]).toEqual({ x: 100, y: 100 });
  });

  it("the Move tool drags guides (snapping them), and drops them off the window to delete", async () => {
    const d = { ...twoSquares(), guides: [{ orientation: "vertical" as const, position: 50 }] };
    const h = harness(d);
    h.s.snapTo = ALL;
    await h.drag("move", [50, 5], [32, 5]);
    expect(h.s.history).toEqual(["Move Guide"]);
    expect(h.s.doc.guides).toEqual([{ orientation: "vertical", position: 34 }]);
    // Untouched content: the drag moved the guide, not the layer.
    expect(contentBounds(layerOf(h.s.doc).pixels)).toEqual(rect(60, 60, 20, 20));
    await h.drag("move", [34, 5], [-900, 5]);
    expect(h.s.history).toEqual(["Move Guide", "Delete Guide"]);
    expect(h.s.doc.guides).toEqual([]);
  });

  it("locked guides stay put", async () => {
    const h = harness({ ...twoSquares(), guides: [{ orientation: "vertical" as const, position: 50 }] });
    h.s.lockGuides = true;
    await h.drag("move", [50, 5], [28, 5]);
    expect(h.s.doc.guides).toEqual([{ orientation: "vertical", position: 50 }]);
  });
});
