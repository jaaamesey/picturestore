import { describe, expect, it } from "vitest";
import { DEFAULT_BRUSH } from "../../core/brush";
import { addLayer, createDocument, editTarget, fillPixels, groupLayers, updateLayer, type Doc } from "../../core/document";
import { childrenOf } from "../../core/layers";
import { rect } from "../../core/geometry";
import { rectMask } from "../../core/selection";
import { NO_PIXELS, contentBounds, getPixel } from "../../core/pixels";
import type { FloatingLayer, View } from "../../gpu/renderer";
import { DEFAULT_SETTINGS } from "../editor";
import { NO_PATH_STATE, type Overlay, type PathState, type ToolContext, type ToolEvent, type ToolId, type ToolSettings, type Writable } from "../types";
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
import { cornerKnot, smoothKnot, type VectorPath } from "../../core/path";
import { flattenKnots } from "../../core/bezier";

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
    /** What the Paragraph Text Size dialog answers. */
    boxSize: null as { width: number; height: number } | null,
    paths: NO_PATH_STATE as PathState,
    settings: structuredClone({ ...settings, ...options }) as Writable<ToolSettings>,
  };
  const ctx = (): ToolContext => ({
    doc: s.doc,
    view: s.view,
    settings: structuredClone(s.settings),
    foreground: s.fg,
    background: { r: 255, g: 255, b: 255 },
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
    editTarget() {
      const t = editTarget(s.doc);
      if (!t || t.mask || t.layer.content.kind === "pixels") return t;
      s.prompts.push(t.layer.content.kind);
      return null;
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
    preferences: defaultPreferences(),
    get paths() {
      return s.paths;
    },
    setPaths: (fn) => (s.paths = fn(s.paths)),
    askBoxSize: async () => s.boxSize,
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
    expect(h.s.floating!.pixels!.bounds).toEqual(rect(10, 10, 10, 10));
    t.down!(h.ctx(), h.ev(20, 20));
    t.move!(h.ctx(), h.ev(30, 30));
    t.up!(h.ctx(), h.ev(30, 30));
    expect(h.s.floating!.pixels!.mapping.quad[2]).toEqual({ x: 30, y: 30 });
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
    const ctx = { ...h.ctx(), editTarget: (p?: (c: ToolContext) => void) => ((proceed = p), null) };
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

describe("masks and groups", () => {
  const squareWithMask = () => {
    const d = blank();
    const mask = { pixels: fillPixels(NO_PIXELS, rect(10, 10, 5, 5), { r: 0, g: 0, b: 0 }), background: 255 as const, enabled: true, linked: true };
    return updateLayer(d, d.activeLayerId, { pixels: fillPixels(NO_PIXELS, rect(10, 10, 10, 10), { r: 0, g: 0, b: 0 }), mask });
  };

  it("a linked mask moves with its layer", async () => {
    const h = harness(squareWithMask());
    await h.drag("move", [15, 15], [45, 25]);
    await h.s.pending;
    const l = layerOf(h.s.doc);
    expect(contentBounds(l.pixels)).toEqual(rect(40, 20, 10, 10));
    expect(contentBounds(l.mask!.pixels)).toEqual(rect(40, 20, 5, 5));
  });

  it("an unlinked mask stays put", async () => {
    const d = squareWithMask();
    const h = harness(updateLayer(d, d.activeLayerId, { mask: { ...layerOf(d).mask!, linked: false } }));
    await h.drag("move", [15, 15], [45, 25]);
    await h.s.pending;
    expect(contentBounds(layerOf(h.s.doc).mask!.pixels)).toEqual(rect(10, 10, 5, 5));
  });

  it("a targeted mask moves on its own, and the brush paints its grey", async () => {
    const h = harness({ ...squareWithMask(), maskTargeted: true });
    await h.drag("move", [12, 12], [32, 12]);
    await h.s.pending;
    const l = layerOf(h.s.doc);
    expect(contentBounds(l.pixels)).toEqual(rect(10, 10, 10, 10));
    expect(contentBounds(l.mask!.pixels)).toEqual(rect(30, 10, 5, 5));
    await h.drag("brush", [80, 80], [80, 80]);
    // Red foreground → its luminosity's grey.
    expect(getPixel(layerOf(h.s.doc).mask!.pixels, 80, 80)).toEqual([77, 77, 77, 255]);
    expect(getPixel(layerOf(h.s.doc).pixels, 80, 80)[3]).toBe(0);
  });

  it("a group moves all its layers; painting on a group without a mask is refused", async () => {
    const d = squareWithMask();
    const grouped = groupLayers(d, [d.activeLayerId]);
    const h = harness(grouped);
    await h.drag("move", [15, 15], [25, 15]);
    await h.s.pending;
    const inner = childrenOf(h.s.doc.layers[1])[0];
    expect(contentBounds(inner.pixels)).toEqual(rect(20, 10, 10, 10));
    expect(contentBounds(inner.mask!.pixels)).toEqual(rect(20, 10, 5, 5));
    await h.drag("brush", [50, 50], [50, 50]);
    expect(h.s.history).toEqual(["Move"]);
    expect(editTarget(h.s.doc)!.layer.content.kind).toBe("group");
  });
});

describe("pen tools", () => {
  const P = (x: number, y: number) => ({ x, y });
  const pathMode = { pen: { ...DEFAULT_SETTINGS.pen, mode: "path" as const } };
  const square: VectorPath = { subpaths: [{ closed: true, op: "combine", knots: [cornerKnot(P(20, 20)), cornerKnot(P(80, 20)), cornerKnot(P(80, 80)), cornerKnot(P(20, 80))] }] };
  /** A harness whose work path is the target, with `selected` anchor points. */
  const withWork = (path: VectorPath, selected: { sub: number; knot: number }[] = []) => {
    const h = harness({ ...blank(), workPath: path }, pathMode);
    h.s.paths = { target: { kind: "work" }, selected };
    return h;
  };
  const anchors = (h: ReturnType<typeof harness>, sub = 0) => h.s.doc.workPath!.subpaths[sub].knots.map((k) => [k.anchor.x, k.anchor.y]);
  const click = (h: ReturnType<typeof harness>, id: ToolId, x: number, y: number, mods: Partial<ToolEvent> = {}) => h.drag(id, [x, y], [x, y], mods);

  describe("Pen", () => {
    it("clicks make corner points, each one history step, the newest selected", async () => {
      const h = harness(blank(), pathMode);
      await click(h, "pen", 20, 20);
      await click(h, "pen", 80, 20);
      await click(h, "pen", 80, 80);
      expect(h.s.history).toEqual(["Pen Tool", "Pen Tool", "Pen Tool"]);
      expect(anchors(h)).toEqual([[20, 20], [80, 20], [80, 80]]);
      expect(h.s.doc.workPath!.subpaths[0].closed).toBe(false);
      expect(h.s.doc.workPath!.subpaths[0].knots.every((k) => k.in.x === k.anchor.x && k.out.y === k.anchor.y)).toBe(true);
      expect(h.s.paths.target).toEqual({ kind: "work" });
      expect(h.s.paths.selected).toEqual([{ sub: 0, knot: 2 }]);
    });

    it("dragging makes a smooth point with mirrored direction lines", async () => {
      const h = harness(blank(), pathMode);
      await click(h, "pen", 20, 50);
      await h.drag("pen", [60, 50], [80, 70]);
      const k = h.s.doc.workPath!.subpaths[0].knots[1];
      expect(k.anchor).toEqual(P(60, 50));
      expect(k.out).toEqual(P(80, 70));
      expect(k.in).toEqual(P(40, 30));
      expect(h.s.history).toEqual(["Pen Tool", "Pen Tool"]);
    });

    it("Shift holds a clicked segment, and a dragged direction line, to 45°", async () => {
      const h = harness(blank(), pathMode);
      await click(h, "pen", 20, 20);
      await click(h, "pen", 80, 26, { shift: true });
      expect(anchors(h)[1][1]).toBeCloseTo(20);
      await h.drag("pen", [50, 60], [90, 70], { shift: true });
      const k = h.s.doc.workPath!.subpaths[0].knots[2];
      const [dx, dy] = [Math.abs(k.out.x - k.anchor.x), Math.abs(k.out.y - k.anchor.y)];
      expect(Math.min(dx, dy) < 1e-9 || Math.abs(dx - dy) < 1e-9).toBe(true);
      expect(dx + dy).toBeGreaterThan(10);
    });

    it("Alt while dragging breaks the direction lines: the one behind stays", async () => {
      const h = harness(blank(), pathMode);
      await click(h, "pen", 20, 50);
      const pen = h.tools.byId.pen;
      pen.down!(h.ctx(), h.ev(60, 50));
      pen.move!(h.ctx(), h.ev(75, 50));
      pen.move!(h.ctx(), h.ev(60, 80, { alt: true }));
      pen.up!(h.ctx(), h.ev(60, 80, { alt: true }));
      const k = h.s.doc.workPath!.subpaths[0].knots[1];
      expect(k.in).toEqual(P(45, 50));
      expect(k.out).toEqual(P(60, 80));
    });

    it("clicking the first point closes the path; the next click starts another", async () => {
      const h = harness(blank(), pathMode);
      for (const [x, y] of [[20, 20], [80, 20], [80, 80]]) await click(h, "pen", x, y);
      await click(h, "pen", 20, 20);
      expect(h.s.doc.workPath!.subpaths[0].closed).toBe(true);
      expect(anchors(h)).toHaveLength(3);
      expect(h.s.paths.selected).toEqual([]);
      await click(h, "pen", 25, 70);
      expect(h.s.doc.workPath!.subpaths).toHaveLength(2);
    });

    it("dragging on the first point closes with a curve", async () => {
      const h = harness(blank(), pathMode);
      for (const [x, y] of [[20, 20], [80, 20], [80, 80]]) await click(h, "pen", x, y);
      await h.drag("pen", [20, 20], [10, 40]);
      const s = h.s.doc.workPath!.subpaths[0];
      expect(s.closed).toBe(true);
      expect(s.knots[0].out).toEqual(P(10, 40));
      expect(s.knots[0].in).toEqual(P(30, 0));
    });

    it("Escape ends the path; clicking its end then continues it", async () => {
      const h = harness(blank(), pathMode);
      await click(h, "pen", 20, 20);
      await click(h, "pen", 80, 20);
      h.tools.byId.pen.cancel!(h.ctx());
      expect(h.s.paths.selected).toEqual([]);
      // Without a selected end, a click elsewhere starts a new component.
      await click(h, "pen", 50, 70);
      expect(h.s.doc.workPath!.subpaths).toHaveLength(2);
      h.tools.byId.pen.cancel!(h.ctx());
      // Clicking an end selects it, and the next click extends that path.
      await click(h, "pen", 80, 20);
      expect(h.s.paths.selected).toEqual([{ sub: 0, knot: 1 }]);
      await click(h, "pen", 90, 60);
      expect(anchors(h, 0)).toEqual([[20, 20], [80, 20], [90, 60]]);
    });

    it("continuing from a path's start turns it round", async () => {
      const h = withWork({ subpaths: [{ closed: false, op: "combine", knots: [cornerKnot(P(20, 20)), cornerKnot(P(80, 20))] }] });
      await click(h, "pen", 20, 20);
      expect(h.s.paths.selected).toEqual([{ sub: 0, knot: 0 }]);
      await click(h, "pen", 10, 60);
      expect(anchors(h)).toEqual([[80, 20], [20, 20], [10, 60]]);
    });

    it("clicking the end of another open path joins them", async () => {
      const h = withWork({
        subpaths: [
          { closed: false, op: "combine", knots: [cornerKnot(P(10, 10)), cornerKnot(P(40, 10))] },
          { closed: false, op: "combine", knots: [cornerKnot(P(60, 60)), cornerKnot(P(90, 60))] },
        ],
      }, [{ sub: 0, knot: 1 }]);
      await click(h, "pen", 60, 60);
      expect(h.s.doc.workPath!.subpaths).toHaveLength(1);
      expect(anchors(h)).toEqual([[10, 10], [40, 10], [60, 60], [90, 60]]);
    });

    it("clicking the selected end drops its direction line; dragging from it pulls one out", async () => {
      const h = harness(blank(), pathMode);
      await click(h, "pen", 20, 50);
      await h.drag("pen", [60, 50], [80, 50]);
      await click(h, "pen", 60, 50);
      let k = h.s.doc.workPath!.subpaths[0].knots[1];
      expect(k.out).toEqual(k.anchor);
      expect(k.in).toEqual(P(40, 50));
      await h.drag("pen", [60, 50], [70, 70]);
      k = h.s.doc.workPath!.subpaths[0].knots[1];
      expect(k.out).toEqual(P(70, 70));
      expect(k.in).toEqual(P(40, 50));
    });

    it("Auto Add/Delete adds an anchor point on a segment and deletes one it's over", async () => {
      const h = withWork(square);
      await click(h, "pen", 50, 20);
      expect(anchors(h)).toEqual([[20, 20], [50, 20], [80, 20], [80, 80], [20, 80]]);
      await click(h, "pen", 80, 80);
      expect(anchors(h)).toEqual([[20, 20], [50, 20], [80, 20], [20, 80]]);
      expect(h.s.history).toEqual(["Add Anchor Point", "Delete Anchor Point"]);
    });

    it("places points on top of a path when Auto Add/Delete is off", async () => {
      const h = harness({ ...blank(), workPath: square }, { pen: { ...DEFAULT_SETTINGS.pen, mode: "path", autoAddDelete: false } });
      h.s.paths = { target: { kind: "work" }, selected: [] };
      await click(h, "pen", 50, 20);
      expect(h.s.doc.workPath!.subpaths).toHaveLength(2);
    });

    it("Ctrl is the Direct Selection tool, Alt the Convert Point tool", async () => {
      const h = withWork({ subpaths: [{ closed: false, op: "combine", knots: [cornerKnot(P(20, 20)), smoothKnot(P(50, 50), P(70, 50)), cornerKnot(P(80, 80))] }] }, [{ sub: 0, knot: 2 }]);
      await h.drag("pen", [20, 20], [30, 25], { mod: true });
      expect(anchors(h)[0]).toEqual([30, 25]);
      await click(h, "pen", 50, 50, { alt: true });
      expect(h.s.doc.workPath!.subpaths[0].knots[1].out).toEqual(P(50, 50));
      expect(h.s.history).toEqual(["Move Anchor Points", "Convert Point"]);
    });

    it("Shape mode: the first click makes a shape layer, later clicks edit its path", async () => {
      const h = harness(blank());
      const before = h.s.doc.layers.length;
      await click(h, "pen", 20, 20);
      expect(h.s.doc.layers).toHaveLength(before + 1);
      await click(h, "pen", 80, 20);
      await click(h, "pen", 50, 80);
      await click(h, "pen", 20, 20);
      const layer = layerOf(h.s.doc);
      expect(layer.content.kind).toBe("shape");
      expect(h.s.doc.layers).toHaveLength(before + 1);
      expect(getPixel(layer.pixels, 50, 40)[3]).toBe(255);
      expect(getPixel(layer.pixels, 5, 90)[3]).toBe(0);
      expect(h.s.history).toEqual(Array(4).fill("Pen Tool"));
      // The path is closed: the next click is another shape.
      await click(h, "pen", 10, 90);
      expect(h.s.doc.layers).toHaveLength(before + 2);
    });

    it("Shape mode: ending a path that is a lone point leaves no layer", async () => {
      const h = harness(blank());
      const before = h.s.doc.layers.length;
      await click(h, "pen", 20, 20);
      h.tools.byId.pen.cancel!(h.ctx());
      expect(h.s.doc.layers).toHaveLength(before);
    });

    it("Shape mode: with a shape-area operation chosen, new components go into the active shape layer", async () => {
      const h = harness(blank());
      for (const [x, y] of [[10, 10], [90, 10], [90, 90], [10, 90], [10, 10]]) await click(h, "pen", x, y);
      const layers = h.s.doc.layers.length;
      h.s.settings.pen.op = "subtract";
      for (const [x, y] of [[30, 30], [70, 30], [70, 70], [30, 70], [30, 30]]) await click(h, "pen", x, y);
      expect(h.s.doc.layers).toHaveLength(layers);
      const layer = layerOf(h.s.doc);
      expect(layer.content.kind === "shape" && layer.content.geometry.kind === "path" && layer.content.geometry.ops).toEqual(["combine", "subtract"]);
      expect(getPixel(layer.pixels, 20, 50)[3]).toBe(255);
      expect(getPixel(layer.pixels, 50, 50)[3]).toBe(0);
    });
  });

  describe("Direct Selection", () => {
    it("clicking an anchor point selects it; Shift adds; clicking away deselects", async () => {
      const h = withWork(square);
      await click(h, "direct-select", 80, 20);
      expect(h.s.paths.selected).toEqual([{ sub: 0, knot: 1 }]);
      await click(h, "direct-select", 80, 80, { shift: true });
      expect(h.s.paths.selected).toEqual([{ sub: 0, knot: 1 }, { sub: 0, knot: 2 }]);
      await click(h, "direct-select", 50, 50);
      expect(h.s.paths.selected).toEqual([]);
      expect(h.s.history).toEqual([]);
    });

    it("dragging moves the selected points together; Shift holds 45°", async () => {
      const h = withWork(square, [{ sub: 0, knot: 1 }, { sub: 0, knot: 2 }]);
      await h.drag("direct-select", [80, 20], [90, 30]);
      expect(anchors(h)).toEqual([[20, 20], [90, 30], [90, 90], [20, 80]]);
      await h.drag("direct-select", [90, 30], [100, 31], { shift: true });
      expect(anchors(h)[1]).toEqual([100, 30]);
      expect(h.s.history).toEqual(["Move Anchor Points", "Move Anchor Points"]);
    });

    it("a marquee selects the anchor points inside it", async () => {
      const h = withWork(square);
      await h.drag("direct-select", [5, 5], [95, 50]);
      expect(h.s.paths.selected).toEqual([{ sub: 0, knot: 0 }, { sub: 0, knot: 1 }]);
    });

    it("dragging a straight segment moves its two points; a curved one bends", async () => {
      const h = withWork(square);
      await h.drag("direct-select", [50, 20], [50, 10]);
      expect(anchors(h)).toEqual([[20, 10], [80, 10], [80, 80], [20, 80]]);
      expect(h.s.paths.selected).toEqual([{ sub: 0, knot: 0 }, { sub: 0, knot: 1 }]);
      const c = withWork({ subpaths: [{ closed: false, op: "combine", knots: [{ ...cornerKnot(P(20, 50)), out: P(20, 20) }, { ...cornerKnot(P(80, 50)), in: P(80, 20) }] }] });
      await c.drag("direct-select", [50, 27.5], [50, 7.5]);
      const bent = c.s.doc.workPath!.subpaths[0].knots;
      expect(bent[0].anchor).toEqual(P(20, 50));
      expect(bent[0].out.y).toBeLessThan(20);
      expect(bent[1].in.y).toBeLessThan(20);
    });

    it("dragging a direction point moves it; the other side of a smooth point turns to stay in line", async () => {
      const h = withWork({ subpaths: [{ closed: false, op: "combine", knots: [cornerKnot(P(10, 50)), smoothKnot(P(50, 50), P(70, 50)), cornerKnot(P(90, 50))] }] }, [{ sub: 0, knot: 1 }]);
      await h.drag("direct-select", [70, 50], [50, 80]);
      const k = h.s.doc.workPath!.subpaths[0].knots[1];
      expect(k.out).toEqual(P(50, 80));
      // The other side keeps its length (20), now pointing opposite.
      expect(k.in.x).toBeCloseTo(50);
      expect(k.in.y).toBeCloseTo(30);
      expect(h.s.history).toEqual(["Move Direction Point"]);
    });

    it("Delete removes the selected points and the segments touching them; the arrow keys nudge", async () => {
      const h = withWork(square, [{ sub: 0, knot: 1 }]);
      const t = h.tools.byId["direct-select"];
      expect(t.keyDown!(h.ctx(), { key: "ArrowRight", shift: true, alt: false, mod: false })).toBe(true);
      expect(anchors(h)[1]).toEqual([90, 20]);
      expect(t.keyDown!(h.ctx(), { key: "ArrowDown", shift: false, alt: false, mod: false })).toBe(true);
      expect(anchors(h)[1]).toEqual([90, 21]);
      expect(t.keyDown!(h.ctx(), { key: "Delete", shift: false, alt: false, mod: false })).toBe(true);
      const s = h.s.doc.workPath!.subpaths;
      expect(s).toHaveLength(1);
      expect(s[0].closed).toBe(false);
      expect(s[0].knots.map((k) => [k.anchor.x, k.anchor.y])).toEqual([[80, 80], [20, 80], [20, 20]]);
      expect(h.s.paths.selected).toEqual([]);
    });

    it("keys do nothing with no anchor points selected", () => {
      const h = withWork(square);
      expect(h.tools.byId["direct-select"].keyDown!(h.ctx(), { key: "Delete", shift: false, alt: false, mod: false })).toBe(false);
    });
  });

  describe("Path Selection", () => {
    const two: VectorPath = {
      subpaths: [
        square.subpaths[0],
        { closed: true, op: "combine", knots: [cornerKnot(P(100, 100)), cornerKnot(P(140, 100)), cornerKnot(P(140, 140))] },
      ],
    };
    it("clicking inside a component selects all of it", async () => {
      const h = withWork(two);
      await click(h, "path-select", 50, 50);
      expect(h.s.paths.selected).toHaveLength(4);
      await click(h, "path-select", 130, 110, { shift: true });
      expect(h.s.paths.selected).toHaveLength(7);
      await click(h, "path-select", 200, 200);
      expect(h.s.paths.selected).toEqual([]);
    });

    it("dragging moves the component; Alt-drag copies it", async () => {
      const h = withWork(two);
      await h.drag("path-select", [50, 50], [60, 70]);
      expect(anchors(h, 0)[0]).toEqual([30, 40]);
      expect(anchors(h, 1)[0]).toEqual([100, 100]);
      await h.drag("path-select", [50, 70], [50, 100], { alt: true });
      expect(h.s.doc.workPath!.subpaths).toHaveLength(3);
      expect(anchors(h, 0)[0]).toEqual([30, 40]);
      expect(anchors(h, 2)[0]).toEqual([30, 70]);
      expect(h.s.history).toEqual(["Move Path Components", "Duplicate Path Component"]);
    });

    it("a marquee selects the components it touches; Delete removes them", async () => {
      const h = withWork(two);
      await h.drag("path-select", [90, 90], [150, 150]);
      expect(h.s.paths.selected).toHaveLength(3);
      h.tools.byId["path-select"].keyDown!(h.ctx(), { key: "Delete", shift: false, alt: false, mod: false });
      expect(h.s.doc.workPath!.subpaths).toHaveLength(1);
    });
  });

  describe("Convert Point, Add Anchor Point and Delete Anchor Point", () => {
    const curve: VectorPath = { subpaths: [{ closed: false, op: "combine", knots: [cornerKnot(P(10, 50)), smoothKnot(P(50, 50), P(70, 50)), cornerKnot(P(90, 50))] }] };
    it("Convert Point: a click makes a smooth point a corner; a drag makes a corner smooth", async () => {
      const h = withWork(curve);
      await click(h, "convert-point", 50, 50);
      const k = h.s.doc.workPath!.subpaths[0].knots[1];
      expect([k.in, k.out]).toEqual([P(50, 50), P(50, 50)]);
      await h.drag("convert-point", [50, 50], [60, 70]);
      const s = h.s.doc.workPath!.subpaths[0].knots[1];
      expect(s.out).toEqual(P(60, 70));
      expect(s.in).toEqual(P(40, 30));
      expect(h.s.history).toEqual(["Convert Point", "Convert Point"]);
    });

    it("Convert Point: dragging a direction point moves it alone", async () => {
      const h = withWork(curve, [{ sub: 0, knot: 1 }]);
      await h.drag("convert-point", [70, 50], [60, 80]);
      const k = h.s.doc.workPath!.subpaths[0].knots[1];
      expect(k.out).toEqual(P(60, 80));
      expect(k.in).toEqual(P(30, 50));
    });

    it("Add Anchor Point adds a point where a segment is clicked, keeping its shape", async () => {
      const h = withWork(square);
      await click(h, "add-anchor", 50, 80);
      expect(anchors(h)).toEqual([[20, 20], [80, 20], [80, 80], [50, 80], [20, 80]]);
      expect(h.s.paths.selected).toEqual([{ sub: 0, knot: 3 }]);
    });

    it("Delete Anchor Point removes the point clicked and joins its neighbours", async () => {
      const h = withWork(square);
      await click(h, "delete-anchor", 80, 80);
      expect(anchors(h)).toEqual([[20, 20], [80, 20], [20, 80]]);
      expect(h.s.doc.workPath!.subpaths[0].closed).toBe(true);
      expect(h.s.history).toEqual(["Delete Anchor Point"]);
    });
  });

  describe("Freeform Pen", () => {
    /** Draws through the points with the tool, as a pointer would. */
    const stroke = async (h: ReturnType<typeof harness>, pts: [number, number][], mods: Partial<ToolEvent> = {}) => {
      const t = h.tools.byId["freeform-pen"];
      t.down!(h.ctx(), h.ev(...pts[0], mods));
      for (const p of pts.slice(1)) t.move!(h.ctx(), h.ev(...p, mods));
      t.up!(h.ctx(), h.ev(...pts[pts.length - 1], mods));
      await h.s.pending;
    };
    const arc = (cx: number, cy: number, r: number, from: number, to: number, n = 60): [number, number][] =>
      Array.from({ length: n + 1 }, (_, i) => {
        const a = from + ((to - from) * i) / n;
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      });

    it("follows the pointer with few anchor points, as one history step", async () => {
      const h = harness(blank(), pathMode);
      await stroke(h, arc(50, 50, 30, 0, Math.PI));
      const s = h.s.doc.workPath!.subpaths[0];
      expect(s.closed).toBe(false);
      expect(s.knots.length).toBeGreaterThanOrEqual(2);
      expect(s.knots.length).toBeLessThan(8);
      expect(s.knots[0].anchor).toEqual(P(80, 50));
      expect(h.s.history).toEqual(["Freeform Pen Tool"]);
    });

    it("a higher Curve Fit uses fewer anchor points", async () => {
      const wobbly: [number, number][] = Array.from({ length: 100 }, (_, i) => [i, 50 + 8 * Math.sin(i / 6) + (i % 2)]);
      const fine = harness(blank(), { pen: { ...DEFAULT_SETTINGS.pen, mode: "path", curveFit: 0.5 } });
      const coarse = harness(blank(), { pen: { ...DEFAULT_SETTINGS.pen, mode: "path", curveFit: 10 } });
      await stroke(fine, wobbly);
      await stroke(coarse, wobbly);
      expect(coarse.s.doc.workPath!.subpaths[0].knots.length).toBeLessThan(fine.s.doc.workPath!.subpaths[0].knots.length);
    });

    it("dragging back to where it began closes the path", async () => {
      const h = harness(blank(), pathMode);
      await stroke(h, arc(50, 50, 30, 0, Math.PI * 2, 120));
      const s = h.s.doc.workPath!.subpaths[0];
      expect(s.closed).toBe(true);
      expect(h.s.paths.selected).toEqual([]);
    });

    it("dragging from the end of an open path continues it", async () => {
      const h = harness(blank(), pathMode);
      await stroke(h, [[10, 10], [30, 12], [50, 10], [70, 12], [90, 10]]);
      h.tools.byId["freeform-pen"].cancel!(h.ctx());
      await stroke(h, [[90, 10], [92, 40], [90, 70]]);
      expect(h.s.doc.workPath!.subpaths).toHaveLength(1);
      const knots = h.s.doc.workPath!.subpaths[0].knots;
      expect(knots[0].anchor).toEqual(P(10, 10));
      expect(knots[knots.length - 1].anchor).toEqual(P(90, 70));
    });

    it("Shape mode makes a shape layer; a click without dragging makes nothing", async () => {
      const h = harness(blank());
      const layers = h.s.doc.layers.length;
      await stroke(h, [[20, 20]]);
      expect(h.s.doc.layers).toHaveLength(layers);
      expect(h.s.history).toEqual([]);
      await stroke(h, arc(50, 50, 30, 0, Math.PI * 2, 120));
      expect(h.s.doc.layers).toHaveLength(layers + 1);
      expect(getPixel(layerOf(h.s.doc).pixels, 50, 50)[3]).toBe(255);
    });
  });

  describe("Curvature Pen", () => {
    const knots = (h: ReturnType<typeof harness>) => h.s.doc.workPath!.subpaths[0].knots;
    it("clicks make automatic smooth points that a curve passes through", async () => {
      const h = harness(blank(), pathMode);
      for (const [x, y] of [[10, 80], [50, 20], [90, 80]]) await click(h, "curvature-pen", x, y);
      expect(knots(h).map((k) => k.anchor)).toEqual([P(10, 80), P(50, 20), P(90, 80)]);
      expect(knots(h).every((k) => k.auto && k.smooth)).toBe(true);
      // The middle point's lines run along the line between its neighbours (horizontal), a third as long as each segment.
      const m = knots(h)[1];
      expect(m.in.y).toBeCloseTo(20);
      expect(m.out.y).toBeCloseTo(20);
      expect(m.out.x - 50).toBeCloseTo(Math.hypot(40, 60) / 3);
      // The ends have the one line, straight at the neighbour.
      expect(knots(h)[0].in).toEqual(P(10, 80));
      expect(h.s.history).toEqual(Array(3).fill("Curvature Pen Tool"));
    });

    it("double-clicking a point makes it a corner, and again smooth", async () => {
      const h = harness(blank(), pathMode);
      for (const [x, y] of [[10, 80], [50, 20], [90, 80]]) await click(h, "curvature-pen", x, y);
      const t = h.tools.byId["curvature-pen"];
      t.down!(h.ctx(), h.ev(50, 20, { clicks: 2 }));
      t.up!(h.ctx(), h.ev(50, 20, { clicks: 2 }));
      expect(knots(h)[1].in).toEqual(P(50, 20));
      expect(knots(h)[1].auto).toBeFalsy();
      t.down!(h.ctx(), h.ev(50, 20, { clicks: 2 }));
      t.up!(h.ctx(), h.ev(50, 20, { clicks: 2 }));
      expect(knots(h)[1].auto).toBe(true);
    });

    it("dragging a point moves it and the curve follows", async () => {
      const h = harness(blank(), pathMode);
      for (const [x, y] of [[10, 80], [50, 20], [90, 80]]) await click(h, "curvature-pen", x, y);
      await h.drag("curvature-pen", [50, 20], [50, 40]);
      expect(knots(h)[1].anchor).toEqual(P(50, 40));
      expect(knots(h)[1].out.y).toBeCloseTo(40);
    });

    it("a click on a segment adds a point there", async () => {
      const h = harness(blank(), pathMode);
      for (const [x, y] of [[10, 80], [90, 80]]) await click(h, "curvature-pen", x, y);
      h.tools.byId["curvature-pen"].cancel!(h.ctx());
      await click(h, "curvature-pen", 50, 80);
      expect(knots(h)).toHaveLength(3);
      expect(knots(h)[1].anchor.x).toBeCloseTo(50);
    });

    it("Delete removes the point and the curve re-forms around the rest", async () => {
      const h = harness(blank(), pathMode);
      for (const [x, y] of [[10, 80], [50, 20], [90, 80], [130, 20]]) await click(h, "curvature-pen", x, y);
      h.s.paths = { ...h.s.paths, selected: [{ sub: 0, knot: 1 }] };
      expect(h.tools.byId["curvature-pen"].keyDown!(h.ctx(), { key: "Delete", shift: false, alt: false, mod: false })).toBe(true);
      expect(knots(h).map((k) => k.anchor)).toEqual([P(10, 80), P(90, 80), P(130, 20)]);
      // The middle point's lines now follow its new neighbours.
      expect(knots(h)[1].in.y).toBeGreaterThan(20);
    });

    it("clicking the first point closes the path", async () => {
      const h = harness(blank(), pathMode);
      for (const [x, y] of [[10, 80], [50, 20], [90, 80], [10, 80]]) await click(h, "curvature-pen", x, y);
      expect(h.s.doc.workPath!.subpaths[0].closed).toBe(true);
      expect(knots(h)).toHaveLength(3);
    });
  });

  describe("Magnetic Pen", () => {
    const squareDoc = () => {
      const d = blank();
      return updateLayer(d, d.activeLayerId, { pixels: fillPixels(NO_PIXELS, rect(20, 20, 50, 50), { r: 0, g: 0, b: 0 }) });
    };
    const magnetic = { pen: { ...DEFAULT_SETTINGS.pen, mode: "path" as const, magnetic: true, magneticWidth: 12 } };
    const press = (h: ReturnType<typeof harness>, x: number, y: number, mods: Partial<ToolEvent> = {}) => h.tools.byId["freeform-pen"].down!(h.ctx(), h.ev(x, y, mods));
    const hover = (h: ReturnType<typeof harness>, x: number, y: number) => h.tools.byId["freeform-pen"].hover!(h.ctx(), h.ev(x, y));

    it("snaps to the edges of the image between clicks and closes along them", async () => {
      const h = harness(squareDoc(), magnetic);
      press(h, 20, 20);
      hover(h, 45, 26);
      expect(h.s.preview).not.toBeNull();
      press(h, 70, 20);
      hover(h, 74, 45);
      press(h, 70, 70);
      hover(h, 45, 74);
      press(h, 20, 70);
      hover(h, 24, 40);
      press(h, 21, 22, { clicks: 2 });
      await h.s.pending;
      expect(h.s.history).toEqual(["Magnetic Pen Tool"]);
      const s = h.s.doc.workPath!.subpaths[0];
      expect(s.closed).toBe(true);
      // The path runs along the square's edge, though the pointer was off it.
      const poly = flattenKnots(s.knots, true);
      for (const p of poly) {
        const d = Math.min(Math.abs(p.x - 20), Math.abs(p.x - 70), Math.abs(p.y - 20), Math.abs(p.y - 70));
        expect(d).toBeLessThan(1.6);
      }
    });

    it("Delete removes the last fastening point; Escape cancels; Enter ends an open path", async () => {
      const h = harness(squareDoc(), magnetic);
      const t = h.tools.byId["freeform-pen"];
      const key = (k: string) => t.keyDown!(h.ctx(), { key: k, shift: false, alt: false, mod: false });
      press(h, 20, 20);
      hover(h, 70, 20);
      press(h, 70, 20);
      hover(h, 70, 70);
      press(h, 70, 70);
      expect(key("Backspace")).toBe(true);
      hover(h, 70, 40);
      expect(key("Enter")).toBe(true);
      await h.s.pending;
      const s = h.s.doc.workPath!.subpaths[0];
      expect(s.closed).toBe(false);
      const last = s.knots[s.knots.length - 1].anchor;
      expect(last.x).toBeCloseTo(70, 0);
      expect(last.y).toBeCloseTo(40, 0);
      // Escape drops a path in progress.
      press(h, 20, 20);
      hover(h, 50, 20);
      t.cancel!(h.ctx());
      expect(h.s.preview).toBeNull();
      expect(key("Enter")).toBe(false);
      expect(h.s.history).toHaveLength(1);
    });

    it("[ and ] change the width", () => {
      const h = harness(squareDoc(), magnetic);
      const t = h.tools.byId["freeform-pen"];
      press(h, 20, 20);
      t.keyDown!(h.ctx(), { key: "]", shift: false, alt: false, mod: false });
      expect(h.s.settings.pen.magneticWidth).toBe(13);
      t.keyDown!(h.ctx(), { key: "[", shift: false, alt: false, mod: false });
      t.keyDown!(h.ctx(), { key: "[", shift: false, alt: false, mod: false });
      expect(h.s.settings.pen.magneticWidth).toBe(11);
    });
  });
});
