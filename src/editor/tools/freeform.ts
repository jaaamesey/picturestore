import { flatten } from "../../core/composite";
import { fitCurve } from "../../core/curveFit";
import { vec, type Vec2 } from "../../core/geometry";
import { createEdges, traceEdge, type Edges } from "../../core/livewire";
import { anchorAt, isEndpoint, type Knot } from "../../core/path";
import type { Tool, ToolContext, ToolEvent } from "../types";
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

/** A Magnetic Pen path in progress: it spans clicks, so it lives in the tool. */
interface Magnetic {
  readonly st: Stroke;
  readonly edges: Edges;
  readonly size: { width: number; height: number };
  /** The path so far, up to the last fastening point. */
  chain: Vec2[];
  /** How long the chain was at each fastening point. */
  fastened: number[];
  /** The last fastening point. */
  seed: Vec2;
  /** The route from the seed to the pointer. */
  live: Vec2[];
  readonly closeAt: Vec2;
  near: boolean;
}

/** Fitting error for the pixel routes the Magnetic Pen traces, in document pixels. */
const MAGNETIC_FIT = 1.25;

const length = (pts: readonly Vec2[]) => pts.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0), 0);

/**
 * The Freeform Pen: drag to draw a path that follows the pointer, fitted
 * with as few anchor points as Curve Fit allows. Drag from the end of an
 * open path to continue it; drag back to where the path began to close it.
 *
 * With Magnetic on it is the Magnetic Pen: click to start, then move along
 * an edge in the image — the path snaps to it, with fastening points added
 * as it goes (Frequency) — and click to add a fastening point yourself.
 * Delete removes the last one; Enter ends an open path; clicking the start
 * or double-clicking closes along the edge (Alt+double-click straight);
 * Alt-click makes a straight segment and Alt-drag draws freehand; [ and ]
 * change the Width; Escape cancels.
 */
