import { rectFromPoints, vec, type Vec2 } from "../../core/geometry";
import {
  allAnchors,
  anchorAt,
  anchorsIn,
  copySubpaths,
  deleteSelection,
  dragSegment,
  handleAt,
  hasHandles,
  insertKnot,
  moveHandle,
  moveKnots,
  moveSubpaths,
  nearestSegment,
  pointInSubpath,
  removeKnot,
  removeSubpaths,
  sameRef,
  selectedSubpaths,
  setKnot,
  subpathTouchesRect,
  toCorner,
  toSmooth,
  type PathHit,
  type PointRef,
  type VectorPath,
} from "../../core/path";
import type { Tool, ToolContext, ToolEvent, ToolId, ToolKeyDown } from "../types";
import { penCursor } from "./cursors";
import { CLICK_PX, constrain45, editing, recordPath, selectPoints, showPath, tolerance, validRefs, type Editing } from "./pathEdit";

/** How near the pointer must be to take hold of anchor points, direction points and segments, in screen pixels. */
const GRAB_PX = 6;

const at = (e: ToolEvent): Vec2 => vec(e.x, e.y);
const moved = (ctx: ToolContext, from: Vec2, e: ToolEvent) => Math.hypot(e.x - from.x, e.y - from.y) * ctx.view.zoom >= CLICK_PX;
const knotOf = (path: VectorPath, r: PointRef) => path.subpaths[r.sub].knots[r.knot];
const union = (a: readonly PointRef[], b: readonly PointRef[]) => [...a, ...b.filter((r) => !a.some((x) => sameRef(x, r)))];

/** The offset `d` from `from` as dragged: Shift holds it to 45° steps. */
const offset = (from: Vec2, to: Vec2, shift: boolean): Vec2 => {
  const p = shift ? constrain45(from, to) : to;
  return vec(p.x - from.x, p.y - from.y);
};

/** The arrow keys' and Delete's edits of the selected anchor points, shared by both selection tools. */
function editKeys(ctx: ToolContext, e: ToolKeyDown, whole: boolean): boolean {
  const ed = editing(ctx);
  const selected = ed ? validRefs(ed.path, ctx.paths.selected) : [];
  if (!ed || !selected.length || e.mod || e.alt) return false;
  const arrow = { ArrowLeft: vec(-1, 0), ArrowRight: vec(1, 0), ArrowUp: vec(0, -1), ArrowDown: vec(0, 1) }[e.key];
  if (arrow) {
    const d = vec(arrow.x * (e.shift ? 10 : 1), arrow.y * (e.shift ? 10 : 1));
    recordPath(ctx, whole ? "Move Path Components" : "Move Anchor Points", ed, whole ? moveSubpaths(ed.path, selectedSubpaths(ed.path, selected), d) : moveKnots(ed.path, selected, d));
    return true;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    const after = whole ? { path: removeSubpaths(ed.path, selectedSubpaths(ed.path, selected)), selected: [] } : deleteSelection(ed.path, selected);
    recordPath(ctx, whole ? "Delete Path Component" : "Delete Anchor Points", ed, after.path);
    selectPoints(ctx, ed.target, after.selected);
    return true;
  }
  if (e.key === "Escape") {
    selectPoints(ctx, ed.target, []);
    return true;
  }
  return false;
}

type Marquee = { start: Vec2; shift: boolean; before: readonly PointRef[]; ed: Editing };

const showMarquee = (ctx: ToolContext, m: Marquee, e: ToolEvent) => ctx.overlay({ kind: "marquee", shape: "rect", rect: rectFromPoints(m.start, at(e)) });

/**
 * The Direct Selection tool: click an anchor point or a segment, or drag a
 * marquee, to select anchor points (Shift adds); drag selected points, a
 * segment (Shift holds 45°) or a direction point (the other side of a smooth
 * point turns to stay on one line; Alt breaks it); Alt-click selects a whole
 * component. Ctrl+Alt over an anchor point is the Convert Point tool.
 */
