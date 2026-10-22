import { relaxPath } from "../../core/curvature";
import { vec, type Vec2 } from "../../core/geometry";
import { activeEndpoint, anchorAt, closeSubpath, cornerKnot, insertKnot, isEndpoint, moveKnots, nearestSegment, removeKnot, sameRef, setKnot, type Knot, type PointRef, type VectorPath } from "../../core/path";
import type { Tool, ToolContext, ToolEvent } from "../types";
import { penCursor } from "./cursors";
import { CLICK_PX, beginStroke, commitPath, constrain45, endPenPath, penEditing, recordPath, selectPoints, strokeDoc, strokePath, tolerance, validRefs, withPath, type Editing, type Stroke } from "./pathEdit";

const GRAB_PX = 6;
const LABEL = "Curvature Pen Tool";

const autoKnot = (p: Vec2): Knot => ({ anchor: p, in: p, out: p, smooth: true, auto: true });

type Gesture =
  | { kind: "place"; st: Stroke; ref: PointRef; from: Vec2; prev: Vec2 | null }
  /** `insert`: the point is new (on a segment), so the path shown is recorded even if it isn't moved. */
  | { kind: "move"; ed: Editing; ref: PointRef; from: Vec2; lead: Vec2; moved: boolean; insert: boolean };

/**
 * The Curvature Pen: click to add points that a smooth curve passes through
 * (the curve forms itself — there are no direction lines to manage);
 * double-click to make a corner point, or to turn a point from one to the
 * other; click a segment to add a point on it; drag a point to move it;
 * click the first point to close the path. Delete removes a point and keeps
 * the curve.
 */
export function createCurvaturePenTool(): Tool {
  let g: Gesture | null = null;

  /** The new point's place: the pointer, snapped (Shift holds the segment before it to 45°). */
  const placed = (ctx: ToolContext, e: ToolEvent, prev: Vec2 | null): Vec2 => {
    const p = ctx.snap.point(vec(e.x, e.y));
    return e.shift && prev ? constrain45(prev, p) : p;
  };

  function showPlace(ctx: ToolContext, gesture: Extract<Gesture, { kind: "place" }>, at: Vec2) {
    const path = relaxPath(strokePath(gesture.st, [autoKnot(at)], false));
    const shown = strokeDoc(ctx, gesture.st, path);
    if (shown) ctx.preview(shown.doc);
    return { path, shown };
  }

  return {
    id: "curvature-pen",
    latestMoveOnly: true,
    cursor: () => penCursor("curvature"),
    down(ctx, e) {
      g = null;
      const ed = penEditing(ctx);
      const p = vec(e.x, e.y);
      const grab = tolerance(ctx, GRAB_PX);
      const ref = ed && anchorAt(ed.path, p, grab);
      if (ed && ref) {
        const k = ed.path.subpaths[ref.sub].knots[ref.knot];
        const selected = validRefs(ed.path, ctx.paths.selected);
        const active = activeEndpoint(ed.path, selected);
        selectPoints(ctx, ed.target, [ref]);
        if (e.clicks >= 2) {
          // Double-clicking a point turns it from smooth to corner and back.
          const toggled = k.auto ? cornerKnot(k.anchor) : autoKnot(k.anchor);
          return recordPath(ctx, LABEL, ed, relaxPath(setKnot(ed.path, ref, toggled)));
        }
        if (active && ref.sub === active.sub && !sameRef(ref, active) && isEndpoint(ed.path, ref)) {
          recordPath(ctx, LABEL, ed, relaxPath(closeSubpath(ed.path, ref.sub)));
          return selectPoints(ctx, ed.target, []);
        }
        g = { kind: "move", ed, ref, from: p, lead: k.anchor, moved: false, insert: false };
        return;
      }
      const seg = ed && nearestSegment(ed.path, p, grab);
      if (ed && seg) {
        // A point on a segment: where it was clicked, and the curve forms around it.
        const inserted = insertKnot(ed.path, seg.sub, seg.seg, seg.t);
        const path = relaxPath(setKnot(inserted.path, inserted.ref, autoKnot(seg.point)));
        selectPoints(ctx, ed.target, [inserted.ref]);
        ctx.preview(withPath(ctx.doc, ed.target, path));
        g = { kind: "move", ed: { ...ed, path }, ref: inserted.ref, from: p, lead: seg.point, moved: false, insert: true };
        return;
      }
      const active = ed && activeEndpoint(ed.path, validRefs(ed.path, ctx.paths.selected));
      const st = beginStroke(ctx, ed, active || null);
      const prev = st.prefix.length ? st.prefix[st.prefix.length - 1].anchor : null;
      const sub = st.sub;
      const gesture: Extract<Gesture, { kind: "place" }> = { kind: "place", st, ref: { sub, knot: st.prefix.length }, from: p, prev };
      g = gesture;
      showPlace(ctx, gesture, placed(ctx, e, prev));
    },
    move(ctx, e) {
      if (!g) return;
      if (g.kind === "place") return void showPlace(ctx, g, placed(ctx, e, g.prev));
      if (!g.moved && Math.hypot(e.x - g.from.x, e.y - g.from.y) * ctx.view.zoom < CLICK_PX) return;
      g.moved = true;
      const to = ctx.snap.point(vec(g.lead.x + e.x - g.from.x, g.lead.y + e.y - g.from.y));
      const { ed, ref } = g;
      const path = moveKnots(ed.path, [ref], vec(to.x - g.lead.x, to.y - g.lead.y));
      ctx.preview(withPath(ctx.doc, ed.target, path));
    },
    up(ctx, e) {
      const gesture = g;
      g = null;
      if (!gesture) return;
      if (gesture.kind === "move") {
        if (!gesture.moved) return gesture.insert ? recordPath(ctx, LABEL, gesture.ed, gesture.ed.path) : ctx.preview(null);
        const to = ctx.snap.point(vec(gesture.lead.x + e.x - gesture.from.x, gesture.lead.y + e.y - gesture.from.y));
        return recordPath(ctx, LABEL, gesture.ed, moveKnots(gesture.ed.path, [gesture.ref], vec(to.x - gesture.lead.x, to.y - gesture.lead.y)));
      }
      const { shown } = showPlace(ctx, gesture, placed(ctx, e, gesture.prev));
      if (!shown) return ctx.preview(null);
      commitPath(ctx, LABEL, shown.doc, shown.target);
      selectPoints(ctx, shown.target, [gesture.ref]);
    },
    keyDown(ctx, e) {
      const ed = penEditing(ctx);
      const selected = ed ? validRefs(ed.path, ctx.paths.selected) : [];
      if (!ed || !selected.length || e.mod || e.alt || (e.key !== "Delete" && e.key !== "Backspace")) return false;
      // The points go and the curve is kept: it forms again around the rest.
      let path: VectorPath = ed.path;
      for (const r of [...selected].sort((a, b) => b.sub - a.sub || b.knot - a.knot)) path = removeKnot(path, r);
      recordPath(ctx, "Delete Anchor Point", ed, path);
      selectPoints(ctx, ed.target, []);
      return true;
    },
    cancel(ctx) {
      if (g) {
        g = null;
        return ctx.preview(null);
      }
      endPenPath(ctx);
    },
    commit: (ctx) => endPenPath(ctx),
  };
}
