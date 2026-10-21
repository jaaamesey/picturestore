import type { RGB } from "./color";
import { rasterizeContours, type Coverage } from "./coverage";
import { isEmpty, rect, union, vec, type Rect, type Vec2 } from "./geometry";
import { EMPTY_TILES, tileWriter, writeSpans, type TileMap } from "./tiles";
import { mapPoint, squareToQuad, type Mapping } from "./warp";

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
  /** Arbitrary Bézier contours in source-box coordinates (e.g. imported from PSD). */
  | { readonly kind: "path"; readonly contours: readonly (readonly Knot[])[] };

export type StrokeAlign = "inside" | "center" | "outside";

export interface ShapeStyle {
  readonly fill: RGB | null;
  readonly stroke: { readonly color: RGB; readonly width: number; readonly align: StrokeAlign } | null;
}

/** A Bézier knot: the anchor and its incoming/outgoing control points (equal to the anchor for corners). */
export interface Knot {
  readonly anchor: Vec2;
  readonly in: Vec2;
  readonly out: Vec2;
}

const corner = (p: Vec2): Knot => ({ anchor: p, in: p, out: p });
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

const FLATNESS = 0.1; // maximum chord deviation, document pixels

/**
 * Flattens closed Bézier contours into polygons in document space. Curves are
 * subdivided until their *mapped* control polygon is within {@link FLATNESS}
 * of its chord, so the tolerance holds after scaling and perspective.
 */
export function flattenContours(contours: readonly (readonly Knot[])[], map: (p: Vec2) => Vec2): Vec2[][] {
  return contours.map((knots) => {
    const out: Vec2[] = [];
    for (let i = 0; i < knots.length; i++) {
      const a = knots[i], b = knots[(i + 1) % knots.length];
      const straight = a.out.x === a.anchor.x && a.out.y === a.anchor.y && b.in.x === b.anchor.x && b.in.y === b.anchor.y;
      out.push(map(a.anchor));
      // Straight edges stay straight under affine maps but bend under perspective/warp, so they subdivide too.
      const before = out.length;
      if (straight) subdivide(a.anchor, a.anchor, b.anchor, b.anchor, map, out, 0);
      else subdivide(a.anchor, a.out, b.in, b.anchor, map, out, 0);
      // The last piece ends on the next anchor, which the next iteration (or the start) supplies.
      if (out.length > before) out.pop();
    }
    return out;
  });
}

function subdivide(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, map: (p: Vec2) => Vec2, out: Vec2[], depth: number) {
  const m0 = map(p0), m3 = map(p3);
  // Flatness of the mapped curve: distance of its mapped midpoint and control points from the chord.
  const mid = map(cubicAt(p0, p1, p2, p3, 0.5));
  const flat =
    depth >= 16 ||
    (distToSegment(mid, m0, m3) <= FLATNESS &&
      distToSegment(map(p1), m0, m3) <= FLATNESS * 4 &&
      distToSegment(map(p2), m0, m3) <= FLATNESS * 4);
  if (flat) {
    if (depth > 0) out.push(m3);
    return;
  }
  // de Casteljau split at t = 0.5.
  const p01 = lerp(p0, p1), p12 = lerp(p1, p2), p23 = lerp(p2, p3);
  const p012 = lerp(p01, p12), p123 = lerp(p12, p23), m = lerp(p012, p123);
  subdivide(p0, p01, p012, m, map, out, depth + 1);
  subdivide(m, p123, p23, p3, map, out, depth + 1);
}

const lerp = (a: Vec2, b: Vec2) => vec((a.x + b.x) / 2, (a.y + b.y) / 2);

