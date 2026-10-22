import { renderLayers } from "../../core/composite";
import { framedState, isPlaced, placementState, sourceFloating, toPlacement, withContent, type PlacedContent } from "../../core/content";
import { mapPath } from "../../core/path";
import { PIXELS, docRect, editTarget, layerById, updateLayer, type Doc, type Guide, type Layer, type LayerContent } from "../../core/document";
import { transformLayer } from "../../core/documentTransform";
import { EMPTY_RECT, apply, boundsOf, intersect, isEmpty, rect, union, vec, type Mat, type Rect, type Vec2 } from "../../core/geometry";
import { textLayout } from "../../text/engine";
import type { TextContent } from "../../text/model";
import { allLayers, childrenOf, hasPixels, isGroup, updateIn } from "../../core/layers";
import { guidePosition } from "../snapping";
import { RULER_PX } from "../view";
import { compositeOver, extractFloating, type Floating } from "../../core/raster";
import type { Filter } from "../../core/rasterize";
import { transformMask, translateMask } from "../../core/selection";
import { NO_PIXELS, contentBounds, translatePixels, type Pixels } from "../../core/pixels";
import {
  dragTransform,
  flip,
  handles,
  hitTest,
  initialTransform,
  integerOffset,
  rotateAbout,
  toMapping,
  translate,
  type Drag,
  type HitOptions,
  type TransformHit,
  type TransformMode,
  type TransformState,
} from "../../core/transform";
import { IDENTITY_PATCH, invert3, invertPatch, isIdentityPatch, mapPoint, mul3, project, quadOf, squareToQuad, subMapping, type Mapping } from "../../core/warp";
import type { FloatingLayer, FloatingPixels } from "../../gpu/renderer";
import type { Tool, ToolContext, ToolEvent, ToolId } from "../types";

export type TransformCommand = "rotate-180" | "rotate-90-cw" | "rotate-90-ccw" | "flip-horizontal" | "flip-vertical";

/** Handle grab radius and the Move tool's rotate band, in screen pixels. */
const HANDLE_PX = 7;
const ROTATE_BAND_PX = 24;

/**
 * What a transform session moves: pixels lifted off a pixel layer or a
 * mask, a smart object's or shape's placement (re-rendered from its source,
 * so repeated transforms never degrade it), or a group's contents. Each
 * knows how to preview and apply a state.
 */
export interface Target {
  readonly layer: Layer;
  /** Layers whose content moves (excluded from snapping). */
  readonly moving: readonly string[];
  /** Groups transform projectively, without Warp (as in Photoshop, which needs a smart object for that). */
  readonly canWarp?: false;
  /** Live type: scale, rotate, skew and flip only — Photoshop allows neither Distort nor Perspective on it (nor a custom warp: Warp Text instead). */
  readonly affineOnly?: true;
  /** The untransformed state. */
  readonly initial: TransformState;
  /** Where the controls go: the content's frame, which can differ from `initial` (a warped placement as it is). */
  readonly frame: TransformState;
  show(ctx: ToolContext, s: TransformState): void;
  /** The document with `s` applied, at commit quality. */
  place(ctx: ToolContext, s: TransformState, filter: Filter): Promise<Doc>;
}

/** Floating pixels moved through `m` at commit quality: exactly, when that's a whole-pixel move. */
const land = (ctx: ToolContext, f: Floating, m: Mapping, filter: Filter, offset: Vec2 | null) =>
  offset ? Promise.resolve(translatePixels(f.pixels, offset.x, offset.y)) : ctx.raster.resample(f, m, filter);

/**
 * Lifts the selection (or everything) off the target: a layer's pixels,
 * with its linked mask following, or a mask on its own. The selection is
 * hidden while its pixels float and reappears, transformed, on commit.
 * Whole-pixel moves are exact copies; anything else is resampled.
 */