export function createDirectSelectTool(): Tool {
  const convert = createConvertPointTool();
  type Drag =
    | { kind: "anchors"; ed: Editing; from: Vec2; refs: PointRef[]; lead: Vec2; click: PointRef | null; shift: boolean }
    | { kind: "handle"; ed: Editing; ref: PointRef; side: "in" | "out" }
    | { kind: "segment"; ed: Editing; from: Vec2; hit: PathHit }
    | { kind: "marquee"; m: Marquee };
  let drag: Drag | null = null;
  let delegated = false;
  let didMove = false;

  return {
    id: "direct-select",
    latestMoveOnly: true,
    cursor: () => penCursor("direct"),
    down(ctx, e) {
      didMove = false;
      const ed = editing(ctx);
      if (!ed) return;
      const p = at(e);
      const grab = tolerance(ctx, GRAB_PX);
      const selected = validRefs(ed.path, ctx.paths.selected);
      if (e.mod && e.alt && (anchorAt(ed.path, p, grab) || handleAt(ed.path, selected, p, grab))) {
        delegated = true;
        return convert.down!(ctx, e);
      }
      const handle = handleAt(ed.path, selected, p, grab);
      if (handle) {
        selectPoints(ctx, ed.target, selected);
        drag = { kind: "handle", ed, ...handle };
        return;
      }
      const whole = (sub: number) => {
        const refs = allAnchors(ed.path, [sub]);
        selectPoints(ctx, ed.target, e.shift ? union(selected, refs) : refs);
        drag = { kind: "anchors", ed, from: p, refs, lead: ed.path.subpaths[sub].knots[0].anchor, click: null, shift: false };
      };
      const ref = anchorAt(ed.path, p, grab);
      if (e.alt) {
        // Alt-click anywhere on a component selects all of it.
        const hit = ref ? ref.sub : (nearestSegment(ed.path, p, grab)?.sub ?? ed.path.subpaths.findLastIndex((s) => pointInSubpath(s, p)));
        if (hit >= 0) return whole(hit);
      }
      if (ref) {
        const isSelected = selected.some((r) => sameRef(r, ref));
        // On a selected point a press may begin dragging the group (a Shift-click toggles it off on release, a plain one narrows to it).
        const next = isSelected ? selected : e.shift ? union(selected, [ref]) : [ref];
        selectPoints(ctx, ed.target, next);
        drag = { kind: "anchors", ed, from: p, refs: [...next], lead: knotOf(ed.path, ref).anchor, click: isSelected ? ref : null, shift: e.shift };
        return;
      }
      const seg = nearestSegment(ed.path, p, grab);
      if (seg) {
        const s = ed.path.subpaths[seg.sub];
        const refs: PointRef[] = [{ sub: seg.sub, knot: seg.seg }, { sub: seg.sub, knot: (seg.seg + 1) % s.knots.length }];
        selectPoints(ctx, ed.target, e.shift ? union(selected, refs) : refs);
        drag = { kind: "segment", ed, from: p, hit: seg };
        return;
      }
      drag = { kind: "marquee", m: { start: p, shift: e.shift, before: selected, ed } };
    },
    move(ctx, e) {
      if (delegated) return convert.move!(ctx, e);
      if (!drag) return;
      const p = at(e);
      switch (drag.kind) {
        case "marquee":
          return showMarquee(ctx, drag.m, e);
        case "handle": {
          const { ed, ref, side } = drag;
          const k = knotOf(ed.path, ref);
          const to = e.shift ? constrain45(k.anchor, ctx.snap.point(p)) : ctx.snap.point(p);
          didMove = true;
          return showPath(ctx, ed, setKnot(ed.path, ref, moveHandle(k, side, to, e.alt ? "break" : "smooth")));
        }
        case "anchors": {
          if (!didMove && !moved(ctx, drag.from, e)) return;
          didMove = true;
          // The dragged point leads: it snaps, and the rest keep their places relative to it.
          const lead = ctx.snap.point(vec(drag.lead.x + (e.shift ? offset(drag.from, p, true).x : p.x - drag.from.x), drag.lead.y + (e.shift ? offset(drag.from, p, true).y : p.y - drag.from.y)));
          return showPath(ctx, drag.ed, moveKnots(drag.ed.path, drag.refs, vec(lead.x - drag.lead.x, lead.y - drag.lead.y)));
        }
        case "segment": {
          if (!didMove && !moved(ctx, drag.from, e)) return;
          didMove = true;
          const { ed, hit } = drag;
          return showPath(ctx, ed, dragSegment(ed.path, hit.sub, hit.seg, hit.t, offset(drag.from, p, e.shift), ctx.settings.pen.constrainDragging));
        }
      }
    },
    up(ctx, e) {
      if (delegated) {
        delegated = false;
        return convert.up!(ctx, e);
      }
      const d = drag;
      drag = null;
      if (!d) return;
      const p = at(e);
      if (d.kind === "marquee") {
        ctx.overlay(null);
        const { m } = d;
        const r = rectFromPoints(m.start, p);
        // A click away from everything deselects (Shift keeps the selection).
        if (r.w * ctx.view.zoom < CLICK_PX && r.h * ctx.view.zoom < CLICK_PX) return selectPoints(ctx, m.ed.target, m.shift ? m.before : []);
        const inside = anchorsIn(m.ed.path, r);
        return selectPoints(ctx, m.ed.target, m.shift ? union(m.before, inside) : inside);
      }
      if (!didMove) {
        ctx.preview(null);
        if (d.kind === "anchors" && d.click) {
          // Released without dragging: Shift toggles the point off, a plain click narrows the selection to it.
          const ref = d.click;
          selectPoints(ctx, d.ed.target, d.shift ? d.refs.filter((r) => !sameRef(r, ref)) : [ref]);
        }
        return;
      }
      const shown = pathAfter(ctx, d, e);
      if (shown) recordPath(ctx, d.kind === "handle" ? "Move Direction Point" : d.kind === "segment" ? "Move Path Segment" : "Move Anchor Points", d.ed, shown);
    },
    cancel(ctx) {
      drag = null;
      delegated = false;
      ctx.overlay(null);
      ctx.preview(null);
    },
    keyDown: (ctx, e) => editKeys(ctx, e, false),
  };

  /** The edited path as the pointer now stands (the same as the last preview). */
  function pathAfter(ctx: ToolContext, d: Exclude<Drag, { kind: "marquee" }>, e: ToolEvent): VectorPath | null {
    const p = at(e);
    switch (d.kind) {
      case "handle": {
        const k = knotOf(d.ed.path, d.ref);
        const to = e.shift ? constrain45(k.anchor, ctx.snap.point(p)) : ctx.snap.point(p);
        return setKnot(d.ed.path, d.ref, moveHandle(k, d.side, to, e.alt ? "break" : "smooth"));
      }
      case "anchors": {
        const o = offset(d.from, p, e.shift);
        const lead = ctx.snap.point(vec(d.lead.x + o.x, d.lead.y + o.y));
        return moveKnots(d.ed.path, d.refs, vec(lead.x - d.lead.x, lead.y - d.lead.y));
      }
      case "segment":
        return dragSegment(d.ed.path, d.hit.sub, d.hit.seg, d.hit.t, offset(d.from, p, e.shift), ctx.settings.pen.constrainDragging);
    }
  }
}

