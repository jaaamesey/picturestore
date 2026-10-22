import type { Doc } from "../../core/document";
import { vec, type Vec2 } from "../../core/geometry";
import {
  EMPTY_PATH,
  activeEndpoint,
  addSubpath,
  anchorAt,
  closeSubpath,
  cornerKnot,
  extend,
  handleAt,
  isEndpoint,
  joinEnds,
  moveHandle,
  nearestSegment,
  removeKnot,
  reverseKnots,
  sameRef,
  setKnot,
  smoothKnot,
  type Knot,
  type PointRef,
  type VectorPath,
} from "../../core/path";
import type { PathTarget, Tool, ToolContext, ToolEvent } from "../types";
import { penCursor, type PenCursor } from "./cursors";
import { CLICK_PX, commitPath, constrain45, endPenPath, newShapeLayer, penEditing, recordPath, selectPoints, tolerance, validRefs, withPath, type Editing } from "./pathEdit";
import { createAddAnchorTool, createConvertPointTool, createDirectSelectTool } from "./pathTools";

/** How near the pointer must be to take hold of an anchor point or segment, in screen pixels. */
const GRAB_PX = 6;
const LABEL = "Pen Tool";

const at = (e: { x: number; y: number }): Vec2 => vec(e.x, e.y);

type What =
  /** Ctrl: the Direct Selection tool. */
  | { kind: "direct" }
  /** Alt over an anchor or direction point: the Convert Point tool. */
  | { kind: "convert" }
  /** The path's other end: closes it. */
  | { kind: "close"; ed: Editing; active: PointRef; end: PointRef }
  /** The selected end point: click removes its direction line on the open side, drag pulls one out. */
  | { kind: "pull"; ed: Editing; ref: PointRef }
  /** The end of another open path: joins them. */
  | { kind: "connect"; ed: Editing; active: PointRef; end: PointRef }
  /** An end of an open path, none selected: continue from it. */
  | { kind: "continue"; ed: Editing; end: PointRef }
  /** Auto Add/Delete: an anchor point goes. */
  | { kind: "delete"; ed: Editing; ref: PointRef }
  /** Auto Add/Delete: a segment gets an anchor point. */
  | { kind: "add" }
  /** Anywhere else: a new anchor point. */
  | { kind: "place"; ed: Editing | null; active: PointRef | null };

/** What a press at `e` does — the same question the cursor asks. */
function classify(ctx: ToolContext, e: ToolEvent): What {
  if (e.mod) return { kind: "direct" };
  const ed = penEditing(ctx);
  if (!ed) return { kind: "place", ed, active: null };
  const p = at(e);
  const grab = tolerance(ctx, GRAB_PX);
  const selected = validRefs(ed.path, ctx.paths.selected);
  const active = activeEndpoint(ed.path, selected);
  const ref = anchorAt(ed.path, p, grab);
  if (e.alt && (ref || handleAt(ed.path, selected, p, grab))) return { kind: "convert" };
  if (ref) {
    const open = isEndpoint(ed.path, ref);
    if (active) {
      if (sameRef(ref, active)) return { kind: "pull", ed, ref };
      if (open && ref.sub === active.sub) return { kind: "close", ed, active, end: ref };
      if (open) return { kind: "connect", ed, active, end: ref };
    } else if (open) return { kind: "continue", ed, end: ref };
    if (ctx.settings.pen.autoAddDelete) return { kind: "delete", ed, ref };
  } else if (ctx.settings.pen.autoAddDelete && nearestSegment(ed.path, p, grab)) return { kind: "add" };
  return { kind: "place", ed, active };
}

const CURSORS: Partial<Record<What["kind"], PenCursor>> = { close: "close", pull: "slash", connect: "connect", continue: "continue", delete: "minus", add: "plus", convert: "convert", direct: "direct" };

const reversed = (path: VectorPath, sub: number): VectorPath => ({ subpaths: path.subpaths.map((s, i) => (i === sub ? { ...s, knots: reverseKnots(s.knots) } : s)) });