function pixelTarget(doc: Doc, layer: Layer, mask: boolean): Target | null {
  const lift = (p: Pixels) => extractFloating(p, doc.selection);
  const main = lift(mask ? layer.mask!.pixels : layer.pixels);
  if (isEmpty(main.floating.bounds)) return null;
  // A linked mask moves with the layer's pixels.
  const follower = !mask && layer.mask?.linked ? lift(layer.mask.pixels) : null;
  const initial = initialTransform(main.floating.bounds);
  const floatOf = (f: Floating, m: Mapping): FloatingPixels | null => (isEmpty(f.bounds) ? null : { ...f, mapping: m });
  const rest = (pixels: Pixels, maskPixels: Pixels | null) =>
    updateLayer(doc, layer.id, mask ? { mask: { ...layer.mask!, pixels } } : { pixels, ...(maskPixels && { mask: { ...layer.mask!, pixels: maskPixels } }) });
  return {
    layer,
    moving: [layer.id],
    initial,
    frame: initial,
    show(ctx, s) {
      const m = toMapping(s);
      const own = floatOf(main.floating, m);
      const fm = follower && floatOf(follower.floating, subMapping(m, follower.floating.bounds));
      ctx.preview({ ...rest(main.rest, follower?.rest ?? null), selection: null }, { layerId: layer.id, pixels: mask ? null : own, mask: mask ? own : fm });
    },
    async place(ctx, s, filter) {
      const offset = integerOffset(s);
      const m = toMapping(s);
      const sel = doc.selection;
      const moved = await land(ctx, main.floating, m, filter, offset);
      const movedMask = follower && !isEmpty(follower.floating.bounds) ? compositeOver(follower.rest, await land(ctx, follower.floating, subMapping(m, follower.floating.bounds), filter, offset)) : null;
      const selection = sel && (offset ? translateMask(sel, offset.x, offset.y) : transformMask(sel, m));
      return { ...rest(compositeOver(main.rest, moved), movedMask), selection };
    },
  };
}

/** Where a point goes when content moves from state `from` to `to`. */
function mover(from: TransformState, to: TransformState): (p: Vec2) => Vec2 {
  const inverse = invert3(squareToQuad(from.quad)!)!;
  const toMap = toMapping(to);
  return (p) => {
    let q = project(inverse, p.x, p.y);
    if (from.patch) {
      const st = invertPatch(from.patch, q);
      if (st) q = vec(st.s, st.t);
    }
    return mapPoint(toMap, q.x, q.y);
  };
}

/** The layers' vector masks, carried along as the content moves from state `from` to `to`. */
function carryVectorMasks(d: Doc, ids: readonly string[], from: TransformState, to: TransformState): Doc {
  let out = d;
  let map: ((p: Vec2) => Vec2) | null = null;
  for (const id of ids) {
    const l = layerById(out, id);
    if (!l?.vectorMask) continue;
    map ??= mover(from, to);
    out = updateLayer(out, id, { vectorMask: { ...l.vectorMask, path: mapPath(l.vectorMask.path, map) } });
  }
  return out;
}

/** A transform target whose layers' vector masks follow the content. */
function withVectorMasks(t: Target): Target {
  return {
    ...t,
    // (The context is extended, not copied, so its live properties stay live.)
    show: (ctx, s) => t.show(Object.create(ctx, { preview: { value: (d: Doc | null, f?: FloatingLayer | null) => ctx.preview(d && carryVectorMasks(d, t.moving, t.initial, s), f) } }) as ToolContext, s),
    // A group's contents are transformed as documents are, vector masks included.
    place: async (ctx, s, filter) => {
      const d = await t.place(ctx, s, filter);
      return t.layer.content.kind === "group" ? d : carryVectorMasks(d, t.moving, t.initial, s);
    },
  };
}

/**
 * Where something framed by `b` goes when content moves from state `from`
 * to `to` (a placement's mask following it): exact for projective
 * transforms; under a warp, its corners land exactly and the rest follows
 * the homography between them.
 */
function follow(from: TransformState, to: TransformState, b: Rect): Mapping {
  const corner = mover(from, to);
  const q = quadOf(b);
  return { source: b, quad: [corner(q[0]), corner(q[1]), corner(q[2]), corner(q[3])], patch: null };
}

/**
 * Smart objects and shapes transform as a whole, whatever is selected (as
 * in Photoshop), their linked mask with them. Free Transform edits the
 * content-framed state (`framed`); the Move tool translates the placement
 * as it is, so a moved shape is recognisably the same content, moved (which
 * renderers draw without rasterizing again).
 */
