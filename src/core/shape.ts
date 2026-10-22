import type { RGB } from "./color";
import { rasterizeContours, type Coverage } from "./coverage";
import { isEmpty, rect, union, vec, type Rect, type Vec2 } from "./geometry";
import { blendColorSpan } from "./document";
import { NO_PIXELS, tileWriter, writeSpans, type Pixels } from "./pixels";
import { mapPoint, squareToQuad, type Mapping } from "./warp";
import { corner, flattenContours, flattenKnots, type Knot } from "./bezier";
import { combineAreas, type PathOp, type VectorPath } from "./path";

export { corner, flattenContours, type Knot };

/**
 * Live shapes, as made by Photoshop's shape tools. Geometry is defined in the
 * layer's source box and rendered through the layer's placement mapping, so
 * transforms stay exact (no resampling) and strokes keep their width.
 */
export type ShapeGeometry =
  | { readonly kind: "rectangle"; readonly radius: number }
  | { readonly kind: "ellipse" }
  | { readonly kind: "triangle" }
  /** `starRatio` is the inner/outer radius ratio: 1 = a regular polygon (Photoshop's "Star Ratio 100%"). */
  | { readonly kind: "polygon"; readonly sides: number; readonly starRatio: number }
  /** A bar filling the box; the box's height is the line's weight. */
  | { readonly kind: "line" }
  /**
   * Arbitrary Bézier components in source-box coordinates (drawn with the Pen tools, or imported from PSD):
   * each combined with the ones before it by its operation (default combine), and open or closed (default
   * closed; an open one is filled as if closed, and stroked as a line).
   */
  | {
      readonly kind: "path";
      readonly contours: readonly (readonly Knot[])[];
      readonly ops?: readonly PathOp[];
      readonly open?: readonly boolean[];
    };

export type StrokeAlign = "inside" | "center" | "outside";

export interface ShapeStyle {
  readonly fill: RGB | null;
  readonly stroke: { readonly color: RGB; readonly width: number; readonly align: StrokeAlign } | null;
}

/** Control-point distance for a quarter-circle cubic arc. */
const KAPPA = 0.5522847498307936;

/** Closed Bézier contours for a shape in its source box. */
export function shapeContours(g: ShapeGeometry, box: Rect): Knot[][] {
  const { x, y, w, h } = box;
  switch (g.kind) {
    case "rectangle": {
      const r = Math.max(0, Math.min(g.radius, w / 2, h / 2));
      if (r <= 0) return [[corner(vec(x, y)), corner(vec(x + w, y)), corner(vec(x + w, y + h)), corner(vec(x, y + h))]];
      const k = r * KAPPA;
      const arcEnd = (a: Vec2, inDir: Vec2): Knot => ({ anchor: a, in: vec(a.x + inDir.x * k, a.y + inDir.y * k), out: a });
      const arcStart = (a: Vec2, outDir: Vec2): Knot => ({ anchor: a, in: a, out: vec(a.x + outDir.x * k, a.y + outDir.y * k) });
      return [
        [
          arcEnd(vec(x + r, y), vec(-1, 0)), // end of top-left corner arc
          arcStart(vec(x + w - r, y), vec(1, 0)),
          arcEnd(vec(x + w, y + r), vec(0, -1)),
          arcStart(vec(x + w, y + h - r), vec(0, 1)),
          arcEnd(vec(x + w - r, y + h), vec(1, 0)),
          arcStart(vec(x + r, y + h), vec(-1, 0)),
          arcEnd(vec(x, y + h - r), vec(0, 1)),
          arcStart(vec(x, y + r), vec(0, -1)),
        ],
      ];
    }
    case "ellipse": {
      const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2, kx = rx * KAPPA, ky = ry * KAPPA;
      return [
        [
          { anchor: vec(cx, y), in: vec(cx - kx, y), out: vec(cx + kx, y) },
          { anchor: vec(x + w, cy), in: vec(x + w, cy - ky), out: vec(x + w, cy + ky) },
          { anchor: vec(cx, y + h), in: vec(cx + kx, y + h), out: vec(cx - kx, y + h) },
          { anchor: vec(x, cy), in: vec(x, cy + ky), out: vec(x, cy - ky) },
        ],
      ];
    }
    case "triangle":
      return [[corner(vec(x + w / 2, y)), corner(vec(x + w, y + h)), corner(vec(x, y + h))]];
    case "polygon": {
      const n = Math.max(3, Math.round(g.sides));
      const cx = x + w / 2, cy = y + h / 2;
      const ratio = Math.max(0.01, Math.min(1, g.starRatio));
      const pts: Knot[] = [];
      for (let i = 0; i < n; i++) {
        const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
        pts.push(corner(vec(cx + (w / 2) * Math.cos(a), cy + (h / 2) * Math.sin(a))));
        if (ratio < 1) {
          const b = a + Math.PI / n;
          pts.push(corner(vec(cx + (w / 2) * ratio * Math.cos(b), cy + (h / 2) * ratio * Math.sin(b))));
        }
      }
      return [pts];
    }
    case "line":
      return [[corner(vec(x, y)), corner(vec(x + w, y)), corner(vec(x + w, y + h)), corner(vec(x, y + h))]];
    case "path":
      return g.contours.map((c) => [...c]);
  }
}

