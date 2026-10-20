import { activeLayer, updateLayer, type Doc, type Layer } from "../../core/document";
import { isEmpty, isIdentity, translation, vec, type Mat, type Vec2 } from "../../core/geometry";
import { compositeOver, extractFloating, transformTiles, type Floating } from "../../core/raster";
import { transformMask } from "../../core/selection";
import {
  dragHandle,
  dragMove,
  dragRotate,
  hitTest,
  initialTransform,
  transformMatrix,
  type TransformHit,
  type TransformState,
} from "../../core/transform";
import type { Tool, ToolContext, ToolEvent, ToolId } from "../types";

/** Pixels lifted off a layer, plus everything needed to put them back. */
interface Lift {
  readonly doc: Doc;
  readonly layer: Layer;
  readonly floating: Floating;
  readonly rest: Layer["tiles"];
}

function lift(doc: Doc): Lift | null {
  const layer = activeLayer(doc);
  if (!layer || !layer.visible) return null;
  const { floating, rest } = extractFloating(layer.tiles, doc.selection);
  return isEmpty(floating.bounds) ? null : { doc, layer, floating, rest };
}

function showLift(ctx: ToolContext, l: Lift, matrix: Mat) {
  ctx.preview(updateLayer(l.doc, l.layer.id, { tiles: l.rest }), {
    tiles: l.floating.tiles,
    bounds: l.floating.bounds,
    matrix,
    aboveLayerId: l.layer.id,
    opacity: l.layer.opacity,
    blendMode: l.layer.blendMode,
  });
}

/** Drops the lifted pixels back through `matrix`, moving the selection with them. */
export function placeLift(l: Lift, matrix: Mat): Doc {
  const tiles = compositeOver(l.rest, transformTiles(l.floating, matrix));
  const selection = l.doc.selection && transformMask(l.doc.selection, matrix);
  return { ...updateLayer(l.doc, l.layer.id, { tiles }), selection };
}

/** Move tool: drags the selection's pixels, or the whole layer, by whole pixels. */
export function createMoveTool(): Tool {
  let lifted: Lift | null = null;
  let start: Vec2 = vec(0, 0);
  let offset: Vec2 = vec(0, 0);
  return {
    id: "move",
    cursor: () => "move",
    down(ctx, e) {
      lifted = lift(ctx.doc);
      start = vec(e.x, e.y);
      offset = vec(0, 0);
    },
    move(ctx, e) {
      if (!lifted) return;
      offset = vec(Math.round(e.x - start.x), Math.round(e.y - start.y));
      showLift(ctx, lifted, translation(offset.x, offset.y));
    },
    up(ctx) {
      if (!lifted) return;
      const l = lifted;
      lifted = null;
      if (offset.x === 0 && offset.y === 0) return ctx.preview(null);
      ctx.commit("Move", placeLift(l, translation(offset.x, offset.y)));
    },
    cancel(ctx) {
      lifted = null;
      ctx.preview(null);
    },
  };
}

const HANDLE_TOLERANCE = 6; // screen pixels

const CURSORS: Record<string, string> = {
  "-1,-1": "nwse-resize",
  "1,1": "nwse-resize",
  "1,-1": "nesw-resize",
  "-1,1": "nesw-resize",
  "0,-1": "ns-resize",
  "0,1": "ns-resize",
  "-1,0": "ew-resize",
  "1,0": "ew-resize",
};

export interface FreeTransformTool extends Tool {
  /** Starts transforming the selection (or the active layer). Returns false if there is nothing to transform. */
  begin(ctx: ToolContext, returnTo: ToolId): boolean;
  /** Current state, for numeric entry in the options bar. */
  state(): TransformState | null;
  set(ctx: ToolContext, s: TransformState): void;
}

export function createFreeTransformTool(): FreeTransformTool {
  let lifted: Lift | null = null;
  let state: TransformState | null = null;
  let returnTo: ToolId = "move";
  let drag: { hit: TransformHit; start: Vec2; from: TransformState } | null = null;

  const show = (ctx: ToolContext) => {
    if (!lifted || !state) return;
    showLift(ctx, lifted, transformMatrix(state));
    ctx.overlay({ kind: "transform", state });
  };

  const end = (ctx: ToolContext) => {
    lifted = null;
    state = null;
    drag = null;
    ctx.overlay(null);
    ctx.setTool(returnTo);
  };

  const hit = (ctx: ToolContext, e: ToolEvent) => hitTest(state!, e, HANDLE_TOLERANCE / ctx.view.zoom);

  return {
    id: "transform",
    begin(ctx, back) {
      lifted = lift(ctx.doc);
      if (!lifted) return false;
      returnTo = back;
      state = initialTransform(lifted.floating.bounds);
      show(ctx);
      return true;
    },
    state: () => state,
    set(ctx, s) {
      state = s;
      show(ctx);
    },
    cursor(ctx, e) {
      if (!state || !e) return "default";
      const h = drag?.hit ?? hit(ctx, e);
      if (h.kind === "move") return "move";
      if (h.kind === "rotate") return "alias";
      return CURSORS[`${h.hx},${h.hy}`];
    },
    down(ctx, e) {
      if (!state) return;
      drag = { hit: hit(ctx, e), start: vec(e.x, e.y), from: state };
    },
    move(ctx, e) {
      if (!drag) return;
      const { hit: h, start, from } = drag;
      if (h.kind === "move") state = dragMove(from, e.x - start.x, e.y - start.y);
      else if (h.kind === "rotate") state = dragRotate(from, start, e, e.shift);
      else {
        const corner = h.hx !== 0 && h.hy !== 0;
        state = dragHandle(from, h.hx, h.hy, e, { proportional: corner !== e.shift, fromCenter: e.alt });
      }
      show(ctx);
    },
    up() {
      drag = null;
    },
    commit(ctx) {
      if (!lifted || !state) return;
      const m = transformMatrix(state);
      const l = lifted;
      end(ctx);
      if (isIdentity(m)) ctx.preview(null);
      else ctx.commit("Free Transform", placeLift(l, m));
    },
    cancel(ctx) {
      if (!lifted) return;
      end(ctx);
      ctx.preview(null);
    },
  };
}