function contentTarget(doc: Doc, layer: Layer, content: PlacedContent, framed: boolean): Target {
  const clip = docRect(doc);
  const at = (s: TransformState): LayerContent => ({ ...content, placement: toPlacement(s) });
  const frame = framedState(content.placement);
  const initial = framed ? frame : placementState(content.placement);
  const maskPixels = layer.mask?.linked ? layer.mask.pixels : null;
  const maskFloat: Floating | null = maskPixels && !isEmpty(contentBounds(maskPixels)) ? { pixels: maskPixels, bounds: contentBounds(maskPixels) } : null;
  const withMask = (d: Doc, pixels: Pixels) => (maskFloat ? updateLayer(d, layer.id, { mask: { ...layer.mask!, pixels } }) : d);
  /** A whole-pixel translation of the document, if that's all the transform is. */
  const offsetOf = (s: TransformState): Vec2 | null => {
    const dx = s.quad[0].x - initial.quad[0].x, dy = s.quad[0].y - initial.quad[0].y;
    const same = s.patch === initial.patch && s.quad.every((q, i) => q.x - initial.quad[i].x === dx && q.y - initial.quad[i].y === dy);
    return same && Number.isInteger(dx) && Number.isInteger(dy) ? vec(dx, dy) : null;
  };
  return {
    layer,
    moving: [layer.id],
    initial,
    frame,
    show(ctx, s) {
      const mask = maskFloat && { ...maskFloat, mapping: follow(initial, s, maskFloat.bounds) };
      const base = withMask(doc, NO_PIXELS);
      // Shapes preview as themselves: the renderer rasterizes the vector on the GPU, exactly, every frame.
      if (content.kind === "shape") return ctx.preview(updateLayer(base, layer.id, { content: at(s) }), mask && { layerId: layer.id, pixels: null, mask });
      ctx.preview(updateLayer(base, layer.id, { pixels: NO_PIXELS }), { layerId: layer.id, pixels: { ...sourceFloating(content.source), mapping: toMapping(s) }, mask });
    },
    async place(ctx, s, filter) {
      const { content: c, pixels } = await withContent(layer, at(s), clip, ctx.raster, filter);
      const d = updateLayer(doc, layer.id, { content: c, pixels });
      return maskFloat ? withMask(d, await land(ctx, maskFloat, follow(initial, s, maskFloat.bounds), filter, offsetOf(s))) : d;
    },
  };
}

/** The affine map taking `b` onto the parallelogram `q` (its first, second and fourth corners). */
export function boxToQuad(b: Rect, q: readonly Vec2[]): Mat {
  const w = b.w || 1, h = b.h || 1;
  const a = (q[1].x - q[0].x) / w, bb = (q[1].y - q[0].y) / w, c = (q[3].x - q[0].x) / h, d = (q[3].y - q[0].y) / h;
  return [a, bb, c, d, q[0].x - a * b.x - c * b.y, q[0].y - bb * b.x - d * b.y];
}

/** The transform box of live type: its frame (the paragraph box, or the lines' extent) through its transform. */
export function textState(c: TextContent): TransformState {
  const b = textBox(c);
  const t = c.transform;
  const quad = quadOf(b).map((p) => apply(t, p)) as unknown as TransformState["quad"];
  return { source: b, quad, angle: Math.atan2(t[1], t[0]), patch: null, reference: apply(t, vec(b.x + b.w / 2, b.y + b.h / 2)) };
}

/** The text's frame in text space, never degenerate (empty type still has a caret's height). */
function textBox(c: TextContent): Rect {
  const layout = textLayout(c);
  const b = layout.bounds;
  // Type on a path: the box round where the type runs (its layout bounds are measured along the path, not in the document).
  if (layout.onPath && !isEmpty(b)) {
    const pts: Vec2[] = [];
    // (`place` measures up from the path; the layout's lines are y-down.)
    for (let i = 0; i <= 32; i++) for (const t of [b.y, b.y + b.h]) pts.push(layout.place(b.x + (b.w * i) / 32, -t));
    const box = boundsOf(pts);
    return rect(box.x, box.y, Math.max(box.w, 1), Math.max(box.h, 1));
  }
  if (b.w > 0 && b.h > 0) return b;
  const size = c.runs[0].style.size;
  return rect(b.x, isEmpty(b) ? -size : b.y, Math.max(b.w, 1), Math.max(b.h, size));
}

/**
 * Live type transforms as a whole, its linked mask with it: the transform
 * box maps onto the type's affine transform, so it's laid out and drawn
 * afresh, as vectors, every frame and on commit.
 */