const signedArea = (poly: readonly Vec2[]) => {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
};

/** Orients a polygon clockwise-positive so overlapping pieces union under non-zero winding. */
const positive = (poly: Vec2[]) => (signedArea(poly) < 0 ? poly.reverse() : poly);

const MITER_LIMIT = 4;

/**
 * Polygons whose union is a centred stroke of `width` around closed contours:
 * one quad per edge plus a miter (or bevel, past the limit) wedge per vertex.
 */
export function strokePolygons(contours: readonly (readonly Vec2[])[], width: number, open: readonly boolean[] = []): Vec2[][] {
  const hw = width / 2;
  const out: Vec2[][] = [];
  for (const [ci, raw] of contours.entries()) {
    const isOpen = !!open[ci];
    // Drop zero-length edges so normals are defined.
    const pts = raw.filter((p, i) => {
      const q = raw[(i + 1) % raw.length];
      return Math.hypot(q.x - p.x, q.y - p.y) > 1e-9;
    });
    const n = pts.length;
    if (n < 2) continue;
    const normals = pts.map((p, i) => {
      const q = pts[(i + 1) % n];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      return vec((-(q.y - p.y) / len) * hw, ((q.x - p.x) / len) * hw);
    });
    // An open line has no edge from its last point back to its first, and no join at either end.
    const edgeCount = isOpen ? n - 1 : n;
    for (let i = 0; i < edgeCount; i++) {
      const a = pts[i], b = pts[(i + 1) % n], nm = normals[i];
      out.push(positive([vec(a.x + nm.x, a.y + nm.y), vec(b.x + nm.x, b.y + nm.y), vec(b.x - nm.x, b.y - nm.y), vec(a.x - nm.x, a.y - nm.y)]));
      if (isOpen && i + 1 >= edgeCount) continue;
      // Join at b between edge i and edge i+1, on both sides (the inner wedge is harmless and covered anyway).
      const n1 = normals[(i + 1) % n];
      for (const side of [1, -1]) {
        const e0 = vec(b.x + nm.x * side, b.y + nm.y * side);
        const e1 = vec(b.x + n1.x * side, b.y + n1.y * side);
        const bis = vec(nm.x + n1.x, nm.y + n1.y);
        const bl = Math.hypot(bis.x, bis.y);
        const cosHalf = bl / (2 * hw);
        if (cosHalf > 1e-6 && 1 / cosHalf <= MITER_LIMIT) {
          const tip = vec(b.x + (bis.x / bl) * (hw / cosHalf) * side, b.y + (bis.y / bl) * (hw / cosHalf) * side);
          out.push(positive([b, e0, tip, e1]));
        } else {
          out.push(positive([b, e0, e1]));
        }
      }
    }
  }
  return out;
}

/** Composites `color` with per-pixel `coverage` over `pixels`. */
function paintCoverage(pixels: Pixels, c: Coverage, color: RGB): Pixels {
  const w = tileWriter(pixels);
  const { region, data } = c;
  const covered = (part: Rect) => {
    for (let y = part.y; y < part.y + part.h; y++)
      for (let x = part.x; x < part.x + part.w; x++) if (data[(y - region.y) * region.w + (x - region.x)]) return true;
    return false;
  };
  writeSpans(
    w,
    region,
    (d, i, x, y, n) => blendColorSpan(d, i, n, color, 1, data, (y - region.y) * region.w + (x - region.x)),
    { wanted: covered },
  );
  return w.finish();
}

