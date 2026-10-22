import { placementMapping, pathShape } from "../../core/content";
import { activeLayer, addLayer, createLayer, docRect, layerById, newId, numberedName, removeLayer, updateLayer, type Doc, type Layer } from "../../core/document";
import type { Vec2 } from "../../core/geometry";
import type { Knot } from "../../core/bezier";
import { EMPTY_PATH, reverseKnots, type PathOp, type PointRef, type VectorPath } from "../../core/path";
import { documentPath, type ShapeStyle } from "../../core/shape";
import type { PathState, PathTarget, ToolContext } from "../types";
import { shapeStyle } from "./shape";

/**
 * What the path tools share: finding the path they edit (the work path, a
 * saved path, or the active shape layer's path), writing an edited path
 * back, and recording it.
 */

type ShapeContent = Extract<Layer["content"], { kind: "shape" }>;

const shapeLayer = (doc: Doc, id: string): (Layer & { content: ShapeContent }) | null => {
  const l = layerById(doc, id);
  return l && l.content.kind === "shape" ? (l as Layer & { content: ShapeContent }) : null;
};

/** A layer whose path can be edited: a shape layer's, or the vector mask of any other. */
const pathLayer = (doc: Doc, id: string): Layer | null => {
  const l = layerById(doc, id);
  return l && (l.content.kind === "shape" || l.vectorMask) ? l : null;
};

/** Whether the target is a shape layer's path (as opposed to a vector mask, the work path or a saved path). */
export const isShapeTarget = (doc: Doc, t: PathTarget) => t.kind === "layer" && layerById(doc, t.layerId)?.content.kind === "shape";

/** A target that still exists: a work path needs the document to have one; a layer's path, that layer to be the active one. */
export function validTarget(doc: Doc, t: PathTarget | null): PathTarget | null {
  if (!t) return null;
  if (t.kind === "work") return doc.workPath ? t : null;
  if (t.kind === "saved") return doc.paths?.some((p) => p.id === t.id) ? t : null;
  return doc.activeLayerId === t.layerId && pathLayer(doc, t.layerId) ? t : null;
}

/**
 * The path the path tools edit: the Paths panel's selection if there is
 * one, else the active shape layer's path (the vector mask), as Photoshop
 * offers it to the selection tools.
 */
export function effectiveTarget(doc: Doc, st: PathState): PathTarget | null {
  const t = validTarget(doc, st.target);
  if (t) return t;
  const l = activeLayer(doc);
  return l && (l.content.kind === "shape" || l.vectorMask) ? { kind: "layer", layerId: l.id } : null;
}

/** The target's path, in document space. */
export function pathOf(doc: Doc, t: PathTarget): VectorPath | null {
  switch (t.kind) {
    case "work":
      return doc.workPath ?? null;
    case "saved":
      return doc.paths?.find((p) => p.id === t.id)?.path ?? null;
    case "layer": {
      const l = pathLayer(doc, t.layerId);
      if (!l) return null;
      return l.content.kind === "shape" ? documentPath(l.content.geometry, placementMapping(l.content.placement)) : (l.vectorMask?.path ?? null);
    }
  }
}

/** The document with the target's path replaced (a shape layer's pixels are redrawn by `commitPath`, or live from its vector until then). */
export function withPath(doc: Doc, t: PathTarget, path: VectorPath): Doc {
  switch (t.kind) {
    case "work":
      return { ...doc, workPath: path.subpaths.length ? path : null };
    case "saved":
      return { ...doc, paths: doc.paths?.map((p) => (p.id === t.id ? { ...p, path } : p)) };
    case "layer": {
      const l = shapeLayer(doc, t.layerId);
      if (!l) {
        const v = layerById(doc, t.layerId);
        return v?.vectorMask ? updateLayer(doc, v.id, { vectorMask: { ...v.vectorMask, path } }) : doc;
      }
      const content = pathShape(path, l.content.style);
      // An empty path leaves the layer as it is, drawing nothing.
      return updateLayer(doc, l.id, { content: content ?? { ...l.content, geometry: { kind: "path", contours: [] } } });
    }
  }
}