function textTarget(doc: Doc, layer: Layer, content: TextContent): Target {
  const clip = docRect(doc);
  const initial = textState(content);
  const at = (s: TransformState): TextContent => ({ ...content, transform: boxToQuad(initial.source, s.quad), stale: false });
  const maskPixels = layer.mask?.linked ? layer.mask.pixels : null;
  const maskFloat: Floating | null = maskPixels && !isEmpty(contentBounds(maskPixels)) ? { pixels: maskPixels, bounds: contentBounds(maskPixels) } : null;
  const withMask = (d: Doc, pixels: Pixels) => (maskFloat ? updateLayer(d, layer.id, { mask: { ...layer.mask!, pixels } }) : d);
  return {
    layer,
    moving: [layer.id],
    canWarp: false,
    affineOnly: true,
    initial,
    frame: initial,
    show(ctx, s) {
      const mask = maskFloat && { ...maskFloat, mapping: follow(initial, s, maskFloat.bounds) };
      ctx.preview(updateLayer(withMask(doc, NO_PIXELS), layer.id, { content: at(s) }), mask && { layerId: layer.id, pixels: null, mask });
    },
    async place(ctx, s, filter) {
      const { content: c, pixels } = await withContent(layer, at(s), clip, ctx.raster, filter);
      const d = updateLayer(doc, layer.id, { content: c, pixels });
      return maskFloat ? withMask(d, await land(ctx, maskFloat, follow(initial, s, maskFloat.bounds), filter, integerOffset(s))) : d;
    },
  };
}

/** A group's layers with content of their own (bounding what moves). */
const contentsOf = (g: Layer) => allLayers(childrenOf(g)).filter(hasPixels);

/**
 * A group: everything in it transforms together (masks included), as a
 * projective map of the document. Whole-pixel moves preview exactly, by
 * drawing its layers shifted; anything else previews the group's contents
 * merged, as one floating image.
 */
function groupTarget(doc: Doc, group: Layer): Target | null {
  const inside = contentsOf(group);
  const bounds = inside.reduce((r, l) => union(r, contentBounds(l.pixels)), EMPTY_RECT);
  if (isEmpty(bounds)) return null;
  const initial = initialTransform(bounds);
  const ids = new Set([group.id, ...allLayers(childrenOf(group)).map((l) => l.id)]);
  let merged: Pixels | null = null;
  return {
    layer: group,
    canWarp: false,
    moving: [...ids],
    initial,
    frame: initial,
    show(ctx, s) {
      const offset = integerOffset(s);
      if (offset) return ctx.preview(doc, { layerId: group.id, pixels: null, mask: null, shift: { ids, by: offset } });
      merged ??= renderLayers([{ ...group, visible: true, clipped: false, opacity: 1, blendMode: "normal", mask: null }], bounds);
      // The group stands in as one layer of its merged contents, with its mode, opacity, mask and clipping.
      const stand: Layer = { ...group, content: PIXELS, pixels: NO_PIXELS, blendMode: group.blendMode === "pass through" ? "normal" : group.blendMode };
      ctx.preview({ ...doc, layers: updateIn(doc.layers, group.id, () => stand) }, { layerId: group.id, pixels: { pixels: merged, bounds, mapping: toMapping(s) }, mask: null });
    },
    async place(ctx, s, filter) {
      const H = squareToQuad(s.quad)!;
      // Document space → the unit square over the bounds → the quad.
      const matrix = mul3(H, [1 / bounds.w, 0, -bounds.x / bounds.w, 0, 1 / bounds.h, -bounds.y / bounds.h, 0, 0, 1]);
      const moved = await transformLayer(group, { matrix, width: doc.width, height: doc.height, lengthScale: 1, filter, clipToCanvas: false }, ctx.raster);
      return { ...doc, layers: updateIn(doc.layers, group.id, () => moved) };
    },
  };
}

/**
 * The edit target as a transform target; null when hidden or empty.
 * `framed`: see {@link contentTarget}.
 */
export function transformTarget(doc: Doc, framed = true): Target | null {
  const target = baseTarget(doc, framed);
  return target && withVectorMasks(target);
}