/**
 * The Path Selection tool: click a component (inside it, or on its
 * outline), or drag a marquee over parts of it, to select it whole (Shift
 * adds); drag to move (Shift holds 45°); Alt-drag copies; the arrow keys
 * nudge and Delete removes.
 */
export function createPathSelectTool(): Tool {
  type Drag =
    | { kind: "move"; ed: Editing; from: Vec2; subs: number[]; copy: boolean; click: number | null; shift: boolean }
    | { kind: "marquee"; m: Marquee };
  let drag: Drag | null = null;
  let didMove = false;
  /** The components under the pointer, the front one first. */
  const hitComponent = (ed: Editing, p: Vec2, grab: number) => {
    const seg = nearestSegment(ed.path, p, grab);
    return seg ? seg.sub : ed.path.subpaths.findLastIndex((s) => pointInSubpath(s, p));
  };
  /** The path after a move/copy as the pointer now stands, and which components were moved. */
  const result = (ctx: ToolContext, d: Extract<Drag, { kind: "move" }>, e: ToolEvent) => {
    const o = offset(d.from, at(e), e.shift);
    const lead = ctx.snap.point(vec(d.from.x + o.x, d.from.y + o.y));
    const delta = vec(lead.x - d.from.x, lead.y - d.from.y);
    const base = d.copy ? copySubpaths(d.ed.path, d.subs) : { path: d.ed.path, copies: d.subs };
    return { path: moveSubpaths(base.path, base.copies, delta), moved: base.copies };
  };

  return {
    id: "path-select",
    latestMoveOnly: true,
    cursor: () => penCursor("path"),
    down(ctx, e) {
      didMove = false;
      const ed = editing(ctx);
      if (!ed) return;
      const p = at(e);
      const selected = validRefs(ed.path, ctx.paths.selected);
      const chosen = selectedSubpaths(ed.path, selected);
      const sub = hitComponent(ed, p, tolerance(ctx, GRAB_PX));
      if (sub < 0) {
        drag = { kind: "marquee", m: { start: p, shift: e.shift, before: selected, ed } };
        return;
      }
      const isChosen = chosen.includes(sub);
      const subs = isChosen ? chosen : e.shift ? [...chosen, sub] : [sub];
      selectPoints(ctx, ed.target, allAnchors(ed.path, subs));
      drag = { kind: "move", ed, from: p, subs, copy: e.alt, click: isChosen ? sub : null, shift: e.shift };
    },
    move(ctx, e) {
      if (!drag) return;
      if (drag.kind === "marquee") return showMarquee(ctx, drag.m, e);
      if (!didMove && !moved(ctx, drag.from, e)) return;
      didMove = true;
      showPath(ctx, drag.ed, result(ctx, drag, e).path);
    },
    up(ctx, e) {
      const d = drag;
      drag = null;
      if (!d) return;
      if (d.kind === "marquee") {
        ctx.overlay(null);
        const { m } = d;
        const r = rectFromPoints(m.start, at(e));
        if (r.w * ctx.view.zoom < CLICK_PX && r.h * ctx.view.zoom < CLICK_PX) return selectPoints(ctx, m.ed.target, m.shift ? m.before : []);
        const subs = m.ed.path.subpaths.flatMap((s, i) => (subpathTouchesRect(s, r) ? [i] : []));
        const before = selectedSubpaths(m.ed.path, m.before);
        return selectPoints(ctx, m.ed.target, allAnchors(m.ed.path, m.shift ? [...new Set([...before, ...subs])] : subs));
      }
      if (!didMove) {
        ctx.preview(null);
        // Released without dragging: Shift toggles a selected component off, a plain click narrows the selection to it.
        if (d.click !== null) {
          const keep = d.shift ? d.subs.filter((s) => s !== d.click) : [d.click];
          selectPoints(ctx, d.ed.target, allAnchors(d.ed.path, keep));
        }
        return;
      }
      const r = result(ctx, d, e);
      recordPath(ctx, d.copy ? "Duplicate Path Component" : "Move Path Components", d.ed, r.path);
      selectPoints(ctx, d.ed.target, allAnchors(r.path, r.moved));
    },
    cancel(ctx) {
      drag = null;
      ctx.overlay(null);
      ctx.preview(null);
    },
    keyDown: (ctx, e) => editKeys(ctx, e, true),
  };
}

