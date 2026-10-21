import { distance, vec, type Rect, type Vec2 } from "./geometry";
import { invert3, mul3, squareToQuad, type Mat3, type Quad } from "./warp";

/**
 * The Crop and Perspective Crop tools' geometry, independent of the UI.
 *
 * A crop box is a rectangle in document space, `w × h` around (cx, cy) and
 * turned by `angle` (radians, clockwise on screen). Box-local coordinates
 * run from its top-left corner along its top edge: (0, 0)–(w, h). Committing
 * maps the box onto the new canvas: a rotation (plus a scale for a fixed
 * output size), so it's one {@link DocTransform} like any other.
 */
export interface CropBox {
  readonly cx: number;
  readonly cy: number;
  readonly w: number;
  readonly h: number;
  readonly angle: number;
}

/** Smallest box side, in document pixels. */
const MIN_SIDE = 1;

export const rectBox = (r: Rect): CropBox => ({ cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w, h: r.h, angle: 0 });
export const canvasBox = (width: number, height: number): CropBox => rectBox({ x: 0, y: 0, w: width, h: height });

export function boxToDoc(b: CropBox, p: Vec2): Vec2 {
  const c = Math.cos(b.angle), s = Math.sin(b.angle);
  const u = p.x - b.w / 2, v = p.y - b.h / 2;
  return vec(b.cx + c * u - s * v, b.cy + s * u + c * v);
}

export function docToBox(b: CropBox, p: Vec2): Vec2 {
  const c = Math.cos(b.angle), s = Math.sin(b.angle);
  const dx = p.x - b.cx, dy = p.y - b.cy;
  return vec(c * dx + s * dy + b.w / 2, -s * dx + c * dy + b.h / 2);
}

/** Top-left, top-right, bottom-right, bottom-left (in the box's own orientation). */
export const boxCorners = (b: CropBox): Quad => [boxToDoc(b, vec(0, 0)), boxToDoc(b, vec(b.w, 0)), boxToDoc(b, vec(b.w, b.h)), boxToDoc(b, vec(0, b.h))];

/** Angles in (−π, π]. */
const normalizeAngle = (a: number) => a - 2 * Math.PI * Math.ceil((a - Math.PI) / (2 * Math.PI));

/**
 * An unrotated box's edges land on whole pixels, as Photoshop's do, so an
 * unrotated crop copies pixels exactly. Rotated boxes are continuous.
 */
export function roundBox(b: CropBox): CropBox {
  const angle = normalizeAngle(b.angle);
  if (Math.abs(angle) > 1e-9) return { ...b, angle };
  const l = Math.round(b.cx - b.w / 2), t = Math.round(b.cy - b.h / 2);
  const r = Math.max(l + MIN_SIDE, Math.round(b.cx + b.w / 2)), btm = Math.max(t + MIN_SIDE, Math.round(b.cy + b.h / 2));
  return { cx: (l + r) / 2, cy: (t + btm) / 2, w: r - l, h: btm - t, angle: 0 };
}

export const isCanvasBox = (b: CropBox, width: number, height: number) =>
  b.angle === 0 && b.w === width && b.h === height && b.cx === width / 2 && b.cy === height / 2;

export interface ResizeOptions {
  /** Width ÷ height to keep (a fixed ratio, or Shift's current proportions), or null. */
  readonly ratio: number | null;
  /** Alt: resize about the centre. */
  readonly fromCentre: boolean;
}

/**
 * Drags a handle to document point `p`. `hx`, `hy` ∈ {−1, 0, 1} say which
 * edges it moves (a corner moves two). With a ratio, a corner follows the
 * dimension that grew most; an edge sets the other dimension, centred.
 */