function baseTarget(doc: Doc, framed: boolean): Target | null {
  const t = editTarget(doc);
  if (!t || !t.layer.visible) return null;
  const { layer } = t;
  if (t.mask) return pixelTarget(doc, layer, true);
  if (isGroup(layer)) return groupTarget(doc, layer);
  if (isPlaced(layer.content)) return contentTarget(doc, layer, layer.content, framed);
  if (layer.content.kind === "text") return textTarget(doc, layer, layer.content);
  return layer.content.kind === "pixels" ? pixelTarget(doc, layer, false) : null;
}

/**
 * What the Move tool frames with its transform controls: a smart object's or
 * shape's placement, a group's contents, else the target's content clipped
 * to the selection. Cheap (per-tile bounds are cached; nothing is lifted).
 */
export function moveFrame(doc: Doc): TransformState | null {
  const t = editTarget(doc);
  if (!t || !t.layer.visible) return null;
  const { layer } = t;
  let b: Rect;
  if (!t.mask && isPlaced(layer.content)) return framedState(layer.content.placement);
  if (!t.mask && layer.content.kind === "text") return textState(layer.content);
  if (!t.mask && isGroup(layer)) b = contentsOf(layer).reduce((r, l) => union(r, contentBounds(l.pixels)), EMPTY_RECT);
  else if (!t.mask && layer.content.kind === "adjustment") return null;
  else b = contentBounds(t.pixels);
  const box = doc.selection && !isGroup(layer) ? intersect(b, doc.selection.bounds) : b;
  return isEmpty(box) ? null : initialTransform(box);
}

const LABELS: Record<TransformMode, string> = {
  free: "Free Transform",
  scale: "Scale",
  rotate: "Rotate",
  skew: "Skew",
  distort: "Distort",
  perspective: "Perspective",
  warp: "Warp",
};

const RESIZE_CURSORS = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];

/** The resize cursor for dragging along screen direction (dx, dy). */
export const resizeCursorToward = (dx: number, dy: number) =>
  RESIZE_CURSORS[Math.round((((((Math.atan2(dy, dx) * 180) / Math.PI) % 180) + 180) % 180) / 45) % 4];

