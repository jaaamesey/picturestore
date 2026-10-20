import { apply, compose, invert, rotation, scaling, translation, vec, type Mat, type Rect, type Vec2 } from "./geometry";

/**
 * Free Transform parameters. The source box is scaled about its centre,
 * rotated, then placed with its centre at (cx, cy). Keeping parameters
 * (rather than a raw matrix) makes handle dragging and numeric entry simple.
 */
export interface TransformState {
  readonly source: Rect;
  readonly cx: number;
  readonly cy: number;
  readonly sx: number;
  readonly sy: number;
  /** Radians, clockwise on screen (y down). */
  readonly angle: number;
}

export type HandleDir = -1 | 0 | 1;

export type TransformHit =
  | { readonly kind: "handle"; readonly hx: HandleDir; readonly hy: HandleDir }
  | { readonly kind: "move" }
  | { readonly kind: "rotate" };

export const initialTransform = (source: Rect): TransformState => ({
  source,
  cx: source.x + source.w / 2,
  cy: source.y + source.h / 2,
  sx: 1,
  sy: 1,
  angle: 0,
});

export function transformMatrix(s: TransformState): Mat {
  const ox = s.source.x + s.source.w / 2;
  const oy = s.source.y + s.source.h / 2;
  return compose(translation(-ox, -oy), scaling(s.sx, s.sy), rotation(s.angle), translation(s.cx, s.cy));
}

/** Document position of the handle at (hx, hy) ∈ {-1, 0, 1}². */
export const handlePoint = (s: TransformState, hx: number, hy: number): Vec2 =>
  apply(transformMatrix(s), vec(s.source.x + ((hx + 1) / 2) * s.source.w, s.source.y + ((hy + 1) / 2) * s.source.h));

export const HANDLES: readonly (readonly [HandleDir, HandleDir])[] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

/** `tolerance` is in document units (screen pixels ÷ zoom). */
export function hitTest(s: TransformState, p: Vec2, tolerance: number): TransformHit {
  for (const [hx, hy] of HANDLES) {
    const h = handlePoint(s, hx, hy);
    if (Math.abs(h.x - p.x) <= tolerance && Math.abs(h.y - p.y) <= tolerance) return { kind: "handle", hx, hy };
  }
  const local = apply(invert(transformMatrix(s)), p);
  const { x, y, w, h } = s.source;
  const inside = local.x >= x && local.x <= x + w && local.y >= y && local.y <= y + h;
  return inside ? { kind: "move" } : { kind: "rotate" };
}

export interface HandleModifiers {
  /** Keep aspect ratio. */
  readonly proportional: boolean;
  /** Scale about the centre instead of the opposite handle. */
  readonly fromCenter: boolean;
}

export function dragHandle(
  s0: TransformState,
  hx: HandleDir,
  hy: HandleDir,
  p: Vec2,
  { proportional, fromCenter }: HandleModifiers,
): TransformState {
  const { w, h } = s0.source;
  const anchor = fromCenter ? vec(s0.cx, s0.cy) : handlePoint(s0, -hx, -hy);
  const q = apply(rotation(-s0.angle), vec(p.x - anchor.x, p.y - anchor.y));
  const k = fromCenter ? 0.5 : 1;
  const limit = (v: number, size: number) => (Math.abs(v) * size < 1 ? Math.sign(v || 1) / size : v);
  let sx = hx ? limit(q.x / (hx * w * k), w) : s0.sx;
  let sy = hy ? limit(q.y / (hy * h * k), h) : s0.sy;
  if (proportional) {
    const rx = sx / s0.sx;
    const ry = sy / s0.sy;
    const r = !hy ? rx : !hx ? ry : Math.abs(rx) > Math.abs(ry) ? rx : ry;
    // Corners scale uniformly (and may flip); edges scale the other axis by magnitude only.
    sx = hx ? s0.sx * r : s0.sx * Math.abs(r);
    sy = hy ? s0.sy * r : s0.sy * Math.abs(r);
  }
  if (fromCenter) return { ...s0, sx, sy };
  // The opposite handle stays put; for edge handles it sits on the centre line,
  // so the zero component of the offset keeps the box centred on that axis.
  const offset = apply(rotation(s0.angle), vec((hx * w * sx) / 2, (hy * h * sy) / 2));
  return { ...s0, sx, sy, cx: anchor.x + offset.x, cy: anchor.y + offset.y };
}

const SNAP = Math.PI / 12; // 15°

export function dragRotate(s0: TransformState, start: Vec2, p: Vec2, snap: boolean): TransformState {
  const a0 = Math.atan2(start.y - s0.cy, start.x - s0.cx);
  const a1 = Math.atan2(p.y - s0.cy, p.x - s0.cx);
  const angle = s0.angle + a1 - a0;
  return { ...s0, angle: snap ? Math.round(angle / SNAP) * SNAP : angle };
}

export const dragMove = (s0: TransformState, dx: number, dy: number): TransformState => ({
  ...s0,
  cx: s0.cx + dx,
  cy: s0.cy + dy,
});