/**
 * Anti-aliasing as Photoshop's type offers it, as a curve on exact-area
 * coverage: None thresholds it; Sharp and Crisp steepen it (Sharp more);
 * Strong thickens; Smooth leaves it. The platform methods draw like Sharp.
 * Shapes are always Smooth.
 */
export const ANTI_ALIAS = { smooth: 0, none: 1, sharp: 2, crisp: 3, strong: 4 } as const;
export type AntiAliasCode = (typeof ANTI_ALIAS)[keyof typeof ANTI_ALIAS];

/** The coverage curve (shared with the GPU rasterizer's WGSL; keep in sync). */
export function antiAlias(aa: AntiAliasCode, c: number): number {
  switch (aa) {
    case ANTI_ALIAS.none:
      return c >= 0.5 ? 1 : 0;
    case ANTI_ALIAS.sharp:
      return Math.min(1, Math.max(0, (c - 0.5) * 1.6 + 0.5));
    case ANTI_ALIAS.crisp:
      return Math.min(1, Math.max(0, (c - 0.5) * 1.3 + 0.5));
    case ANTI_ALIAS.strong:
      return 1 - (1 - c) ** 1.8;
    default:
      return c;
  }
}

const aaTables = new Map<number, Uint8Array>();
function applyAntiAlias(c: Coverage | null, aa: AntiAliasCode): Coverage | null {
  if (!c || aa === ANTI_ALIAS.smooth) return c;
  let lut = aaTables.get(aa);
  if (!lut) aaTables.set(aa, (lut = Uint8Array.from({ length: 256 }, (_, i) => Math.round(antiAlias(aa, i / 255) * 255))));
  return { region: c.region, data: c.data.map((v) => lut![v]) };
}

/**
 * Vector art as the rasterizers take it: paints composited in order, each a
 * fill and a stroke (clipped against the fill for inside and outside
 * alignment) in document space.
 */
export interface VectorPaint {
  readonly fill: readonly (readonly Vec2[])[];
  readonly stroke: readonly (readonly Vec2[])[];
  readonly strokeMode: (typeof STROKE_MODES)[keyof typeof STROKE_MODES];
  readonly fillColor: RGB | null;
  readonly strokeColor: RGB | null;
  readonly aa: AntiAliasCode;
}

export interface VectorDrawing {
  readonly paints: readonly VectorPaint[];
  /** What it can touch, in document space. */
  readonly bounds: Rect;
}

/** Draws vector art over `pixels` on the CPU (the GPU rasterizer's reference), clipped to `clip`. */
export function renderDrawing(d: VectorDrawing, clip: Rect, pixels: Pixels = NO_PIXELS): Pixels {
  for (const p of d.paints) {
    const fill = applyAntiAlias(rasterizeContours(p.fill, clip), p.aa);
    if (p.fillColor && fill) pixels = paintCoverage(pixels, fill, p.fillColor);
    if (!p.strokeColor || p.strokeMode === STROKE_MODES.none) continue;
    const stroke = applyAntiAlias(rasterizeContours(p.stroke, clip), p.aa);
    if (!stroke) continue;
    if (p.strokeMode === STROKE_MODES.center) {
      pixels = paintCoverage(pixels, stroke, p.strokeColor);
      continue;
    }
    // Inside and outside strokes: a doubled centre stroke, clipped by the fill.
    const f = (x: number, y: number) => {
      if (!fill) return 0;
      const lx = x - fill.region.x, ly = y - fill.region.y;
      return lx < 0 || ly < 0 || lx >= fill.region.w || ly >= fill.region.h ? 0 : fill.data[ly * fill.region.w + lx];
    };
    const r = stroke.region;
    const clipped = new Uint8Array(stroke.data.length);
    for (let y = 0; y < r.h; y++)
      for (let x = 0; x < r.w; x++) {
        const i = y * r.w + x;
        const fv = f(r.x + x, r.y + y);
        clipped[i] = p.strokeMode === STROKE_MODES.inside ? (stroke.data[i] * fv) / 255 : (stroke.data[i] * (255 - fv)) / 255;
      }
    pixels = paintCoverage(pixels, { region: r, data: clipped }, p.strokeColor);
  }
  return pixels;
}