export function resizeBox(b: CropBox, hx: -1 | 0 | 1, hy: -1 | 0 | 1, p: Vec2, o: ResizeOptions): CropBox {
  const q = docToBox(b, p);
  let l = 0, r = b.w, t = 0, btm = b.h;
  if (o.fromCentre) {
    const hw = Math.max(MIN_SIDE / 2, Math.abs(q.x - b.w / 2)), hh = Math.max(MIN_SIDE / 2, Math.abs(q.y - b.h / 2));
    if (hx) [l, r] = [b.w / 2 - hw, b.w / 2 + hw];
    if (hy) [t, btm] = [b.h / 2 - hh, b.h / 2 + hh];
  } else {
    if (hx < 0) l = Math.min(q.x, r - MIN_SIDE);
    if (hx > 0) r = Math.max(q.x, l + MIN_SIDE);
    if (hy < 0) t = Math.min(q.y, btm - MIN_SIDE);
    if (hy > 0) btm = Math.max(q.y, t + MIN_SIDE);
  }
  let w = r - l, h = btm - t;
  if (o.ratio) {
    if (hx && hy) {
      if (w / h > o.ratio) h = w / o.ratio;
      else w = h * o.ratio;
    } else if (hx) h = w / o.ratio;
    else w = h * o.ratio;
    // Anchored at the opposite edge (or the centre).
    const mx = o.fromCentre || !hx ? (l + r) / 2 : hx < 0 ? r - w / 2 : l + w / 2;
    const my = o.fromCentre || !hy ? (t + btm) / 2 : hy < 0 ? btm - h / 2 : t + h / 2;
    [l, r, t, btm] = [mx - w / 2, mx + w / 2, my - h / 2, my + h / 2];
  }
  const c = boxToDoc(b, vec((l + r) / 2, (t + btm) / 2));
  return roundBox({ cx: c.x, cy: c.y, w, h, angle: b.angle });
}

export interface DrawOptions {
  readonly ratio: number | null;
  /** Shift: a square, when no ratio is set. */
  readonly square: boolean;
  /** Alt: drawn from the centre. */
  readonly fromCentre: boolean;
}

/** A new box dragged from `a` to `b` (document points), aligned to `angle` (the screen's axes). */
export function drawBox(a: Vec2, b: Vec2, angle: number, o: DrawOptions): CropBox {
  const c = Math.cos(angle), s = Math.sin(angle);
  const dx = c * (b.x - a.x) + s * (b.y - a.y), dy = -s * (b.x - a.x) + c * (b.y - a.y);
  let w = Math.max(MIN_SIDE, Math.abs(dx)), h = Math.max(MIN_SIDE, Math.abs(dy));
  const ratio = o.ratio ?? (o.square ? 1 : null);
  if (ratio) {
    if (w / h > ratio) h = w / ratio;
    else w = h * ratio;
  }
  if (o.fromCentre) return roundBox({ cx: a.x, cy: a.y, w: w * 2, h: h * 2, angle });
  const u = (Math.sign(dx) || 1) * (w / 2), v = (Math.sign(dy) || 1) * (h / 2);
  return roundBox({ cx: a.x + c * u - s * v, cy: a.y + s * u + c * v, w, h, angle });
}

export const moveBox = (b: CropBox, d: Vec2): CropBox => roundBox({ ...b, cx: b.cx + d.x, cy: b.cy + d.y });

export const rotateBox = (b: CropBox, radians: number): CropBox => roundBox({ ...b, angle: b.angle + radians });

/** Rotate Crop Box (X): portrait ⇄ landscape about the centre. */
export const swapOrientation = (b: CropBox): CropBox => roundBox({ ...b, w: b.h, h: b.w });

/** The largest box of `ratio` (w ÷ h) within `b`, centred on it. */
export function fitRatio(b: CropBox, ratio: number): CropBox {
  return roundBox(b.w / b.h > ratio ? { ...b, w: b.h * ratio } : { ...b, h: b.w / ratio });
}

