import { fitCurve } from "../../core/curveFit";
import { vec, type Vec2 } from "../../core/geometry";
import { anchorAt, isEndpoint, type Knot } from "../../core/path";
import type { Tool, ToolContext } from "../types";
import { penCursor } from "./cursors";
import { beginStroke, commitPath, endPenPath, penEditing, selectPoints, strokeDoc, strokePath, tolerance, type Stroke } from "./pathEdit";

const GRAB_PX = 6;
const LABEL = "Freeform Pen Tool";

interface Gesture {
  readonly st: Stroke;
  readonly points: Vec2[];
  /** Dragging back to this point closes the path. */
  readonly closeAt: Vec2 | null;
  /** How far the pointer has gone (closing needs a path to close). */
  travelled: number;
  near: boolean;
}

/**
 * The Freeform Pen: drag to draw a path that follows the pointer, fitted
 * with as few anchor points as Curve Fit allows. Drag from the end of an
 * open path to continue it; drag back to where the path began to close it.
 */
export function createFreeformPenTool(): Tool {
  let g: Gesture | null = null;
  /** The fit's tolerance in document pixels. */
  const error = (ctx: ToolContext) => ctx.settings.pen.curveFit / ctx.view.zoom;

  /** The knots the stroke has so far, and whether it's closed. */
  function fitted(ctx: ToolContext, closing: boolean): { knots: Knot[]; closed: boolean } {
    const gesture = g!;
    const pts = closing && gesture.closeAt ? [...gesture.points, gesture.closeAt] : gesture.points;
    const knots = fitCurve(pts, error(ctx));
    if (!(closing && gesture.closeAt && knots.length >= 3)) return { knots, closed: false };
    // The last knot is the first one again: it gives the closing segment its direction line.
    const last = knots.pop()!;
    knots[0] = { ...knots[0], in: last.in, smooth: false };
    return { knots, closed: true };
  }

  function show(ctx: ToolContext) {
    const gesture = g!;
    const { knots, closed } = fitted(ctx, gesture.near);
    if (knots.length < 2) return;
    const shown = strokeDoc(ctx, gesture.st, strokePath(gesture.st, knots, closed, true));
    if (shown) ctx.preview(shown.doc);
  }

  return {
    id: "freeform-pen",
    cursor: () => penCursor(g?.near ? "close" : "freeform"),
    down(ctx, e) {
      const ed = penEditing(ctx);
      const p = vec(e.x, e.y);
      const end = ed && anchorAt(ed.path, p, tolerance(ctx, GRAB_PX));
      const from = end && isEndpoint(ed.path, end) ? end : null;
      const st = beginStroke(ctx, ed, from);
      const start = st.prefix.length ? st.prefix[st.prefix.length - 1].anchor : ctx.snap.point(p);
      // A path continued from one end closes to the other end.
      const closeAt = st.prefix.length ? (st.prefix.length > 1 ? st.prefix[0].anchor : null) : start;
      g = { st, points: [start], closeAt, travelled: 0, near: false };
    },
    move(ctx, e) {
      if (!g) return;
      const p = vec(e.x, e.y);
      const last = g.points[g.points.length - 1];
      const step = Math.hypot(p.x - last.x, p.y - last.y);
      if (step * ctx.view.zoom < 1) return;
      g.points.push(p);
      g.travelled += step;
      g.near = !!g.closeAt && g.travelled * ctx.view.zoom > 4 * GRAB_PX && Math.hypot(p.x - g.closeAt.x, p.y - g.closeAt.y) * ctx.view.zoom <= GRAB_PX;
      show(ctx);
    },
    up(ctx) {
      const gesture = g;
      if (!gesture) return;
      const { knots, closed } = fitted(ctx, gesture.near);
      g = null;
      if (knots.length < 2) return ctx.preview(null);
      const path = strokePath(gesture.st, knots, closed, true);
      const shown = strokeDoc(ctx, gesture.st, path);
      if (!shown) return ctx.preview(null);
      commitPath(ctx, LABEL, shown.doc, shown.target);
      const sub = gesture.st.sub;
      selectPoints(ctx, shown.target, closed ? [] : [{ sub, knot: path.subpaths[sub].knots.length - 1 }]);
    },
    cancel(ctx) {
      if (g) {
        g = null;
        return ctx.preview(null);
      }
      endPenPath(ctx);
    },
    commit(ctx) {
      this.cancel!(ctx);
    },
  };
}
