import { activeLayer, updateLayer, type Doc, type Layer } from "../../core/document";
import { intersect, isEmpty, vec, type Rect, type Vec2 } from "../../core/geometry";
import { compositeOver, extractFloating, type Floating } from "../../core/raster";
import type { Filter } from "../../core/rasterize";
import { transformMask, translateMask } from "../../core/selection";
import { contentBounds, translateTiles, type TileMap } from "../../core/tiles";
import {
  dragTransform,
  flip,
  handles,
  hitTest,
  initialTransform,
  integerOffset,
  isIdentityTransform,
  rotateAbout,
  toMapping,
  translate,
  type Drag,
  type HitOptions,
  type TransformHit,
  type TransformMode,
  type TransformState,
} from "../../core/transform";
import { IDENTITY_PATCH } from "../../core/warp";
import type { Tool, ToolContext, ToolEvent, ToolId } from "../types";

export type TransformCommand = "rotate-180" | "rotate-90-cw" | "rotate-90-ccw" | "flip-horizontal" | "flip-vertical";

/** Handle grab radius and the Move tool's rotate band, in screen pixels. */
const HANDLE_PX = 7;
const ROTATE_BAND_PX = 24;

/** Pixels lifted off a layer, plus everything needed to put them back. */
interface Lift {
  readonly doc: Doc;
  readonly layer: Layer;
  readonly floating: Floating;
  readonly rest: TileMap;
}

function lift(doc: Doc): Lift | null {
  const layer = activeLayer(doc);
  if (!layer || !layer.visible) return null;
  const { floating, rest } = extractFloating(layer.tiles, doc.selection);
  return isEmpty(floating.bounds) ? null : { doc, layer, floating, rest };
}

/**
 * What the Move tool frames with its transform controls: the active layer's
 * content, clipped to the selection. Cheap (per-tile bounds are cached).
 */
export function moveBox(doc: Doc): Rect | null {
  const layer = activeLayer(doc);
  if (!layer || !layer.visible) return null;
  const b = contentBounds(layer.tiles);
  const box = doc.selection ? intersect(b, doc.selection.bounds) : b;
  return isEmpty(box) ? null : box;
}

function showLift(ctx: ToolContext, l: Lift, s: TransformState) {
  // The selection is hidden while its pixels float; it reappears, transformed, on commit.
  ctx.preview({ ...updateLayer(l.doc, l.layer.id, { tiles: l.rest }), selection: null }, {
    tiles: l.floating.tiles,
    bounds: l.floating.bounds,
    mapping: toMapping(s),
    aboveLayerId: l.layer.id,
    opacity: l.layer.opacity,
    blendMode: l.layer.blendMode,
  });
}

/**
 * Drops the lifted pixels back through the transform, moving the selection
 * with them. Whole-pixel moves are exact copies; everything else is
 * resampled at commit quality (on the GPU in the app).
 */