/** The largest box of `ratio` on a `width × height` canvas, centred on it, turned by `angle`: what choosing a ratio sets. */
export function largestBox(width: number, height: number, ratio: number, angle = 0): CropBox {
  const b = fitRatio(canvasBox(width, height), ratio);
  return angle ? fitInside({ ...b, w: b.w * 2, h: b.h * 2, angle }, width, height) : b;
}

/**
 * `b` shrunk about its centre (proportions kept) until it lies within the
 * canvas — so straightening leaves no empty corners. Unchanged if it
 * already does, or if its centre is off the canvas.
 */
export function fitInside(b: CropBox, width: number, height: number): CropBox {
  const mx = Math.min(b.cx, width - b.cx), my = Math.min(b.cy, height - b.cy);
  if (mx <= 0 || my <= 0) return b;
  const c = Math.abs(Math.cos(b.angle)), s = Math.abs(Math.sin(b.angle));
  const k = Math.min(1, mx / ((b.w / 2) * c + (b.h / 2) * s), my / ((b.w / 2) * s + (b.h / 2) * c));
  return k >= 1 ? b : roundBox({ ...b, w: b.w * k, h: b.h * k });
}

/**
 * The Straighten tool: the box angle that makes the line a→b level — or
 * plumb, whichever it's nearer — in the cropped result.
 */
export function levelAngle(a: Vec2, b: Vec2): number {
  const theta = Math.atan2(b.y - a.y, b.x - a.x);
  return theta - Math.round(theta / (Math.PI / 2)) * (Math.PI / 2);
}

/** Old document space → the cropped canvas (`width × height`; a scale when that isn't the box's own size). */
export function cropMatrix(b: CropBox, width: number, height: number): Mat3 {
  const c = Math.cos(b.angle), s = Math.sin(b.angle);
  const sx = width / b.w, sy = height / b.h;
  return [sx * c, sx * s, sx * (-c * b.cx - s * b.cy) + width / 2, -sy * s, sy * c, sy * (s * b.cx - c * b.cy) + height / 2, 0, 0, 1];
}

/** Old document space → a `width × height` canvas the quad (TL, TR, BR, BL) is straightened onto. */
export function perspectiveMatrix(q: Quad, width: number, height: number): Mat3 | null {
  const h = squareToQuad(q);
  const inv = h && invert3(h);
  return inv && mul3([width, 0, 0, 0, height, 0, 0, 0, 1], inv);
}

/**
 * The size a perspective crop of `q` produces when none is given: the
 * rectangle's true aspect ratio, recovered from the quad as a pinhole
 * camera's view of it with its principal point at `centre` (Zhang & He,
 * "Whiteboard scanning and image enhancement", 2007), at the resolution
 * of the quad's longest sides. Quads with parallel sides (no perspective)
 * or no real solution use the sides' average proportions.
 */