/** A resize cursor matching a handle's on-screen direction from the box centre. */
function resizeCursor(s: TransformState, hit: TransformHit): string {
  const h = handles(s);
  const p = hit.kind === "corner" ? h.corners[hit.index] : hit.kind === "edge" ? h.edges[hit.index] : null;
  if (!p) return "default";
  const c = vec((h.corners[0].x + h.corners[2].x) / 2, (h.corners[0].y + h.corners[2].y) / 2);
  const a = ((Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI + 360) % 180;
  return RESIZE_CURSORS[Math.round(a / 45) % 4];
}

/** A curved double arrow, like Photoshop's rotate cursor. */
export const ROTATE_CURSOR =
  `url("data:image/svg+xml,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M5 9a9 9 0 0 1 14 0" fill="none" stroke="white" stroke-width="4"/><path d="M5 9a9 9 0 0 1 14 0M3 6l2 3.5 3.5-2M21 6l-2 3.5-3.5-2" fill="none" stroke="black" stroke-width="1.6"/></svg>',
  )}") 12 8, alias`;

function cursorFor(s: TransformState, hit: TransformHit, mode: TransformMode): string {
  switch (hit.kind) {
    case "corner":
    case "edge":
      if (mode === "rotate") return ROTATE_CURSOR;
      return mode === "free" || mode === "scale" ? resizeCursor(s, hit) : "crosshair";
    case "rotate":
      return ROTATE_CURSOR;
    case "move":
      return mode === "rotate" ? ROTATE_CURSOR : "move";
    case "reference":
    case "warp-point":
      return "pointer";
    case "warp-surface":
      return "move";
    default:
      return "default";
  }
}

export function applyCommand(s: TransformState, c: TransformCommand): TransformState {
  switch (c) {
    case "rotate-180":
      return rotateAbout(s, Math.PI);
    case "rotate-90-cw":
      return rotateAbout(s, Math.PI / 2);
    case "rotate-90-ccw":
      return rotateAbout(s, -Math.PI / 2);
    case "flip-horizontal":
      return flip(s, "horizontal");
    case "flip-vertical":
      return flip(s, "vertical");
  }
}

export interface TransformController extends Tool {
  readonly id: "transform";
  /**
   * Starts a session on the active layer of `place.doc` (Place Embedded: the
   * new layer is committed only if the session is), else of the current
   * document. With `grab`, the session starts mid-drag on `hit` — how the
   * Move tool's handles hand over. Returns false when there is nothing to
   * transform.
   */
  begin(
    ctx: ToolContext,
    opts: {
      returnTo: ToolId;
      mode?: TransformMode;
      grab?: { event: ToolEvent; hit: TransformHit };
      place?: { doc: Doc; label: string };
    },
  ): boolean;
  readonly state: () => TransformState | null;
  readonly mode: () => TransformMode;
  /** Numeric entry. */
  setState(ctx: ToolContext, s: TransformState): void;
  setMode(ctx: ToolContext, m: TransformMode): void;
  command(ctx: ToolContext, c: TransformCommand): void;
  /** Steps back within the session (Ctrl+Z while transforming). False when there is nothing left to undo. */
  undo(ctx: ToolContext): boolean;
}

export function createTransformController(): TransformController {
  let target: Target | null = null;
  let state: TransformState | null = null;
  let mode: TransformMode = "free";
  let returnTo: ToolId = "move";
  /** Set when committing must record a step even without a transform (Place Embedded). */
  let placeLabel: string | null = null;
  let steps: TransformState[] = [];
  let drag: Drag | null = null;

  const show = (ctx: ToolContext) => {
    if (!target || !state) return;
    target.show(ctx, state);
    ctx.overlay({ kind: "transform", state, mode });
  };

  const record = (ctx: ToolContext, next: TransformState) => {
    if (!state || next === state) return;
    steps.push(state);
    state = next;
    show(ctx);
  };

  const hitOptions = (ctx: ToolContext): HitOptions => ({
    tolerance: HANDLE_PX / ctx.view.zoom,
    mode,
    showReference: ctx.settings.transform.showReference,
    rotateBand: Infinity,
  });

  const end = (ctx: ToolContext) => {
    target = null;
    state = null;
    drag = null;
    steps = [];
    placeLabel = null;
    ctx.overlay(null);
    ctx.setTool(returnTo);
  };

  const down = (ctx: ToolContext, e: ToolEvent, forced?: TransformHit) => {
    if (!state) return;
    const hit = forced ?? hitTest(state, e, hitOptions(ctx));
    if (!forced && e.clicks >= 2 && hit.kind === "move") return commit(ctx);
    if (!forced && e.alt && ctx.settings.transform.showReference && (hit.kind === "move" || hit.kind === "none")) {
      // Alt-click places the reference point.
      return record(ctx, { ...state, reference: vec(e.x, e.y) });
    }
    drag = { hit, start: vec(e.x, e.y), from: state, mode, link: ctx.settings.transform.link };
  };

  const commit = (ctx: ToolContext) => {
    if (!target || !state) return;
    const t = target;
    const s = state;
    const label = placeLabel ?? LABELS[mode];
    const changed = placeLabel !== null || !sameState(s, t.initial);
    const filter = ctx.settings.transform.interpolation;
    end(ctx);
    if (changed) ctx.commitAsync(label, t.place(ctx, s, filter));
    else ctx.preview(null);
  };

  return {
    id: "transform",
    latestMoveOnly: true,
    commitOnSwitch: true,
    begin(ctx, { returnTo: back, mode: m = "free", grab, place }) {
      target = transformTarget(place?.doc ?? ctx.doc);
      if (!target) return false;
      returnTo = back;
      mode = m;
      steps = [];
      placeLabel = place?.label ?? null;
      state = target.initial;
      if (target.affineOnly && (m === "distort" || m === "perspective")) mode = "free";
      if (m === "warp" && target.canWarp === false) mode = "free";
      else if (m === "warp") state = { ...state, patch: state.patch ?? IDENTITY_PATCH };
      show(ctx);
      if (grab) down(ctx, grab.event, grab.hit);
      return true;
    },
    state: () => state,
    mode: () => mode,
    setState: (ctx, s) => record(ctx, s),
    setMode(ctx, m) {
      if (!state || (m === "warp" && target?.canWarp === false) || (target?.affineOnly && (m === "distort" || m === "perspective"))) return;
      mode = m;
      if (m === "warp" && !state.patch) record(ctx, { ...state, patch: IDENTITY_PATCH });
      else show(ctx);
    },
    command: (ctx, c) => state && record(ctx, applyCommand(state, c)),
    undo(ctx) {
      if (!state || steps.length === 0) return false;
      state = steps.pop()!;
      show(ctx);
      return true;
    },
    cursor(ctx, e) {
      if (!state || !e) return "default";
      return cursorFor(state, drag?.hit ?? hitTest(state, e, hitOptions(ctx)), mode);
    },
    down: (ctx, e) => down(ctx, e),
    move(ctx, e) {
      if (!drag || !state || !target) return;
      // Live type can't be distorted: a corner with Ctrl scales, as without it.
      const mods = target.affineOnly && drag.hit.kind === "corner" ? { ...e, mod: false } : e;
      state = dragTransform(drag, snappedPointer(ctx, drag, e, target.moving), mods);
      show(ctx);
    },
    up() {
      if (drag && state !== drag.from) steps.push(drag.from);
      drag = null;
    },
    commit,
    cancel(ctx) {
      if (!target) return;
      end(ctx);
      ctx.preview(null);
    },
  };
}

const near = (p: Vec2, q: Vec2) => Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.y - q.y) < 1e-9;
const effectivePatch = (s: TransformState) => (s.patch && !isIdentityPatch(s.patch) ? s.patch : null);

