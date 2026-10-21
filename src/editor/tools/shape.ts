import { addLayer, activeLayer, createLayer, docRect, fillTiles, numberedName, updateLayer, type Doc, type Placement } from "../../core/document";
import { rect, vec, type Rect, type Vec2 } from "../../core/geometry";
import { combine, toMask } from "../../core/selection";
import { fillCoverage, renderShape, type ShapeGeometry, type ShapeStyle } from "../../core/shape";
import { placementMapping } from "../../core/content";
import { quadOf, type Quad } from "../../core/warp";
import type { ShapeSettings, ShapeToolId, Tool, ToolContext, ToolEvent } from "../types";
import { marqueeRect } from "./select";

const NAMES: Record<ShapeToolId, string> = {
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  triangle: "Triangle",
  polygon: "Polygon",
  line: "Line",
};

export function shapeGeometry(tool: ShapeToolId, s: ShapeSettings): ShapeGeometry {
  switch (tool) {
    case "rectangle":
      return { kind: "rectangle", radius: s.radius };
    case "polygon":
      return { kind: "polygon", sides: s.sides, starRatio: s.starRatio };
    default:
      return { kind: tool };
  }
}

export function shapeStyle(s: ShapeSettings, foreground: ShapeStyle["fill"]): ShapeStyle {
  return { fill: s.fill === "foreground" ? foreground : s.fill, stroke: s.stroke };
}

const boxPlacement = (r: Rect, quad: Quad = quadOf(r), angle = 0): Placement => ({
  source: rect(0, 0, r.w, r.h),
  quad,
  angle,
  patch: null,
});

/**
 * A line from `a` to `b` as a placement: a `length × weight` box rotated onto
 * the segment. Shift snaps the angle to 45° steps.
 */
export function linePlacement(a: Vec2, b: Vec2, weight: number, snap: boolean): Placement | null {
  let angle = Math.atan2(b.y - a.y, b.x - a.x);
  if (snap) angle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
  const length = snap ? Math.abs((b.x - a.x) * Math.cos(angle) + (b.y - a.y) * Math.sin(angle)) : Math.hypot(b.x - a.x, b.y - a.y);
  if (length < 1) return null;
  const d = vec(Math.cos(angle), Math.sin(angle));
  const n = vec((-d.y * weight) / 2, (d.x * weight) / 2);
  const end = vec(a.x + d.x * length, a.y + d.y * length);
  const quad: Quad = [vec(a.x - n.x, a.y - n.y), vec(end.x - n.x, end.y - n.y), vec(end.x + n.x, end.y + n.y), vec(a.x + n.x, a.y + n.y)];
  return boxPlacement(rect(0, 0, length, weight), quad, angle);
}

/**
 * The shape tools (Rectangle, Ellipse, Triangle, Polygon, Line). Dragging
 * draws from corner to corner; Shift (pressed after starting) constrains
 * proportions — squares, circles, equilateral shapes, 45° lines — and Alt
 * draws from the centre. In Shape mode each shape is a new live shape layer;
 * in Pixels mode it's filled into the active layer with the foreground colour.
 */
export function createShapeTool(id: ShapeToolId): Tool {
  let start: Vec2 | null = null;
  let downMods = { shift: false, alt: false };
  let placement: Placement | null = null;

  const placementFor = (ctx: ToolContext, e: ToolEvent): Placement | null => {
    if (!start) return null;
    if (id === "line") return linePlacement(start, e, ctx.settings.shape.weight, e.shift);
    const r = marqueeRect(start, e, e.shift && !downMods.shift, e.alt && !downMods.alt);
    return r.w >= 1 && r.h >= 1 ? boxPlacement(r) : null;
  };

  /** The document with the shape drawn, as a new shape layer or into the active layer's pixels. */
  const draw = (ctx: ToolContext, p: Placement): Doc | null => {
    const { doc, settings } = ctx;
    const geometry = shapeGeometry(id, settings.shape);
    if (settings.shape.mode === "pixels") {
      const layer = activeLayer(doc);
      if (!layer) return null;
      const cov = fillCoverage(geometry, placementMapping(p), docRect(doc));
      const mask = cov && combine(doc.selection, toMask(cov.data, cov.region, doc.width, doc.height), doc.selection ? "intersect" : "replace");
      return mask ? updateLayer(doc, layer.id, { tiles: fillTiles(layer.tiles, mask.bounds, ctx.foreground, mask) }) : doc;
    }
    const style = shapeStyle(settings.shape, ctx.foreground);
    const tiles = renderShape(geometry, style, placementMapping(p), docRect(doc));
    return addLayer(doc, createLayer({ name: numberedName(doc, NAMES[id]), tiles, content: { kind: "shape", geometry, style, placement: p } }));
  };

  return {
    id,
    latestMoveOnly: true,
    cursor: () => "crosshair",
    down(ctx, e) {
      if (ctx.settings.shape.mode === "pixels") {
        const layer = activeLayer(ctx.doc);
        if (!layer || !layer.visible || !ctx.requireEditable(layer)) return;
      }
      start = vec(e.x, e.y);
      downMods = { shift: e.shift, alt: e.alt };
      placement = null;
    },
    move(ctx, e) {
      if (!start) return;
      placement = placementFor(ctx, e);
      ctx.preview(placement && draw(ctx, placement));
    },
    up(ctx, e) {
      if (!start) return;
      placement = placementFor(ctx, e);
      start = null;
      const doc = placement && draw(ctx, placement);
      if (doc && doc !== ctx.doc) ctx.commit(`${NAMES[id]} Tool`, doc);
      else ctx.preview(null);
    },
    cancel(ctx) {
      if (!start) return;
      start = null;
      ctx.preview(null);
    },
  };
}