/**
 * The Convert Point tool: click a smooth point to make it a corner; drag
 * from an anchor point to make it smooth (mirrored direction lines); drag a
 * direction point to move it independently of the other.
 */
export function createConvertPointTool(): Tool {
  type Drag = { ed: Editing; ref: PointRef; from: Vec2; side: "in" | "out" | null };
  let drag: Drag | null = null;
  let didMove = false;
  const edited = (d: Drag, e: ToolEvent) => {
    const k = knotOf(d.ed.path, d.ref);
    const to = e.shift ? constrain45(k.anchor, at(e)) : at(e);
    return d.side ? setKnot(d.ed.path, d.ref, moveHandle(k, d.side, to, "break")) : toSmooth(d.ed.path, d.ref, to);
  };

  return {
    id: "convert-point",
    latestMoveOnly: true,
    cursor: () => penCursor("convert"),
    down(ctx, e) {
      didMove = false;
      const ed = editing(ctx);
      if (!ed) return;
      const p = at(e);
      const grab = tolerance(ctx, GRAB_PX);
      const handle = handleAt(ed.path, validRefs(ed.path, ctx.paths.selected), p, grab);
      if (handle) {
        drag = { ed, ref: handle.ref, from: p, side: handle.side };
        return;
      }
      const ref = anchorAt(ed.path, p, grab);
      if (!ref) return;
      selectPoints(ctx, ed.target, [ref]);
      drag = { ed, ref, from: p, side: null };
    },
    move(ctx, e) {
      if (!drag || (!didMove && !moved(ctx, drag.from, e))) return;
      didMove = true;
      showPath(ctx, drag.ed, edited(drag, e));
    },
    up(ctx, e) {
      const d = drag;
      drag = null;
      if (!d) return;
      if (didMove) return recordPath(ctx, "Convert Point", d.ed, edited(d, e));
      ctx.preview(null);
      // A click turns a point with direction lines into a corner point without them.
      if (!d.side && hasHandles(knotOf(d.ed.path, d.ref))) recordPath(ctx, "Convert Point", d.ed, toCorner(d.ed.path, d.ref));
    },
    cancel(ctx) {
      drag = null;
      ctx.preview(null);
    },
  };
}