/** True when a session ended where it started (an untouched warp grid counts as no warp). */
function sameState(a: TransformState, b: TransformState): boolean {
  const pa = effectivePatch(a), pb = effectivePatch(b);
  const samePatch = pa === pb || (!!pa && !!pb && pa.every((p, i) => near(p, pb[i])));
  return samePatch && a.quad.every((p, i) => near(p, b.quad[i]));
}

/**
 * Move tool. With "Show Transform Controls" (on by default) the active
 * layer's bounds get handles: dragging a handle, or just outside a corner,
 * hands over to a Free Transform session; dragging anywhere else moves the
 * layer (or selected pixels) by whole pixels.
 */
export function createMoveTool(transform: TransformController): Tool {
  let target: Target | null = null;
  let start: Vec2 = vec(0, 0);
  let offset: Vec2 = vec(0, 0);
  /** A guide being dragged (its index), and where it would go (null: off the window or onto a ruler, deleting it). */
  let guide: { index: number; to: number | null } | null = null;

  const controlHit = (ctx: ToolContext, e: ToolEvent): TransformHit => {
    if (!ctx.settings.transform.showControls) return { kind: "none" };
    const frame = moveFrame(ctx.doc);
    if (!frame) return { kind: "none" };
    const hit = hitTest(frame, e, {
      tolerance: HANDLE_PX / ctx.view.zoom,
      mode: "free",
      showReference: false,
      rotateBand: ROTATE_BAND_PX / ctx.view.zoom,
    });
    return hit.kind === "corner" || hit.kind === "edge" || hit.kind === "rotate" ? hit : { kind: "none" };
  };

  return {
    id: "move",
    latestMoveOnly: true,
    cursor(ctx, e) {
      if (!e || target) return "move";
      const g = guide ? ctx.doc.guides![guide.index] : guideHit(ctx, e) >= 0 ? ctx.doc.guides![guideHit(ctx, e)] : null;
      if (g) return g.orientation === "vertical" ? "col-resize" : "row-resize";
      const hit = controlHit(ctx, e);
      const frame = hit.kind === "none" ? null : moveFrame(ctx.doc);
      return frame ? cursorFor(frame, hit, "free") : "move";
    },
    down(ctx, e) {
      // Guides are moved with the Move tool (unless locked).
      const g = guideHit(ctx, e);
      if (g >= 0) {
        guide = { index: g, to: ctx.doc.guides![g].position };
        return;
      }
      const hit = controlHit(ctx, e);
      if (hit.kind !== "none" && transform.begin(ctx, { returnTo: "move", grab: { event: e, hit } })) {
        ctx.setTool("transform");
        return;
      }
      target = transformTarget(ctx.doc, false);
      start = vec(e.x, e.y);
      offset = vec(0, 0);
    },
    move(ctx, e) {
      if (guide) {
        const g = ctx.doc.guides![guide.index];
        guide.to = offGuideArea(ctx, e, g.orientation) ? null : guidePosition(ctx.snap, ctx.view.zoom, g.orientation, vec(e.x, e.y), e.shift);
        return ctx.preview(withGuide(ctx.doc, guide.index, guide.to));
      }
      if (!target) return;
      let dx = e.x - start.x, dy = e.y - start.y;
      const axis = !e.shift ? null : Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      if (axis) [dx, dy] = axis === "x" ? [dx, 0] : [0, dy];
      // The moved bounds snap by an edge or the centre; Ctrl suspends snapping, as in Photoshop.
      const b = boundsOf(translate(target.frame, dx, dy).quad);
      const sn = ctx.snap.rect(b, { exclude: target.moving, off: e.mod });
      if (axis !== "y") dx += sn.x;
      if (axis !== "x") dy += sn.y;
      offset = vec(Math.round(dx), Math.round(dy));
      target.show(ctx, translate(target.initial, offset.x, offset.y));
      if (ctx.settings.transform.showControls) ctx.overlay({ kind: "frame", state: translate(target.frame, offset.x, offset.y) });
    },
    up(ctx) {
      if (guide) {
        const { index, to } = guide;
        guide = null;
        const g = ctx.doc.guides![index];
        if (to === g.position) return ctx.preview(null);
        return ctx.commit(to === null ? "Delete Guide" : "Move Guide", withGuide(ctx.doc, index, to));
      }
      if (!target) return;
      const t = target;
      target = null;
      ctx.overlay(null);
      if (offset.x === 0 && offset.y === 0) return ctx.preview(null);
      ctx.commitAsync("Move", t.place(ctx, translate(t.initial, offset.x, offset.y), ctx.settings.transform.interpolation));
    },
    cancel(ctx) {
      guide = null;
      if (!target) return;
      target = null;
      ctx.overlay(null);
      ctx.preview(null);
    },
  };
}