export function createFreeformPenTool(): Tool {
  let g: Gesture | null = null;
  let m: Magnetic | null = null;
  let magnetic = false;
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

  const widthOf = (ctx: ToolContext, e?: ToolEvent) => ctx.settings.pen.magneticWidth * (ctx.settings.pen.magneticPressure && e && e.pressure > 0 ? e.pressure * 2 : 1);

  /** The route to the pointer, with fastening points added when the stretch from the last gets long. */
  function follow(ctx: ToolContext, e: ToolEvent) {
    const s = m!;
    const { pen } = ctx.settings;
    const opts = () => ({ width: widthOf(ctx, e), contrast: pen.magneticContrast });
    const to = vec(e.x, e.y);
    s.live = traceEdge(s.edges, s.seed, to, opts(), s.size);
    // The more frequent, the sooner a stretch is fastened.
    const longest = 400 / (1 + pen.magneticFrequency / 8);
    if (length(s.live) > longest) {
      let run = 0, k = 1;
      while (k < s.live.length - 1 && run < longest * 0.7) run += Math.hypot(s.live[k].x - s.live[k - 1].x, s.live[k].y - s.live[k - 1].y), k++;
      s.chain.push(...s.live.slice(1, k + 1));
      s.fastened.push(s.chain.length);
      s.seed = s.live[k];
      s.live = traceEdge(s.edges, s.seed, to, opts(), s.size);
    }
    s.near = s.chain.length > 8 && Math.hypot(to.x - s.closeAt.x, to.y - s.closeAt.y) * ctx.view.zoom <= GRAB_PX;
  }

  const magneticKnots = (pts: readonly Vec2[], closed: boolean): { knots: Knot[]; closed: boolean } => {
    const knots = fitCurve(pts, MAGNETIC_FIT);
    if (!closed || knots.length < 3) return { knots, closed: false };
    const last = knots.pop()!;
    knots[0] = { ...knots[0], in: last.in, smooth: false };
    return { knots, closed: true };
  };

  function showMagnetic(ctx: ToolContext) {
    const s = m!;
    const { knots } = magneticKnots([...s.chain, ...s.live.slice(1)], false);
    if (knots.length < 2) return ctx.preview(null);
    const shown = strokeDoc(ctx, s.st, strokePath(s.st, knots, false));
    if (shown) ctx.preview(shown.doc);
  }

  /** Ends the path, open or closed (along the edge, or straight). */
  function finishMagnetic(ctx: ToolContext, how: "open" | "edge" | "straight") {
    const s = m!;
    m = null;
    let pts = [...s.chain];
    if (how === "open") pts.push(...s.live.slice(1));
    else if (how === "edge") pts.push(...traceEdge(s.edges, s.seed, s.closeAt, { width: ctx.settings.pen.magneticWidth, contrast: ctx.settings.pen.magneticContrast }, s.size).slice(1));
    else pts.push(s.closeAt);
    pts = pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);
    const { knots, closed } = magneticKnots(pts, how !== "open");
    if (knots.length < 2) return ctx.preview(null);
    const path = strokePath(s.st, knots, closed);
    const shown = strokeDoc(ctx, s.st, path);
    if (!shown) return ctx.preview(null);
    commitPath(ctx, "Magnetic Pen Tool", shown.doc, shown.target);
    selectPoints(ctx, shown.target, closed ? [] : [{ sub: s.st.sub, knot: path.subpaths[s.st.sub].knots.length - 1 }]);
  }

  function magneticDown(ctx: ToolContext, e: ToolEvent) {
    const p = ctx.snap.point(vec(e.x, e.y));
    if (!m) {
      const ed = penEditing(ctx);
      const doc = ctx.doc;
      m = {
        st: beginStroke(ctx, ed, null),
        edges: createEdges(doc.width, doc.height, (area) => flatten(doc, area)),
        size: doc,
        chain: [p],
        fastened: [1],
        seed: p,
        live: [p],
        closeAt: p,
        near: false,
      };
      return;
    }
    if (e.clicks >= 2) return finishMagnetic(ctx, e.alt ? "straight" : "edge");
    if (m.near) return finishMagnetic(ctx, "edge");
    if (e.alt) m.live = [m.seed, p];
    else follow(ctx, e);
    // Fasten here: the route to the pointer becomes part of the path.
    m.chain.push(...m.live.slice(1));
    m.fastened.push(m.chain.length);
    m.seed = m.chain[m.chain.length - 1];
    m.live = [m.seed];
    showMagnetic(ctx);
  }

  return {
    id: "freeform-pen",
    // Magnetic follows the pointer's latest position; freehand needs every one.
    get latestMoveOnly() {
      return magnetic;
    },
    cursor: () => penCursor(g?.near || m?.near ? "close" : m || magnetic ? "magnetic" : "freeform"),
    activate(ctx) {
      magnetic = ctx.settings.pen.magnetic;
    },
    sync(ctx) {
      magnetic = ctx.settings.pen.magnetic;
      // Turning Magnetic off abandons a path in progress.
      if (!magnetic && m) {
        m = null;
        ctx.preview(null);
      }
    },
    down(ctx, e) {
      if (ctx.settings.pen.magnetic) return magneticDown(ctx, e);
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
      if (m) {
        const p = vec(e.x, e.y);
        if (e.alt) {
          // Alt-drag draws freehand from the last point.
          const last = m.chain[m.chain.length - 1];
          if (Math.hypot(p.x - last.x, p.y - last.y) * ctx.view.zoom < 1) return;
          m.chain.push(p);
          m.seed = p;
          m.live = [p];
        } else follow(ctx, e);
        return showMagnetic(ctx);
      }
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
    hover(ctx, e) {
      if (!m) return;
      follow(ctx, e);
      showMagnetic(ctx);
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
    keyDown(ctx, e) {
      if (!m || e.mod) return false;
      if (e.key === "Enter") return (finishMagnetic(ctx, "open"), true);
      if (e.key === "[" || e.key === "]") {
        ctx.updateSettings((s) => void (s.pen.magneticWidth = Math.min(256, Math.max(1, s.pen.magneticWidth + (e.key === "]" ? 1 : -1)))));
        return true;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return false;
      // Deletes the last fastening point and the stretch before it; at the start, the whole path.
      if (m.fastened.length <= 1) {
        m = null;
        ctx.preview(null);
        return true;
      }
      m.fastened.pop();
      m.chain.length = m.fastened[m.fastened.length - 1];
      m.seed = m.chain[m.chain.length - 1];
      m.live = [m.seed];
      showMagnetic(ctx);
      return true;
    },
    cancel(ctx) {
      if (m) {
        m = null;
        return ctx.preview(null);
      }
      if (g) {
        g = null;
        return ctx.preview(null);
      }
      endPenPath(ctx);
    },
    commit(ctx) {
      if (m) return finishMagnetic(ctx, "open");
      this.cancel!(ctx);
    },
  };
}