export function perspectiveSize(q: Quad, centre: Vec2): { width: number; height: number } {
  const [tl, tr, br, bl] = q;
  const top = distance(tl, tr), bottom = distance(bl, br), left = distance(tl, bl), right = distance(tr, br);
  const aspect = perspectiveAspect(q, centre) ?? (top + bottom) / (left + right);
  const w0 = Math.max(top, bottom), h0 = Math.max(left, right);
  const [width, height] = w0 / h0 > aspect ? [w0, w0 / aspect] : [h0 * aspect, h0];
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

type V3 = readonly [number, number, number];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Width ÷ height of the rectangle `q` is a perspective view of, or null when it can't be told. */
export function perspectiveAspect(q: Quad, centre: Vec2): number | null {
  const [tl, tr, br, bl] = q;
  // The paper's m1…m4: (0,0), (w,0), (0,h), (w,h).
  const m1: V3 = [tl.x, tl.y, 1], m2: V3 = [tr.x, tr.y, 1], m3: V3 = [bl.x, bl.y, 1], m4: V3 = [br.x, br.y, 1];
  const k2 = dot(cross(m1, m4), m3) / dot(cross(m2, m4), m3);
  const k3 = dot(cross(m1, m4), m2) / dot(cross(m3, m4), m2);
  if (!Number.isFinite(k2) || !Number.isFinite(k3)) return null;
  const n2 = m2.map((v, i) => k2 * v - m1[i]) as unknown as V3;
  const n3 = m3.map((v, i) => k3 * v - m1[i]) as unknown as V3;
  const { x: u0, y: v0 } = centre;
  const den = n2[2] * n3[2];
  // Without perspective the focal length drops out (and can't be found).
  let f2 = 1;
  if (Math.abs(den) > 1e-10) {
    f2 = -(n2[0] * n3[0] - (n2[0] * n3[2] + n2[2] * n3[0]) * u0 + den * u0 * u0 + (n2[1] * n3[1] - (n2[1] * n3[2] + n2[2] * n3[1]) * v0 + den * v0 * v0)) / den;
    if (!(f2 > 0)) return null;
  }
  // |A⁻¹ n|², A the camera matrix [f 0 u0; 0 f v0; 0 0 1].
  const norm = (n: V3) => ((n[0] - u0 * n[2]) ** 2 + (n[1] - v0 * n[2]) ** 2) / f2 + n[2] ** 2;
  const r = Math.sqrt(norm(n2) / norm(n3));
  return Number.isFinite(r) && r > 0 ? r : null;
}

export type CropOverlay = "thirds" | "grid" | "diagonal" | "triangle" | "golden-ratio" | "golden-spiral";

/** Photoshop's overlays, in its order (O cycles them). */
export const CROP_OVERLAYS: readonly { readonly id: CropOverlay; readonly label: string; readonly orientations: number }[] = [
  { id: "thirds", label: "Rule of Thirds", orientations: 1 },
  { id: "grid", label: "Grid", orientations: 1 },
  { id: "diagonal", label: "Diagonal", orientations: 1 },
  { id: "triangle", label: "Triangle", orientations: 2 },
  { id: "golden-ratio", label: "Golden Ratio", orientations: 1 },
  { id: "golden-spiral", label: "Golden Spiral", orientations: 4 },
];

const PHI = (1 + Math.sqrt(5)) / 2;

/**
 * An overlay's lines, as polylines in box-local coordinates of a `w × h`
 * box. `orientation` flips the asymmetric ones (Shift+O); `cell` is the
 * Grid's spacing.
 */
export function overlayLines(kind: CropOverlay, orientation: number, w: number, h: number, cell: number): Vec2[][] {
  const lines: Vec2[][] = [];
  const vertical = (x: number) => lines.push([vec(x, 0), vec(x, h)]);
  const horizontal = (y: number) => lines.push([vec(0, y), vec(w, y)]);
  switch (kind) {
    case "thirds":
    case "golden-ratio": {
      const f = kind === "thirds" ? 1 / 3 : 1 / (PHI * PHI);
      for (const k of [f, 1 - f]) {
        vertical(w * k);
        horizontal(h * k);
      }
      break;
    }
    case "grid":
      for (let x = cell; x < w - 1e-6; x += cell) vertical(x);
      for (let y = cell; y < h - 1e-6; y += cell) horizontal(y);
      break;
    case "diagonal": {
      // 45° from each corner (the "diagonal method").
      const s = Math.min(w, h);
      lines.push([vec(0, 0), vec(s, s)], [vec(w, 0), vec(w - s, s)], [vec(0, h), vec(s, h - s)], [vec(w, h), vec(w - s, h - s)]);
      break;
    }
    case "triangle": {
      // A diagonal, and perpendiculars to it from the other two corners.
      const [a, b, c, d] = orientation % 2 ? [vec(w, 0), vec(0, h), vec(0, 0), vec(w, h)] : [vec(0, 0), vec(w, h), vec(w, 0), vec(0, h)];
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      const foot = (p: Vec2) => {
        const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
        return vec(a.x + t * dx, a.y + t * dy);
      };
      lines.push([a, b], [c, foot(c)], [d, foot(d)]);
      break;
    }
    case "golden-spiral":
      lines.push(...goldenSpiral(orientation, w, h));
      break;
  }
  return lines;
}

/**
 * Fibonacci's spiral of quarter circles in ever smaller golden rectangles
 * (and the squares they're cut into), stretched to the box; turned to
 * follow portrait boxes and flipped by `orientation`.
 */
function goldenSpiral(orientation: number, w: number, h: number): Vec2[][] {
  const out: Vec2[][] = [];
  const spiral: Vec2[] = [];
  // A φ × 1 rectangle, cut into a square and a smaller golden rectangle, turning each time.
  let x = 0, y = 0, rw = PHI, rh = 1;
  for (let k = 0; k < 10; k++) {
    let centre: Vec2, from: number, side: number;
    switch (k % 4) {
      case 0: // square on the left
        side = rh;
        centre = vec(x + side, y + side);
        from = Math.PI;
        out.push([vec(x + side, y), vec(x + side, y + rh)]);
        x += side;
        rw -= side;
        break;
      case 1: // on top
        side = rw;
        centre = vec(x, y + side);
        from = -Math.PI / 2;
        out.push([vec(x, y + side), vec(x + rw, y + side)]);
        y += side;
        rh -= side;
        break;
      case 2: // on the right
        side = rh;
        centre = vec(x + rw - side, y);
        from = 0;
        out.push([vec(x + rw - side, y), vec(x + rw - side, y + rh)]);
        rw -= side;
        break;
      default: // at the bottom
        side = rw;
        centre = vec(x + rw, y + rh - side);
        from = Math.PI / 2;
        out.push([vec(x, y + rh - side), vec(x + rw, y + rh - side)]);
        rh -= side;
    }
    const steps = 16;
    for (let i = spiral.length ? 1 : 0; i <= steps; i++) {
      const a = from + (i / steps) * (Math.PI / 2);
      spiral.push(vec(centre.x + side * Math.cos(a), centre.y + side * Math.sin(a)));
    }
  }
  out.push(spiral);
  const portrait = h > w;
  const fx = orientation & 1, fy = (orientation >> 1) & 1;
  return out.map((line) =>
    line.map((p) => {
      let u = p.x / PHI, v = p.y;
      if (portrait) [u, v] = [v, u];
      if (fx) u = 1 - u;
      if (fy) v = 1 - v;
      return vec(u * w, v * h);
    }),
  );
}

/** Lengths the crop size fields accept, Photoshop-style ("4 in", "1200 px"). */
export type CropUnit = "pixels" | "inches" | "centimeters" | "millimeters";

const UNIT_SUFFIX: Record<CropUnit, string> = { pixels: "px", inches: "in", centimeters: "cm", millimeters: "mm" };
const INCHES_PER: Record<CropUnit, number> = { pixels: 0, inches: 1, centimeters: 1 / 2.54, millimeters: 1 / 25.4 };

/** A typed length: a number and an optional unit ("px", "in", "cm", "mm"). Null when it isn't one. */
export function parseLength(text: string, fallback: CropUnit): { value: number; unit: CropUnit } | null {
  const m = /^\s*(\d*\.?\d+)\s*(px|pixels?|in|inch(?:es)?|"|cm|mm)?\s*$/i.exec(text);
  if (!m) return null;
  const value = Number(m[1]);
  if (!(value > 0)) return null;
  const u = (m[2] ?? "").toLowerCase();
  const unit: CropUnit = !u ? fallback : u.startsWith("p") ? "pixels" : u.startsWith("i") || u === '"' ? "inches" : u === "cm" ? "centimeters" : "millimeters";
  return { value, unit };
}

export const formatLength = (value: number, unit: CropUnit) => `${Math.round(value * 1000) / 1000} ${UNIT_SUFFIX[unit]}`;

export const lengthToPixels = (value: number, unit: CropUnit, ppi: number) => (unit === "pixels" ? value : value * INCHES_PER[unit] * ppi);

/** A length as typed into a crop field: a value in a unit. */
export interface Length {
  readonly value: number;
  readonly unit: CropUnit;
}

/**
 * The options bar's constraint. "ratio": the box keeps width ÷ height
 * (either blank = free). "size" (W x H x Resolution): the result is
 * resampled to those dimensions at that resolution; either dimension may
 * be blank (that one follows the box).
 */
export interface CropConstraint {
  readonly mode: "ratio" | "size";
  readonly width: Length | null;
  readonly height: Length | null;
  /** Pixels per inch, size mode; null keeps the document's. */
  readonly resolution: number | null;
}

/** Width ÷ height the box must keep, if any. */
export function constraintRatio(c: CropConstraint, docResolution: number): number | null {
  if (!c.width || !c.height) return null;
  const ppi = c.resolution ?? docResolution;
  return lengthToPixels(c.width.value, c.width.unit, ppi) / lengthToPixels(c.height.value, c.height.unit, ppi);
}

/** The cropped canvas: the box's own pixels, or the size the constraint asks for. */
export function cropOutput(b: CropBox, c: CropConstraint, docResolution: number): { width: number; height: number; resolution: number } {
  const resolution = c.mode === "size" ? (c.resolution ?? docResolution) : docResolution;
  if (c.mode !== "size" || (!c.width && !c.height)) return { width: Math.max(1, Math.round(b.w)), height: Math.max(1, Math.round(b.h)), resolution };
  const w = c.width && lengthToPixels(c.width.value, c.width.unit, resolution);
  const h = c.height && lengthToPixels(c.height.value, c.height.unit, resolution);
  const width = w ?? (h! * b.w) / b.h, height = h ?? (w! * b.h) / b.w;
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), resolution };
}