type Gesture =
  | {
      kind: "place";
      /** The document the path goes into (with the new shape layer, if the press made one). */
      doc: Doc;
      target: PathTarget;
      /** The path with the new anchor point as a corner point. */
      path: VectorPath;
      ref: PointRef;
      from: Vec2;
      closing: boolean;
      /** The direction line left where it was when Alt was pressed. */
      frozenIn: Vec2 | null;
      knot: Knot | null;
    }
  | { kind: "pull"; ed: Editing; ref: PointRef; side: "in" | "out"; from: Vec2; knot: Knot | null };

/**
 * The Pen tool. Clicking adds a corner point and dragging a smooth point
 * with mirrored direction lines (Shift holds 45°; Alt, pressed while
 * dragging, leaves the direction line behind to break them). Click the
 * first point to close the path (drag to curve it); click an end of an open
 * path to continue it, or another's to join them; click the selected end
 * point to drop its direction line, or drag from it to pull one out. With
 * Auto Add/Delete, a segment gets an anchor point and an anchor point goes.
 * Ctrl is the Direct Selection tool and Alt the Convert Point tool.
 */
export function createPenTool(): Tool {
  const direct = createDirectSelectTool();
  const convert = createConvertPointTool();
  const addAnchor = createAddAnchorTool();
  let delegate: Tool | null = null;
  let gesture: Gesture | null = null;

  const placeKnot = (g: Extract<Gesture, { kind: "place" }>, e: ToolEvent): Knot => {
    const anchor = g.path.subpaths[g.ref.sub].knots[g.ref.knot].anchor;
    const to = e.shift ? constrain45(anchor, at(e)) : at(e);
    const mirrored = smoothKnot(anchor, to);
    if (!e.alt) return (g.frozenIn = null), mirrored;
    g.frozenIn ??= g.knot?.in ?? mirrored.in;
    return { anchor, in: g.frozenIn, out: to, smooth: false };
  };

  function place(ctx: ToolContext, e: ToolEvent, ed: Editing | null, active: PointRef | null): Gesture {
    const { settings } = ctx;
    const op = settings.pen.op === "new" ? "combine" : settings.pen.op;
    let anchor = ctx.snap.point(at(e));
    let doc = ctx.doc;
    let target: PathTarget;
    let path: VectorPath;
    let sub: number;
    if (ed && active) {
      // Continues from the selected end: a path whose start it is gets turned round to make that the last point.
      const base = active.knot === 0 && ed.path.subpaths[active.sub].knots.length > 1 ? reversed(ed.path, active.sub) : ed.path;
      const prev = base.subpaths[active.sub].knots.at(-1)!.anchor;
      if (e.shift) anchor = constrain45(prev, anchor);
      target = ed.target;
      path = extend(base, active.sub, cornerKnot(anchor));
      sub = active.sub;
    } else {
      // A shape layer for each new shape (Shape mode, "New Layer"); else a component added to the path being edited.
      const newLayer = settings.pen.mode === "shape" && (!ed || settings.pen.op === "new");
      const base = newLayer ? EMPTY_PATH : (ed?.path ?? ctx.doc.workPath ?? EMPTY_PATH);
      path = addSubpath(base, cornerKnot(anchor), base.subpaths.length ? op : "combine");
      sub = path.subpaths.length - 1;
      if (newLayer) {
        // Its first segment can't be seen until the next click.
        const made = newShapeLayer(ctx, path)!;
        doc = made.doc;
        target = { kind: "layer", layerId: made.layerId };
      } else target = ed?.target ?? { kind: "work" };
    }
    return { kind: "place", doc, target, path, ref: { sub, knot: path.subpaths[sub].knots.length - 1 }, from: anchor, closing: false, frozenIn: null, knot: null };
  }

  function close(ctx: ToolContext, ed: Editing, active: PointRef): Gesture {
    const base = active.knot === 0 && ed.path.subpaths[active.sub].knots.length > 1 ? reversed(ed.path, active.sub) : ed.path;
    const path = closeSubpath(base, active.sub);
    const ref = { sub: active.sub, knot: 0 };
    return { kind: "place", doc: ctx.doc, target: ed.target, path, ref, from: path.subpaths[ref.sub].knots[0].anchor, closing: true, frozenIn: null, knot: null };
  }

  const show = (ctx: ToolContext, g: Extract<Gesture, { kind: "place" }>, path: VectorPath) => ctx.preview(withPath(g.doc, g.target, path));

  return {
    id: "pen",
    latestMoveOnly: true,
    cursor: (ctx, e) => penCursor(e ? (CURSORS[classify(ctx, e).kind] ?? "pen") : "pen"),
    down(ctx, e) {
      gesture = delegate = null;
      const what = classify(ctx, e);
      switch (what.kind) {
        case "direct":
          return (delegate = direct).down!(ctx, e);
        case "convert":
          return (delegate = convert).down!(ctx, e);
        case "add":
          return (delegate = addAnchor).down!(ctx, e);
        case "delete":
          recordPath(ctx, "Delete Anchor Point", what.ed, removeKnot(what.ed.path, what.ref));
          return selectPoints(ctx, what.ed.target, []);
        case "continue":
          return selectPoints(ctx, what.ed.target, [what.end]);
        case "connect": {
          const joined = joinEnds(what.ed.path, what.active, what.end);
          recordPath(ctx, LABEL, what.ed, joined.path);
          return selectPoints(ctx, what.ed.target, []);
        }
        case "pull": {
          const first = what.ref.knot === 0 && what.ed.path.subpaths[what.ref.sub].knots.length > 1;
          return void (gesture = { kind: "pull", ed: what.ed, ref: what.ref, side: first ? "in" : "out", from: at(e), knot: null });
        }
        case "close":
          return void (gesture = close(ctx, what.ed, what.active));
        case "place":
          gesture = place(ctx, e, what.ed, what.active);
          if (gesture.kind === "place") show(ctx, gesture, gesture.path);
      }
    },
    move(ctx, e) {
      if (delegate) return delegate.move?.(ctx, e);
      const g = gesture;
      if (!g || Math.hypot(e.x - g.from.x, e.y - g.from.y) * ctx.view.zoom < CLICK_PX) return;
      if (g.kind === "pull") {
        const k0 = g.ed.path.subpaths[g.ref.sub].knots[g.ref.knot];
        g.knot = moveHandle(k0, g.side, e.shift ? constrain45(k0.anchor, at(e)) : at(e), "break");
        return ctx.preview(withPath(ctx.doc, g.ed.target, { subpaths: g.ed.path.subpaths.map((s, i) => (i === g.ref.sub ? { ...s, knots: s.knots.map((k, j) => (j === g.ref.knot ? g.knot! : k)) } : s)) }));
      }
      g.knot = placeKnot(g, e);
      show(ctx, g, setKnot(g.path, g.ref, g.knot));
    },
    up(ctx, e) {
      if (delegate) {
        const d = delegate;
        delegate = null;
        return d.up?.(ctx, e);
      }
      const g = gesture;
      gesture = null;
      if (!g) return;
      if (g.kind === "pull") {
        const { ed, ref, side } = g;
        const k = ed.path.subpaths[ref.sub].knots[ref.knot];
        // A click drops the direction line on the open side (if there is one); a drag has set it.
        const next = g.knot ?? (k[side].x !== k.anchor.x || k[side].y !== k.anchor.y ? { ...k, [side]: k.anchor, smooth: false } : null);
        if (!next) return ctx.preview(null);
        return recordPath(ctx, LABEL, ed, setKnot(ed.path, ref, next));
      }
      const path = g.knot ? setKnot(g.path, g.ref, g.knot) : g.path;
      commitPath(ctx, LABEL, withPath(g.doc, g.target, path), g.target);
      // A closed path is done: the next click starts another.
      selectPoints(ctx, g.target, g.closing ? [] : [g.ref]);
    },
    cancel(ctx) {
      if (delegate || gesture) {
        delegate?.cancel?.(ctx);
        delegate = gesture = null;
        return ctx.preview(null);
      }
      endPenPath(ctx);
    },
    commit: (ctx) => endPenPath(ctx),
  };

}