/** Adds an anchor point on a segment, keeping its shape; dragging pulls out direction lines on the new point. */
export function createAddAnchorTool(): Tool {
  type Drag = { ed: Editing; path: VectorPath; ref: PointRef; from: Vec2 };
  let drag: Drag | null = null;
  let didMove = false;
  const edited = (d: Drag, e: ToolEvent) => toSmooth(d.path, d.ref, e.shift ? constrain45(knotOf(d.path, d.ref).anchor, at(e)) : at(e));
  return {
    id: "add-anchor",
    latestMoveOnly: true,
    cursor: () => penCursor("plus"),
    down(ctx, e) {
      didMove = false;
      const ed = editing(ctx);
      const hit = ed && nearestSegment(ed.path, at(e), tolerance(ctx, GRAB_PX));
      if (!ed || !hit) return;
      const { path, ref } = insertKnot(ed.path, hit.sub, hit.seg, hit.t);
      selectPoints(ctx, ed.target, [ref]);
      drag = { ed, path, ref, from: at(e) };
      showPath(ctx, ed, path);
    },
    move(ctx, e) {
      if (!drag || (!didMove && !moved(ctx, drag.from, e))) return;
      didMove = true;
      showPath(ctx, drag.ed, edited(drag, e));
    },
    up(ctx, e) {
      const d = drag;
      drag = null;
      if (d) recordPath(ctx, "Add Anchor Point", d.ed, didMove ? edited(d, e) : d.path);
    },
    cancel(ctx) {
      drag = null;
      ctx.preview(null);
    },
  };
}

/** Deletes the anchor point clicked, joining its neighbours with a segment that keeps their direction lines. */
export function createDeleteAnchorTool(): Tool {
  return {
    id: "delete-anchor",
    cursor: () => penCursor("minus"),
    down(ctx, e) {
      const ed = editing(ctx);
      const ref = ed && anchorAt(ed.path, at(e), tolerance(ctx, GRAB_PX));
      if (!ed || !ref) return;
      recordPath(ctx, "Delete Anchor Point", ed, removeKnot(ed.path, ref));
      selectPoints(ctx, ed.target, []);
    },
  };
}

export type PathToolId = Extract<ToolId, "direct-select" | "path-select" | "convert-point" | "add-anchor" | "delete-anchor">;