/** A preset in the ratio menu. */
export interface CropPreset {
  readonly label: string;
  readonly constraint: CropConstraint;
}

const ratio = (label: string, w: number, h: number): CropPreset => ({
  label,
  constraint: { mode: "ratio", width: { value: w, unit: "pixels" }, height: { value: h, unit: "pixels" }, resolution: null },
});
const size = (label: string, w: number, h: number, unit: CropUnit, resolution: number): CropPreset => ({
  label,
  constraint: { mode: "size", width: { value: w, unit }, height: { value: h, unit }, resolution },
});

/** Photoshop's default crop presets (after Ratio, W x H x Resolution and Original Ratio). */
export const CROP_PRESETS: readonly CropPreset[] = [
  ratio("1 : 1 (Square)", 1, 1),
  ratio("4 : 5 (8 : 10)", 4, 5),
  ratio("5 : 7", 5, 7),
  ratio("2 : 3 (4 : 6)", 2, 3),
  ratio("16 : 9", 16, 9),
  size("4 x 5 in 300 ppi", 4, 5, "inches", 300),
  size("8.5 x 11 in 300 ppi", 8.5, 11, "inches", 300),
  size("1024 x 768 px 92 ppi", 1024, 768, "pixels", 92),
  size("1280 x 800 px 113 ppi", 1280, 800, "pixels", 113),
  size("1366 x 768 px 135 ppi", 1366, 768, "pixels", 135),
];

/** Sorts four clicked points into a convex quad, TL, TR, BR, BL (the corner nearest the top-left first). */
export function orderQuad(points: readonly Vec2[]): Quad {
  const c = vec(points.reduce((s, p) => s + p.x, 0) / 4, points.reduce((s, p) => s + p.y, 0) / 4);
  const sorted = [...points].sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
  const first = sorted.reduce((best, p, i) => (p.x + p.y < sorted[best].x + sorted[best].y ? i : best), 0);
  return [0, 1, 2, 3].map((k) => sorted[(first + k) % 4]) as unknown as Quad;
}
