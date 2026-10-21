import type { Doc, Guide } from "./document";
import { isEmpty, type Rect, type Vec2 } from "./geometry";
import { contentBounds } from "./tiles";

/**
 * Photoshop's snapping (View ▸ Snap, View ▸ Snap To): a dragged point, or
 * the edges and centre of something being moved, is pulled onto nearby
 * guides, grid lines, other layers' edges and centres, and the document's
 * edges and centre — within {@link SNAP_PX} screen pixels. Each axis snaps
 * independently, to whichever feature is nearest; other layers win only when
 * strictly nearer than a guide, the grid or the document (as in Photopea,
 * whose layer bounds are the least deliberate target).
 */
export const SNAP_PX = 8;

export interface SnapLine {
  /** Position along the axis, in document pixels. */
  readonly at: number;
  readonly kind: "guide" | "grid" | "layer" | "document";
  /** The target's extent across the axis (a layer's or the canvas's), for drawing smart guides. */
  readonly span?: readonly [number, number];
}

/** Everything a drag can snap to, per axis: x holds vertical lines, y horizontal ones. */
export interface SnapTargets {
  readonly x: readonly SnapLine[];
  readonly y: readonly SnapLine[];
  /** Grid spacing (gridline ÷ subdivisions) in document pixels, or null when the grid isn't a target. */
  readonly grid: { readonly x: number; readonly y: number } | null;
}

/** A smart guide to draw: a line at `at` along the axis, from `from` to `to` across it. */
export interface SmartGuide {
  readonly axis: "x" | "y";
  readonly at: number;
  readonly from: number;
  readonly to: number;
}

export interface Snapped {
  /** How far to move what was dragged. */
  readonly dx: number;
  readonly dy: number;
  /** Alignments with layers and the document, for smart guides. */
  readonly guides: readonly SmartGuide[];
}

export const NO_SNAP: Snapped = { dx: 0, dy: 0, guides: [] };

export interface SnapTo {
  readonly guides: boolean;
  readonly grid: { readonly x: number; readonly y: number } | null;
  readonly layers: boolean;
  readonly bounds: boolean;
}

/**
 * The targets in `doc`: its guides, the grid, the edges and centres of its
 * visible layers (except `exclude`, what's being moved) and of the canvas.
 */
export function snapTargets(doc: Doc, to: SnapTo, exclude: readonly string[] = []): SnapTargets {
  const x: SnapLine[] = [], y: SnapLine[] = [];
  const box = (r: Rect, kind: "layer" | "document") => {
    for (const at of [r.x, r.x + r.w / 2, r.x + r.w]) x.push({ at, kind, span: [r.y, r.y + r.h] });
    for (const at of [r.y, r.y + r.h / 2, r.y + r.h]) y.push({ at, kind, span: [r.x, r.x + r.w] });
  };
  if (to.guides) for (const g of doc.guides ?? []) (g.orientation === "vertical" ? x : y).push({ at: g.position, kind: "guide" });
  if (to.bounds) box({ x: 0, y: 0, w: doc.width, h: doc.height }, "document");
  if (to.layers) {
    for (const l of doc.layers) {
      if (!l.visible || exclude.includes(l.id)) continue;
      const b = contentBounds(l.tiles);
      if (!isEmpty(b)) box(b, "layer");
    }
  }
  return { x, y, grid: to.grid };
}

interface AxisMatch {
  readonly delta: number;
  readonly line: SnapLine;
}

/** The nearest target to any of `values` within `tolerance`; layers only when strictly nearest. */
function snapAxis(values: readonly number[], lines: readonly SnapLine[], grid: number | null, tolerance: number): AxisMatch | null {
  let best: AxisMatch | null = null;
  let bestScore = Infinity;
  const consider = (v: number, line: SnapLine) => {
    const d = Math.abs(line.at - v);
    // A hair's handicap: a guide, the grid or the canvas wins a tie with a layer.
    const score = d + (line.kind === "layer" ? 1e-9 : 0);
    if (d <= tolerance && score < bestScore) [best, bestScore] = [{ delta: line.at - v, line }, score];
  };
  for (const v of values) {
    for (const line of lines) consider(v, line);
    if (grid) consider(v, { at: Math.round(v / grid) * grid, kind: "grid" });
  }
  return best;
}

/**
 * Snaps the features `xs` and `ys` (a point's coordinates, or a box's
 * edges and centre) of something spanning `extent` (its box: where smart
 * guides start from).
 */
export function snap(xs: readonly number[], ys: readonly number[], extent: Rect, t: SnapTargets, tolerance: number): Snapped {
  const mx = snapAxis(xs, t.x, t.grid?.x ?? null, tolerance);
  const my = snapAxis(ys, t.y, t.grid?.y ?? null, tolerance);
  const dx = mx?.delta ?? 0, dy = my?.delta ?? 0;
  const guides: SmartGuide[] = [];
  // Smart guides join what moved (where it lands) to what it aligned with.
  const guide = (axis: "x" | "y", m: AxisMatch | null, lo: number, hi: number) => {
    if (!m || !m.line.span) return;
    guides.push({ axis, at: m.line.at, from: Math.min(lo, m.line.span[0]), to: Math.max(hi, m.line.span[1]) });
  };
  guide("x", mx, extent.y + dy, extent.y + extent.h + dy);
  guide("y", my, extent.x + dx, extent.x + extent.w + dx);
  return { dx, dy, guides };
}

export const snapPoint = (p: Vec2, t: SnapTargets, tolerance: number): Snapped => snap([p.x], [p.y], { x: p.x, y: p.y, w: 0, h: 0 }, t, tolerance);

/** Snaps a moving box by its edges and centre. */
export const snapRect = (r: Rect, t: SnapTargets, tolerance: number): Snapped =>
  snap([r.x, r.x + r.w / 2, r.x + r.w], [r.y, r.y + r.h / 2, r.y + r.h], r, t, tolerance);

/**
 * Guides through a change to the document's space (a row-major 3×3): they
 * follow scales and translations, and quarter turns (swapping orientation);
 * any other rotation or perspective would tilt them, so they're dropped.
 */
export function transformGuides(guides: readonly Guide[] | undefined, m: readonly number[]): Guide[] | undefined {
  if (!guides?.length) return undefined;
  const [a, b, c, d, e, f, g, h, i] = m.map((v) => v / m[8]);
  const zero = (v: number) => Math.abs(v) < 1e-12;
  if (!zero(g) || !zero(h) || i === 0) return undefined;
  if (zero(b) && zero(d)) return guides.map((gd) => ({ ...gd, position: gd.orientation === "vertical" ? a * gd.position + c : e * gd.position + f }));
  // x' = b·y + c, y' = d·x + f: a vertical guide x = p becomes horizontal at d·p + f, and vice versa.
  if (zero(a) && zero(e))
    return guides.map((gd) =>
      gd.orientation === "vertical" ? { orientation: "horizontal", position: d * gd.position + f } : { orientation: "vertical", position: b * gd.position + c },
    );
  return undefined;
}
