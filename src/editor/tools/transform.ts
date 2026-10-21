import { framedState, placementState, sourceFloating, toPlacement, withContent } from "../../core/content";
import { activeLayer, docRect, updateLayer, type Doc, type Guide, type Layer, type LayerContent } from "../../core/document";
import { boundsOf, intersect, isEmpty, vec, type Vec2 } from "../../core/geometry";
import { guidePosition } from "../snapping";
import { RULER_PX } from "../view";
import { compositeOver, extractFloating } from "../../core/raster";
import type { Filter } from "../../core/rasterize";
import { transformMask, translateMask } from "../../core/selection";
import { EMPTY_TILES, contentBounds, translateTiles } from "../../core/tiles";
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
import { IDENTITY_PATCH, isIdentityPatch } from "../../core/warp";
import type { Tool, ToolContext, ToolEvent, ToolId } from "../types";

export type TransformCommand = "rotate-180" | "rotate-90-cw" | "rotate-90-ccw" | "flip-horizontal" | "flip-vertical";

/** Handle grab radius and the Move tool's rotate band, in screen pixels. */
const HANDLE_PX = 7;
const ROTATE_BAND_PX = 24;

/**
 * What a transform session moves: pixels lifted off a pixel layer, or a smart
 * object's or shape's placement (re-rendered from its source, so repeated
 * transforms never degrade it). Each knows how to preview and apply a state.
 */
export interface Target {
  readonly layer: Layer;
  /** The untransformed state. */
  readonly initial: TransformState;
  /** Where the controls go: the content's frame, which can differ from `initial` (a warped placement as it is). */
  readonly frame: TransformState;
  show(ctx: ToolContext, s: TransformState): void;
  /** The document with `s` applied, at commit quality. */
  place(ctx: ToolContext, s: TransformState, filter: Filter): Promise<Doc>;
}

/**
 * Lifts the selection (or the whole active layer) off a pixel layer. The
 * selection is hidden while its pixels float and reappears, transformed, on
 * commit. Whole-pixel moves are exact copies; anything else is resampled.
 */
function pixelTarget(doc: Doc, layer: Layer): Target | null {
  const { floating, rest } = extractFloating(layer.tiles, doc.selection);
  if (isEmpty(floating.bounds)) return null;
  const initial = initialTransform(floating.bounds);
  return {
    layer,
    initial,
    frame: initial,
    show(ctx, s) {
      ctx.preview({ ...updateLayer(doc, layer.id, { tiles: rest }), selection: null }, {
        tiles: floating.tiles,
        bounds: floating.bounds,
        mapping: toMapping(s),
        aboveLayerId: layer.id,
        opacity: layer.opacity,
        blendMode: layer.blendMode,
      });
    },
    async place(ctx, s, filter) {
      const offset = integerOffset(s);
      const sel = doc.selection;
      const moved = offset ? translateTiles(floating.tiles, offset.x, offset.y) : await ctx.raster.resample(floating, toMapping(s), filter);
      const selection = sel && (offset ? translateMask(sel, offset.x, offset.y) : transformMask(sel, toMapping(s)));
      return { ...updateLayer(doc, layer.id, { tiles: compositeOver(rest, moved) }), selection };
    },
  };
}

/** Smart objects and shapes transform as a whole, whatever is selected (as in Photoshop). */
/**
 * Smart objects and shapes: Free Transform edits the content-framed state
 * (`framed`); the Move tool translates the placement as it is, so a moved
 * shape is recognisably the same content, moved (which renderers draw
 * without rasterizing again).
 */
function contentTarget(doc: Doc, layer: Layer, content: Exclude<LayerContent, { kind: "pixels" }>, framed: boolean): Target {
  const clip = docRect(doc);
  const at = (s: TransformState): LayerContent => ({ ...content, placement: toPlacement(s) });
  const frame = framedState(content.placement);
  return {
    layer,
    initial: framed ? frame : placementState(content.placement),
    frame,
    show(ctx, s) {
      // Shapes preview as themselves: the renderer rasterizes the vector on the GPU, exactly, every frame.
      if (content.kind === "shape") return ctx.preview(updateLayer(doc, layer.id, { content: at(s) }));
      ctx.preview(updateLayer(doc, layer.id, { tiles: EMPTY_TILES }), {
        ...sourceFloating(content.source),
        mapping: toMapping(s),
        aboveLayerId: layer.id,
        opacity: layer.opacity,
        blendMode: layer.blendMode,
      });
    },
    async place(ctx, s, filter) {
      const { content: c, tiles } = await withContent(layer, at(s), clip, ctx.raster, filter);
      return updateLayer(doc, layer.id, { content: c, tiles });
    },
  };
}

/** The active layer as a transform target; null when hidden or empty. `framed`: see {@link contentTarget}. */
export function transformTarget(doc: Doc, framed = true): Target | null {
  const layer = activeLayer(doc);
  if (!layer || !layer.visible) return null;
  return layer.content.kind === "pixels" ? pixelTarget(doc, layer) : contentTarget(doc, layer, layer.content, framed);
}

/**
 * What the Move tool frames with its transform controls: a smart object's or
 * shape's placement, else the layer's content clipped to the selection.
 * Cheap (per-tile bounds are cached; nothing is lifted).
 */
export function moveFrame(doc: Doc): TransformState | null {
  const layer = activeLayer(doc);
  if (!layer || !layer.visible) return null;
  if (layer.content.kind !== "pixels") return framedState(layer.content.placement);
  const b = contentBounds(layer.tiles);
  const box = doc.selection ? intersect(b, doc.selection.bounds) : b;
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
      if (m === "warp") state = { ...state, patch: state.patch ?? IDENTITY_PATCH };
      show(ctx);
      if (grab) down(ctx, grab.event, grab.hit);
      return true;
    },
    state: () => state,
    mode: () => mode,
    setState: (ctx, s) => record(ctx, s),
    setMode(ctx, m) {
      if (!state) return;
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
      state = dragTransform(drag, snappedPointer(ctx, drag, e, target.layer.id), e);
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
      const sn = ctx.snap.rect(b, { exclude: [target.layer.id], off: e.mod });
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
function snappedPointer(ctx: ToolContext, drag: Drag, e: ToolEvent, layerId: string): Vec2 {
  const p = vec(e.x, e.y), d = vec(p.x - drag.start.x, p.y - drag.start.y);
  const o = { exclude: [layerId] };
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