/** Anchor point references that still point at points of `path`. */
export const validRefs = (path: VectorPath, refs: readonly PointRef[]): PointRef[] =>
  refs.filter((r) => r.sub < path.subpaths.length && r.knot < path.subpaths[r.sub].knots.length);

/** A new shape layer holding `path`, with the Pen tools' fill and stroke. */
export function newShapeLayer(ctx: ToolContext, path: VectorPath): { doc: Doc; layerId: string } | null {
  const style: ShapeStyle = shapeStyle(ctx.settings.shape, ctx.foreground);
  const content = pathShape(path, style);
  if (!content) return null;
  const layer = createLayer({ id: newId(), name: numberedName(ctx.doc, "Shape"), content });
  return { doc: addLayer(ctx.doc, layer), layerId: layer.id };
}

/**
 * Records an edited path as one history step. A shape layer's pixels are
 * redrawn first (on the GPU, shown live meanwhile), as the shape tools do.
 */
export function commitPath(ctx: ToolContext, label: string, doc: Doc, t: PathTarget) {
  if (t.kind !== "layer") return ctx.commit(label, doc);
  // A vector mask is just a path: nothing to rasterize.
  const l = shapeLayer(doc, t.layerId);
  if (!l) return ctx.commit(label, doc);
  ctx.preview(doc);
  ctx.commitAsync(
    label,
    ctx.raster.shape(l.content.geometry, l.content.style, placementMapping(l.content.placement), docRect(doc)).then((pixels) => updateLayer(doc, l.id, { pixels })),
  );
}

/** Where the Pen tool puts a new component: the target, creating the work path when there's none. */
export const startingPath = (doc: Doc, t: PathTarget | null): VectorPath => (t && pathOf(doc, t)) || EMPTY_PATH;

/** Selection that drops what a path no longer has. */
export function clampSelection(st: PathState, path: VectorPath): PathState {
  const selected = validRefs(path, st.selected);
  return selected.length === st.selected.length ? st : { ...st, selected };
}

/** Picks a screen-pixel tolerance in document units. */
export const tolerance = (ctx: ToolContext, px: number) => px / ctx.view.zoom;

export const pointOf = (e: { x: number; y: number }): Vec2 => ({ x: e.x, y: e.y });

/** `to`, pulled onto the nearest 45° line through `from` (Shift while placing or dragging). */
export function constrain45(from: Vec2, to: Vec2): Vec2 {
  const dx = to.x - from.x, dy = to.y - from.y;
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const len = dx * Math.cos(angle) + dy * Math.sin(angle);
  return { x: from.x + Math.cos(angle) * len, y: from.y + Math.sin(angle) * len };
}

/** A path being edited and where it goes back. */
export interface Editing {
  readonly target: PathTarget;
  readonly path: VectorPath;
}

/** The path the selection and conversion tools edit now, if there is one. */
export function editing(ctx: ToolContext): Editing | null {
  const target = effectiveTarget(ctx.doc, ctx.paths);
  const path = target && pathOf(ctx.doc, target);
  return target && path ? { target, path } : null;
}

/** Shows an edited path without recording history. */
export const showPath = (ctx: ToolContext, ed: Editing, path: VectorPath) => ctx.preview(withPath(ctx.doc, ed.target, path));

/** Records an edited path as one step. */
export const recordPath = (ctx: ToolContext, label: string, ed: Editing, path: VectorPath) => commitPath(ctx, label, withPath(ctx.doc, ed.target, path), ed.target);

/** Selects anchor points of the path being edited (making it the target). */
export const selectPoints = (ctx: ToolContext, target: PathTarget, selected: readonly PointRef[]) => ctx.setPaths((s) => ({ ...s, target, selected }));

/** A pointer movement of under this many screen pixels is a click. */
export const CLICK_PX = 3;

/** The path the Pen tools edit now: a shape layer's in Shape mode, the work or a saved path in Path mode. */
export function penEditing(ctx: ToolContext): Editing | null {
  const ed = editing(ctx);
  // Shape mode draws shape layers; Path mode the work path, a saved path or a vector mask.
  return ed && isShapeTarget(ctx.doc, ed.target) === (ctx.settings.pen.mode === "shape") ? ed : null;
}