export async function placeLift(ctx: ToolContext, l: Lift, s: TransformState, filter: Filter): Promise<Doc> {
  const offset = integerOffset(s);
  const sel = l.doc.selection;
  const moved = offset ? translateTiles(l.floating.tiles, offset.x, offset.y) : await ctx.resample(l.floating, toMapping(s), filter);
  const selection = sel && (offset ? translateMask(sel, offset.x, offset.y) : transformMask(sel, toMapping(s)));
  return { ...updateLayer(l.doc, l.layer.id, { tiles: compositeOver(l.rest, moved) }), selection };
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
const ROTATE_CURSOR =
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
   * Lifts the selection (or active layer) and starts a session. With `grab`,
   * the session starts mid-drag on `hit` — how the Move tool's handles hand
   * over. Returns false when there is nothing to transform.
   */
  begin(ctx: ToolContext, opts: { returnTo: ToolId; mode?: TransformMode; grab?: { event: ToolEvent; hit: TransformHit } }): boolean;
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
  let lifted: Lift | null = null;
  let state: TransformState | null = null;
  let mode: TransformMode = "free";
  let returnTo: ToolId = "move";
  let steps: TransformState[] = [];
  let drag: Drag | null = null;

  const show = (ctx: ToolContext) => {
    if (!lifted || !state) return;
    showLift(ctx, lifted, state);
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
    lifted = null;
    state = null;
    drag = null;
    steps = [];
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
    if (!lifted || !state) return;
    const l = lifted;
    const s = state;
    const label = LABELS[mode];
    const filter = ctx.settings.transform.interpolation;
    end(ctx);
    if (isIdentityTransform(s)) ctx.preview(null);
    else ctx.commitAsync(label, placeLift(ctx, l, s, filter));
  };

  return {
    id: "transform",
    begin(ctx, { returnTo: back, mode: m = "free", grab }) {
      lifted = lift(ctx.doc);
      if (!lifted) return false;
      returnTo = back;
      mode = m;
      steps = [];
      state = initialTransform(lifted.floating.bounds);
      if (m === "warp") state = { ...state, patch: IDENTITY_PATCH };
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
      if (!drag || !state) return;
      state = dragTransform(drag, e, e);
      show(ctx);
    },
    up() {
      if (drag && state !== drag.from) steps.push(drag.from);
      drag = null;
    },
    commit,
    cancel(ctx) {
      if (!lifted) return;
      end(ctx);
      ctx.preview(null);
    },
  };
}

/**
 * Move tool. With "Show Transform Controls" (on by default) the active
 * layer's bounds get handles: dragging a handle, or just outside a corner,
 * hands over to a Free Transform session; dragging anywhere else moves the
 * pixels by whole pixels.
 */
export function createMoveTool(transform: TransformController): Tool {
  let lifted: Lift | null = null;
  let start: Vec2 = vec(0, 0);
  let offset: Vec2 = vec(0, 0);

  const controlHit = (ctx: ToolContext, e: ToolEvent): TransformHit => {
    if (!ctx.settings.transform.showControls) return { kind: "none" };
    const box = moveBox(ctx.doc);
    if (!box) return { kind: "none" };
    const hit = hitTest(initialTransform(box), e, {
      tolerance: HANDLE_PX / ctx.view.zoom,
      mode: "free",
      showReference: false,
      rotateBand: ROTATE_BAND_PX / ctx.view.zoom,
    });
    return hit.kind === "corner" || hit.kind === "edge" || hit.kind === "rotate" ? hit : { kind: "none" };
  };

  return {
    id: "move",
    cursor(ctx, e) {
      if (!e || lifted) return "move";
      const hit = controlHit(ctx, e);
      const box = hit.kind === "none" ? null : moveBox(ctx.doc);
      return box ? cursorFor(initialTransform(box), hit, "free") : "move";
    },
    down(ctx, e) {
      const hit = controlHit(ctx, e);
      if (hit.kind !== "none" && transform.begin(ctx, { returnTo: "move", grab: { event: e, hit } })) {
        ctx.setTool("transform");
        return;
      }
      lifted = lift(ctx.doc);
      start = vec(e.x, e.y);
      offset = vec(0, 0);
    },
    move(ctx, e) {
      if (!lifted) return;
      let dx = e.x - start.x, dy = e.y - start.y;
      if (e.shift) [dx, dy] = Math.abs(dx) >= Math.abs(dy) ? [dx, 0] : [0, dy];
      offset = vec(Math.round(dx), Math.round(dy));
      showLift(ctx, lifted, translate(initialTransform(lifted.floating.bounds), offset.x, offset.y));
    },
    up(ctx) {
      if (!lifted) return;
      const l = lifted;
      lifted = null;
      if (offset.x === 0 && offset.y === 0) return ctx.preview(null);
      ctx.commitAsync("Move", placeLift(ctx, l, translate(initialTransform(l.floating.bounds), offset.x, offset.y), "nearest"));
    },
    cancel(ctx) {
      if (!lifted) return;
      lifted = null;
      ctx.preview(null);
    },
  };
}
