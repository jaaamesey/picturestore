import { describe, expect, it } from "vitest";
import { DEFAULT_BRUSH } from "../../core/brush";
import { addLayer, createDocument, fillTiles, updateLayer, type Doc } from "../../core/document";
import { rect } from "../../core/geometry";
import { rectMask } from "../../core/selection";
import { transformFloatingCpu } from "../../core/raster";
import { EMPTY_TILES, contentBounds, getPixel } from "../../core/tiles";
import type { FloatingLayer } from "../../gpu/renderer";
import type { Overlay, ToolContext, ToolEvent, ToolId, ToolSettings } from "../types";
import { createTools } from "./index";

const settings: ToolSettings = {
  transform: { showControls: true, link: true, showReference: false, interpolation: "bicubic" },
  brush: { ...DEFAULT_BRUSH, size: 10, hardness: 1, pressureSize: false },
  eraser: { ...DEFAULT_BRUSH, size: 10, hardness: 1, pressureSize: false },
  selectionMode: "replace",
  tolerance: 32,
  contiguous: true,
};

/** A minimal in-memory editor: the same contract the real one implements with signals. */
function harness(doc: Doc) {
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
  };
  const ctx = (): ToolContext => ({
    doc: s.doc,
    view: s.view,
    settings,
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
    resample: async (f, mapping, filter) => transformFloatingCpu(f, mapping, filter),
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