/** Point mapper from a source box into the document through a mapping. */
export function boxMapper(m: Mapping): (p: Vec2) => Vec2 {
  const { x, y, w, h } = m.source;
  return (p) => mapPoint(m, (p.x - x) / w, (p.y - y) / h);
}

/**
 * Document-space polygons of a shape's outline: its area, with a path's
 * operations applied (components oriented so overlapping ones unite).
 */
export function shapeOutline(g: ShapeGeometry, m: Mapping): Vec2[][] {
  const map = boxMapper(m);
  if (g.kind !== "path") return flattenContours(shapeContours(g, m.source), map);
  return combineAreas(
    g.contours.map((c) => flattenKnots(c, true, map)).filter((p) => p.length >= 3),
    g.contours.flatMap((c, i) => (flattenKnots(c, true).length >= 3 ? [g.ops?.[i] ?? "combine"] : [])),
  );
}

/** The open components of a path shape, flattened into document space (they're stroked as lines). */
export function shapeLines(g: ShapeGeometry, m: Mapping): Vec2[][] {
  if (g.kind !== "path" || !g.open) return [];
  const map = boxMapper(m);
  return g.contours.flatMap((c, i) => (g.open![i] && c.length >= 2 ? [flattenKnots(c, false, map)] : []));
}

/** Coverage of a shape's fill (no stroke), clipped to `clip`. */
export const fillCoverage = (g: ShapeGeometry, m: Mapping, clip: Rect) => rasterizeContours(shapeOutline(g, m), clip);

/** A shape as vector art: its fill, then its stroke over it. */
export function shapeDrawing(g: ShapeGeometry, style: ShapeStyle, m: Mapping): VectorDrawing {
  const outline = shapeOutline(g, m);
  const lines = shapeLines(g, m);
  const s = style.stroke && style.stroke.width > 0 ? style.stroke : null;
  // Closed components are stroked along their outline; open ones as lines.
  const closedOutline = lines.length ? shapeOutlineOf(g, m, true) : outline;
  const width = s ? (s.align === "center" ? s.width : s.width * 2) : 0;
  return {
    paints: [
      {
        fill: outline,
        // Inside/outside strokes are a doubled centre stroke clipped by the fill.
        stroke: s ? [...strokePolygons(closedOutline, width), ...strokePolygons(lines, width, lines.map(() => true))] : [],
        strokeMode: s ? STROKE_MODES[s.align] : STROKE_MODES.none,
        fillColor: style.fill,
        strokeColor: s?.color ?? null,
        aa: ANTI_ALIAS.smooth,
      },
    ],
    bounds: shapeBounds(g, style, m),
  };
}

/** A path shape's outline from its closed components only. */
function shapeOutlineOf(g: ShapeGeometry, m: Mapping, closedOnly: boolean): Vec2[][] {
  if (g.kind !== "path" || !closedOnly) return shapeOutline(g, m);
  const map = boxMapper(m);
  const keep = g.contours.map((c, i) => !g.open?.[i] && c.length >= 3);
  return combineAreas(
    g.contours.flatMap((c, i) => (keep[i] ? [flattenKnots(c, true, map)] : [])),
    g.contours.flatMap((_, i) => (keep[i] ? [g.ops?.[i] ?? "combine"] : [])),
  );
}

/**
 * Renders a shape layer's pixels (fill, then stroke over it), clipped to
 * `clip` — the canvas: the vector is the source of truth, so nothing outside
 * it needs caching.
 */
export const renderShape = (g: ShapeGeometry, style: ShapeStyle, m: Mapping, clip: Rect): Pixels => renderDrawing(shapeDrawing(g, style, m), clip);

/** Document-space bounds a rendered shape can touch (outline plus stroke). */
export function shapeBounds(g: ShapeGeometry, style: ShapeStyle, m: Mapping): Rect {
  let b = rect(0, 0, 0, 0);
  for (const poly of shapeOutline(g, m)) for (const p of poly) b = union(b, rect(p.x, p.y, 0.001, 0.001));
  const pad = style.stroke && style.stroke.align !== "inside" ? style.stroke.width * MITER_LIMIT : 0;
  return isEmpty(b) ? b : rect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
}

