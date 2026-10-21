import { activeLayer } from "../../core/document";
import { distance, rect, rectFromPoints, vec, type Rect, type Vec2 } from "../../core/geometry";
import {
  combine,
  ellipseMask,
  magicWand,
  modeFromModifiers,
  polygonMask,
  rectMask,
  type SelectionMode,
} from "../../core/selection";
import type { Tool, ToolContext, ToolEvent } from "../types";

const LABELS = { rect: "Rectangular Marquee", ellipse: "Elliptical Marquee" } as const;

/** Shift (pressed after starting) constrains to a square/circle; Alt (pressed after starting) draws from the centre. */
export function marqueeRect(start: Vec2, p: Vec2, square: boolean, fromCenter: boolean): Rect {
  let dx = p.x - start.x;
  let dy = p.y - start.y;
  if (square) {
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * s;
    dy = Math.sign(dy || 1) * s;
  }
  if (fromCenter) return rect(start.x - Math.abs(dx), start.y - Math.abs(dy), Math.abs(dx) * 2, Math.abs(dy) * 2);
  return rectFromPoints(start, vec(start.x + dx, start.y + dy));
}

function applySelection(ctx: ToolContext, label: string, mode: SelectionMode, shape: ReturnType<typeof rectMask>) {
  ctx.overlay(null);
  const selection = combine(ctx.doc.selection, shape, mode);
  if (selection === ctx.doc.selection) return;
  ctx.commit(selection ? label : "Deselect", { ...ctx.doc, selection });
}

export function createMarqueeTool(shape: "rect" | "ellipse"): Tool {
  let start: Vec2 | null = null;
  let mode: SelectionMode = "replace";
  let downMods = { shift: false, alt: false };
  let current: Rect = rect(0, 0, 0, 0);
  /** Where a corner lands: snapped, and on whole pixels for rectangles. */
  const corner = (ctx: ToolContext, e: ToolEvent) => {
    const p = ctx.snap.point(vec(e.x, e.y));
    return shape === "rect" ? vec(Math.round(p.x), Math.round(p.y)) : p;
  };

  const update = (ctx: ToolContext, e: ToolEvent) => {
    if (!start) return;
    // Modifiers held from the start pick the mode; pressed later they constrain.
    const p = corner(ctx, e);
    current = marqueeRect(start, p, e.shift && !downMods.shift, e.alt && !downMods.alt);
    ctx.overlay({ kind: "marquee", shape, rect: current });
  };

  return {
    id: shape === "rect" ? "marquee-rect" : "marquee-ellipse",
    cursor: () => "crosshair",
    down(ctx, e) {
      start = corner(ctx, e);
      downMods = { shift: e.shift, alt: e.alt };
      mode = modeFromModifiers(ctx.settings.selectionMode, e.shift, e.alt);
      current = rect(start.x, start.y, 0, 0);
    },
    move: update,
    up(ctx, e) {
      if (!start) return;
      update(ctx, e);
      start = null;
      const { width, height } = ctx.doc;
      if (current.w < 1 || current.h < 1) {
        // A click without a drag deselects (in replace mode).
        ctx.overlay(null);
        if (mode === "replace" && ctx.doc.selection) ctx.commit("Deselect", { ...ctx.doc, selection: null });
        return;
      }
      const mask = shape === "rect" ? rectMask(width, height, current) : ellipseMask(width, height, current);
      applySelection(ctx, LABELS[shape], mode, mask);
    },
    cancel(ctx) {
      start = null;
      ctx.overlay(null);
    },
  };
}

export function createLassoTool(): Tool {
  let points: Vec2[] | null = null;
  let mode: SelectionMode = "replace";
  return {
    id: "lasso",
    cursor: () => "crosshair",
    down(ctx, e) {
      points = [vec(e.x, e.y)];
      mode = modeFromModifiers(ctx.settings.selectionMode, e.shift, e.alt);
    },
    move(ctx, e) {
      if (!points) return;
      const p = vec(e.x, e.y);
      if (distance(points[points.length - 1], p) * ctx.view.zoom < 1) return;
      points.push(p);
      ctx.overlay({ kind: "lasso", points: [...points] });
    },
    up(ctx) {
      if (!points) return;
      const pts = points;
      points = null;
      if (pts.length < 3) {
        ctx.overlay(null);
        if (mode === "replace" && ctx.doc.selection) ctx.commit("Deselect", { ...ctx.doc, selection: null });
        return;
      }
      applySelection(ctx, "Lasso", mode, polygonMask(ctx.doc.width, ctx.doc.height, pts));
    },
    cancel(ctx) {
      points = null;
      ctx.overlay(null);
    },
  };
}

export const wandTool: Tool = {
  id: "wand",
  cursor: () => "crosshair",
  down(ctx, e) {
    const { doc, settings } = ctx;
    const layer = activeLayer(doc);
    if (!layer) return;
    const mode = modeFromModifiers(settings.selectionMode, e.shift, e.alt);
    const shape = magicWand(layer.pixels, doc.width, doc.height, e, settings.tolerance, settings.contiguous);
    applySelection(ctx, "Magic Wand", mode, shape);
  },
};