function cubicAt(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return vec(a * p0.x + b * p1.x + c * p2.x + d * p3.x, a * p0.y + b * p1.y + c * p2.y + d * p3.y);
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
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
export function strokePolygons(contours: readonly (readonly Vec2[])[], width: number): Vec2[][] {
  const hw = width / 2;
  const out: Vec2[][] = [];
  for (const raw of contours) {
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
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n], nm = normals[i];
      out.push(positive([vec(a.x + nm.x, a.y + nm.y), vec(b.x + nm.x, b.y + nm.y), vec(b.x - nm.x, b.y - nm.y), vec(a.x - nm.x, a.y - nm.y)]));
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

/** Composites `color` with per-pixel `coverage` over the tiles in `w`. */
function paintCoverage(tiles: TileMap, c: Coverage, color: RGB): TileMap {
  const w = tileWriter(tiles);
  const { region, data } = c;
  const covered = (part: Rect) => {
    for (let y = part.y; y < part.y + part.h; y++)
      for (let x = part.x; x < part.x + part.w; x++) if (data[(y - region.y) * region.w + (x - region.x)]) return true;
    return false;
  };
  writeSpans(
    w,
    region,
    (d, i, x0, y, n) => {
      for (let ci = (y - region.y) * region.w + (x0 - region.x), end = ci + n; ci < end; ci++, i += 4) {
        const a = data[ci] / 255;
        if (a <= 0) continue;
        const da = d[i + 3] / 255;
        const oa = a + da * (1 - a);
        const keep = (da * (1 - a)) / oa;
        d[i] = color.r * (a / oa) + d[i] * keep;
        d[i + 1] = color.g * (a / oa) + d[i + 1] * keep;
        d[i + 2] = color.b * (a / oa) + d[i + 2] * keep;
        d[i + 3] = oa * 255;
      }
    },
    { wanted: covered },
  );
  return w.finish();
}

/** Point mapper from a source box into the document through a mapping. */
export function boxMapper(m: Mapping): (p: Vec2) => Vec2 {
  const { x, y, w, h } = m.source;
  return (p) => mapPoint(m, (p.x - x) / w, (p.y - y) / h);
}

/** Document-space polygons of a shape's outline. */
export const shapeOutline = (g: ShapeGeometry, m: Mapping) => flattenContours(shapeContours(g, m.source), boxMapper(m));

/** Coverage of a shape's fill (no stroke), clipped to `clip`. */
export const fillCoverage = (g: ShapeGeometry, m: Mapping, clip: Rect) => rasterizeContours(shapeOutline(g, m), clip);

/**
 * Renders a shape layer's pixels (fill, then stroke over it), clipped to
 * `clip` — the canvas: the vector is the source of truth, so nothing outside
 * it needs caching.
 */
export function renderShape(g: ShapeGeometry, style: ShapeStyle, m: Mapping, clip: Rect): TileMap {
  const outline = shapeOutline(g, m);
  const fill = rasterizeContours(outline, clip);
  let tiles: TileMap = EMPTY_TILES;
  if (style.fill && fill) tiles = paintCoverage(tiles, fill, style.fill);
  const s = style.stroke;
  if (s && s.width > 0) {
    // Inside/outside strokes are a doubled centre stroke clipped by the fill.
    const width = s.align === "center" ? s.width : s.width * 2;
    const stroke = rasterizeContours(strokePolygons(outline, width), clip);
    if (stroke) {
      const f = (x: number, y: number) => {
        if (!fill) return 0;
        const lx = x - fill.region.x, ly = y - fill.region.y;
        return lx < 0 || ly < 0 || lx >= fill.region.w || ly >= fill.region.h ? 0 : fill.data[ly * fill.region.w + lx];
      };
      if (s.align !== "center") {
        const r = stroke.region;
        const clipped = new Uint8Array(stroke.data.length);
        for (let y = 0; y < r.h; y++)
          for (let x = 0; x < r.w; x++) {
            const i = y * r.w + x;
            const fv = f(r.x + x, r.y + y);
            clipped[i] = s.align === "inside" ? (stroke.data[i] * fv) / 255 : (stroke.data[i] * (255 - fv)) / 255;
          }
        tiles = paintCoverage(tiles, { region: r, data: clipped }, s.color);
      } else {
        tiles = paintCoverage(tiles, stroke, s.color);
      }
    }
  }
  return tiles;
}

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
  if (!affine) return shapeOutline(g, m).map((poly) => poly.map(corner));
  const map = boxMapper(m);
  return shapeContours(g, m.source).map((c) => c.map((k) => ({ anchor: map(k.anchor), in: map(k.in), out: map(k.out) })));
}

/** How a stroke is clipped against the fill: none (no stroke), centred, inside or outside. */
export const STROKE_MODES = { none: 0, center: 1, inside: 2, outside: 3 } as const;

/**
 * A shape as line segments for the GPU rasterizer (`gpu/vector.ts`), which
 * implements the same exact-area coverage as {@link rasterizeContours}:
 * the fill outline and, for strokes, the stroke polygons (doubled for inside
 * and outside alignment, then clipped by the fill) — the same geometry
 * {@link renderShape} draws. Coordinates are document space × `scale`.
 */
export interface ShapeSegments {
  /** x0, y0, x1, y1 per edge of the fill outline (always present: inside/outside strokes clip against it). */
  readonly fill: Float32Array;
  readonly stroke: Float32Array;
  readonly strokeMode: (typeof STROKE_MODES)[keyof typeof STROKE_MODES];
  /** Straight RGBA in [0, 1]; alpha 0 when absent. */
  readonly fillColor: readonly [number, number, number, number];
  readonly strokeColor: readonly [number, number, number, number];
  /** What the shape can touch, in document space. */
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

export function shapeSegments(g: ShapeGeometry, style: ShapeStyle, m: Mapping, scale = 1): ShapeSegments {
  const outline = shapeOutline(g, m);
  const s = style.stroke && style.stroke.width > 0 ? style.stroke : null;
  const stroke = s ? strokePolygons(outline, s.align === "center" ? s.width : s.width * 2) : [];
  return {
    fill: edges(outline, scale),
    stroke: edges(stroke, scale),
    strokeMode: s ? STROKE_MODES[s.align] : STROKE_MODES.none,
    fillColor: rgba(style.fill),
    strokeColor: rgba(s?.color),
    bounds: shapeBounds(g, style, m),
  };
}