/**
 * Contours in document space as Bézier knots, for PSD vector masks. Affine
 * placements transform control points exactly; perspective and warp fall back
 * to the flattened outline.
 */
export function documentKnots(g: ShapeGeometry, m: Mapping): Knot[][] {
  const H = squareToQuad(m.quad);
  const affine = !m.patch && H && Math.abs(H[6]) < 1e-12 && Math.abs(H[7]) < 1e-12;
  const map = boxMapper(m);
  if (!affine) {
    // Flattened, component by component (a path keeps its components, open ones included).
    if (g.kind === "path") return g.contours.map((c, i) => flattenKnots(c, !g.open?.[i], map).map(corner));
    return shapeOutline(g, m).map((poly) => poly.map(corner));
  }
  return shapeContours(g, m.source).map((c) => c.map((k) => ({ anchor: map(k.anchor), in: map(k.in), out: map(k.out) })));
}

/**
 * A path shape's components in document space, with their operations and
 * whether each is open — what the Pen tools edit. Like {@link documentKnots}
 * but for any shape (other shapes' outlines are closed combine components).
 */
export function documentPath(g: ShapeGeometry, m: Mapping): VectorPath {
  const contours = documentKnots(g, m);
  return {
    subpaths: contours.map((knots, i) => ({
      knots,
      closed: !(g.kind === "path" && g.open?.[i]),
      op: (g.kind === "path" && g.ops?.[i]) || "combine",
    })),
  };
}

/** How a stroke is clipped against the fill: none (no stroke), centred, inside or outside. */
export const STROKE_MODES = { none: 0, center: 1, inside: 2, outside: 3 } as const;

/** One paint as line segments for the GPU rasterizer (`gpu/vector.ts`): coordinates are document space × `scale`. */
export interface PaintSegments {
  /** x0, y0, x1, y1 per edge of the fill outline (always present: inside/outside strokes clip against it). */
  readonly fill: Float32Array;
  readonly stroke: Float32Array;
  readonly strokeMode: (typeof STROKE_MODES)[keyof typeof STROKE_MODES];
  /** Straight RGBA in [0, 1]; alpha 0 when absent. */
  readonly fillColor: readonly [number, number, number, number];
  readonly strokeColor: readonly [number, number, number, number];
  readonly aa: AntiAliasCode;
}

/**
 * Vector art for the GPU rasterizer, which implements the same exact-area
 * coverage as {@link rasterizeContours} and composites paints as
 * {@link renderDrawing} does.
 */
export interface DrawingSegments {
  readonly paints: readonly PaintSegments[];
  /** What it can touch, in document space. */
  readonly bounds: Rect;
}

function edges(polys: readonly (readonly Vec2[])[], scale: number): Float32Array {
  let n = 0;
  for (const p of polys) if (p.length >= 3) n += p.length;
  const out = new Float32Array(n * 4);
  let i = 0;
  for (const p of polys) {
    if (p.length < 3) continue;
    for (let k = 0; k < p.length; k++) {
      const a = p[k], b = p[(k + 1) % p.length];
      out[i++] = a.x * scale;
      out[i++] = a.y * scale;
      out[i++] = b.x * scale;
      out[i++] = b.y * scale;
    }
  }
  return out;
}

const rgba = (c: RGB | null | undefined) => (c ? ([c.r / 255, c.g / 255, c.b / 255, 1] as const) : ([0, 0, 0, 0] as const));

export const drawingSegments = (d: VectorDrawing, scale = 1): DrawingSegments => ({
  paints: d.paints.map((p) => ({
    fill: edges(p.fill, scale),
    stroke: edges(p.stroke, scale),
    strokeMode: p.strokeColor ? p.strokeMode : STROKE_MODES.none,
    fillColor: rgba(p.fillColor),
    strokeColor: rgba(p.strokeColor),
    aa: p.aa,
  })),
  bounds: d.bounds,
});

export const shapeSegments = (g: ShapeGeometry, style: ShapeStyle, m: Mapping, scale = 1) => drawingSegments(shapeDrawing(g, style, m), scale);