/** A component being drawn: where it goes and what it continues. */
export interface Stroke {
  readonly ed: Editing | null;
  /** The path the component joins, without it. */
  readonly base: VectorPath;
  /** The component's index in the path. */
  readonly sub: number;
  /** Knots it continues (the last is where drawing resumes); none for a new component. */
  readonly prefix: readonly Knot[];
  readonly op: PathOp;
  /** The shape layer made for it, once there is something to show. */
  made: { doc: Doc; target: PathTarget } | null;
}

/**
 * Begins a component for the freehand tools: continuing the open end `from`
 * of a component (turned round if it's the start), or a new one in the path
 * being edited — in Shape mode a new shape layer unless an operation is chosen.
 */
export function beginStroke(ctx: ToolContext, ed: Editing | null, from: PointRef | null): Stroke {
  const { pen } = ctx.settings;
  const op = pen.op === "new" ? "combine" : pen.op;
  if (ed && from) {
    const s = ed.path.subpaths[from.sub];
    const turned = from.knot === 0 && s.knots.length > 1 ? { ...s, knots: reverseKnots(s.knots) } : s;
    return { ed, base: { subpaths: ed.path.subpaths.map((x, i) => (i === from.sub ? { ...turned, knots: [] } : x)) }, sub: from.sub, prefix: turned.knots, op: s.op, made: null };
  }
  const newLayer = pen.mode === "shape" && (!ed || pen.op === "new");
  const base = newLayer ? EMPTY_PATH : (ed?.path ?? ctx.doc.workPath ?? EMPTY_PATH);
  return { ed: newLayer ? null : ed, base, sub: base.subpaths.length, prefix: [], op: base.subpaths.length ? op : "combine", made: null };
}

/**
 * The stroke's path with `knots` after its prefix as its component. With
 * `join`, the first of `knots` is the prefix's last point again, continued
 * (a freehand stroke drawn on from an end).
 */
export function strokePath(st: Stroke, knots: readonly Knot[], closed: boolean, join = false): VectorPath {
  const joined = join && st.prefix.length && knots.length ? [...st.prefix.slice(0, -1), { ...st.prefix[st.prefix.length - 1], out: knots[0].out }, ...knots.slice(1)] : [...st.prefix, ...knots];
  const component = { knots: joined, closed, op: st.op };
  const subpaths = [...st.base.subpaths];
  subpaths[st.sub] = component;
  return { subpaths };
}

/** The document showing the stroke's path, and its target (making the shape layer when it first has something to show). */
export function strokeDoc(ctx: ToolContext, st: Stroke, path: VectorPath): { doc: Doc; target: PathTarget } | null {
  if (st.ed) return { doc: withPath(ctx.doc, st.ed.target, path), target: st.ed.target };
  if (ctx.settings.pen.mode === "path") return { doc: withPath(ctx.doc, { kind: "work" }, path), target: { kind: "work" } };
  st.made ??= (() => {
    const made = newShapeLayer(ctx, path);
    return made && { doc: made.doc, target: { kind: "layer", layerId: made.layerId } as PathTarget };
  })();
  return st.made && { doc: withPath(st.made.doc, st.made.target, path), target: st.made.target };
}

/** Escape, Enter or another tool: the path is done (nothing is selected, so the next click starts a new one). */
export function endPenPath(ctx: ToolContext) {
  const ed = penEditing(ctx);
  if (!ed || !ctx.paths.selected.length) return;
  selectPoints(ctx, ed.target, []);
  // A lone anchor point in a new shape layer is nothing: the layer goes.
  const lone = ed.path.subpaths.length === 1 && ed.path.subpaths[0].knots.length === 1;
  if (lone && isShapeTarget(ctx.doc, ed.target) && ed.target.kind === "layer") ctx.commit("Pen Tool", removeLayer(ctx.doc, ed.target.layerId));
}