/**
 * Where the pointer counts as being in a transform drag: what it drags — a
 * handle, the reference point, or the content's bounds when moving — lands
 * snapped. Rotation doesn't snap (Shift steps it by 15°), and nor does a
 * move constrained by Shift.
 */
function snappedPointer(ctx: ToolContext, drag: Drag, e: ToolEvent, moving: readonly string[]): Vec2 {
  const p = vec(e.x, e.y), d = vec(p.x - drag.start.x, p.y - drag.start.y);
  const o = { exclude: moving };
  const pulled = (at: Vec2) => {
    const s = ctx.snap.point(at, o);
    return vec(p.x + s.x - at.x, p.y + s.y - at.y);
  };
  const { hit, from, mode } = drag;
  switch (hit.kind) {
    case "corner":
    case "edge": {
      if (mode === "rotate") return p;
      const h = hit.kind === "corner" ? from.quad[hit.index] : handles(from).edges[hit.index];
      return pulled(vec(h.x + d.x, h.y + d.y));
    }
    case "reference":
      return ctx.snap.point(p, o);
    case "move": {
      if (mode === "rotate" || e.shift) return p;
      const s = ctx.snap.rect(boundsOf(translate(from, d.x, d.y).quad), o);
      return vec(p.x + s.x, p.y + s.y);
    }
    default:
      return p;
  }
}

/** Grab distance for guides, in screen pixels. */
const GUIDE_PX = 4;

/** The guide under the pointer (one that can be moved: shown and unlocked), or −1. */
function guideHit(ctx: ToolContext, e: ToolEvent): number {
  const v = ctx.viewOptions;
  if (!v.extras || !v.showGuides || v.lockGuides || ctx.view.rotation) return -1;
  const guides = ctx.doc.guides ?? [];
  let best = -1, bestD = GUIDE_PX / ctx.view.zoom;
  guides.forEach((g, i) => {
    const d = Math.abs((g.orientation === "vertical" ? e.x : e.y) - g.position);
    if (d <= bestD) [best, bestD] = [i, d];
  });
  return best;
}

/** Dropped here, a guide is deleted: on its ruler, or outside the window. */
function offGuideArea(ctx: ToolContext, e: ToolEvent, orientation: Guide["orientation"]): boolean {
  const { width, height } = ctx.viewport;
  if (e.screenX < 0 || e.screenY < 0 || e.screenX > width || e.screenY > height) return true;
  return ctx.viewOptions.rulers && (orientation === "vertical" ? e.screenX < RULER_PX : e.screenY < RULER_PX);
}

/** `doc` with guide `index` moved to `position`, or removed (null). */
const withGuide = (doc: Doc, index: number, position: number | null): Doc => ({
  ...doc,
  guides: position === null ? doc.guides!.filter((_, i) => i !== index) : doc.guides!.map((g, i) => (i === index ? { ...g, position } : g)),
});
