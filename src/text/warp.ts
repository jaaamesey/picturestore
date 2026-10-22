import { vec, type Rect, type Vec2 } from "../core/geometry";
import type { TextWarp, WarpStyle } from "./model";

/**
 * Type ▸ Warp Text: Photoshop's fifteen warp styles as maps of the text's
 * bounds. Each is driven by Bend, then Horizontal and Vertical Distortion
 * taper it like a perspective; a vertical warp is the same style turned a
 * quarter. Adobe doesn't publish the formulas, so these are designed to
 * the shapes the styles' icons and results show.
 */

export const WARP_STYLES: readonly { readonly id: WarpStyle; readonly label: string }[] = [
  { id: "arc", label: "Arc" },
  { id: "arc-lower", label: "Arc Lower" },
  { id: "arc-upper", label: "Arc Upper" },
  { id: "arch", label: "Arch" },
  { id: "bulge", label: "Bulge" },
  { id: "shell-lower", label: "Shell Lower" },
  { id: "shell-upper", label: "Shell Upper" },
  { id: "flag", label: "Flag" },
  { id: "wave", label: "Wave" },
  { id: "fish", label: "Fish" },
  { id: "rise", label: "Rise" },
  { id: "fisheye", label: "Fisheye" },
  { id: "inflate", label: "Inflate" },
  { id: "squeeze", label: "Squeeze" },
  { id: "twist", label: "Twist" },
];

/** How far a circular arc of chord `w` and depth `s` rises at `x` from its middle (s may be negative). */
function sag(x: number, w: number, s: number): number {
  if (Math.abs(s) < 1e-9) return 0;
  const half = w / 2;
  const a = Math.abs(s);
  const r = (a * a + half * half) / (2 * a);
  const d = Math.sqrt(Math.max(0, r * r - Math.min(x * x, r * r))) - (r - a);
  return Math.sign(s) * d;
}

/**
 * The style's map in centred pixels: (x, y) with the bounds' centre at 0,
 * width `w` and height `h`, y down.
 */
function styleMap(style: WarpStyle, b: number, w: number, h: number): (x: number, y: number) => Vec2 {
  const u = (x: number) => x / w + 0.5; // 0..1 across
  const t = (y: number) => y / h + 0.5; // 0..1 down
  const depth = (k: number) => b * w * k;
  switch (style) {
    case "arc": {
      // Concentric arcs: the middle line bends to `θ` of a circle.
      const theta = b * Math.PI;
      if (Math.abs(theta) < 1e-6) return (x, y) => vec(x, y);
      const R = w / theta;
      return (x, y) => {
        const phi = (x / w) * theta, r = R - y;
        return vec(r * Math.sin(phi), R - r * Math.cos(phi) - sag(0, w, 0));
      };
    }
    case "arc-lower":
      return (x, y) => vec(x, y + sag(x, w, depth(0.25)) * t(y));
    case "arc-upper":
      return (x, y) => vec(x, y - sag(x, w, depth(0.25)) * (1 - t(y)));
    case "arch":
      return (x, y) => vec(x, y - sag(x, w, depth(0.25)));
    case "bulge":
      return (x, y) => vec(x, y - sag(x, w, depth(0.2)) * (1 - 2 * t(y)));
    case "shell-lower":
      return (x, y) => vec(x * (1 + b * 0.35 * t(y)), y + sag(x, w, depth(0.25)) * t(y));
    case "shell-upper":
      return (x, y) => vec(x * (1 + b * 0.35 * (1 - t(y))), y - sag(x, w, depth(0.25)) * (1 - t(y)));
    case "flag":
      return (x, y) => vec(x, y - b * h * 0.5 * Math.sin(2 * Math.PI * u(x)));
    case "wave": {
      // Top and bottom edges wave out of step, so letters swell and narrow.
      const a = b * h * 0.4;
      return (x, y) => vec(x, y - a * Math.sin(2 * Math.PI * u(x)) * (1 - t(y)) - a * Math.sin(2 * Math.PI * u(x) - Math.PI / 2) * t(y));
    }
    case "fish":
      // A bulge that swells at the head and tapers to the tail.
      return (x, y) => vec(x, y - sag(x, w, depth(0.2)) * (1 - 2 * t(y)) * (1.5 - u(x)));
    case "rise":
      return (x, y) => vec(x, y - b * h * 0.5 * Math.sin(Math.PI * (u(x) - 0.5)) * 2);
    case "fisheye": {
      const r = Math.hypot(w, h) / 2;
      return (x, y) => {
        const d = Math.hypot(x, y) / r;
        const k = 1 + b * 0.6 * (1 - d * d);
        return vec(x * k, y * k);
      };
    }
    case "inflate":
      return (x, y) => vec(x * (1 + b * 0.3 * (1 - (2 * y / h) ** 2)), y * (1 + b * 0.6 * (1 - (2 * x / w) ** 2)));
    case "squeeze":
      return (x, y) => vec(x * (1 + b * 0.3 * (1 - (2 * y / h) ** 2)), y * (1 - b * 0.5 * (1 - (2 * x / w) ** 2)));
    case "twist": {
      const r = Math.hypot(w, h) / 2;
      return (x, y) => {
        const a = b * Math.PI * 0.5 * Math.max(0, 1 - Math.hypot(x, y) / r);
        const c = Math.cos(a), s = Math.sin(a);
        return vec(x * c - y * s, x * s + y * c);
      };
    }
  }
}

/** The warp as a map of text space, over the text's bounds. */
export function warpMap(w: TextWarp, bounds: Rect): (p: Vec2) => Vec2 {
  const vertical = w.orientation === "vertical";
  const cx = bounds.x + bounds.w / 2, cy = bounds.y + bounds.h / 2;
  // A vertical warp is the horizontal one turned a quarter.
  const W = Math.max(1e-6, vertical ? bounds.h : bounds.w), H = Math.max(1e-6, vertical ? bounds.w : bounds.h);
  const f = styleMap(w.style, w.bend, W, H);
  const hd = w.horizontalDistortion, vd = w.verticalDistortion;
  return (p) => {
    const dx = p.x - cx, dy = p.y - cy;
    let x = vertical ? dy : dx, y = vertical ? -dx : dy;
    // Distortion first: a taper like perspective, larger towards one side.
    const sx = 1 + hd * (x / W), sy = 1 + vd * (y / H);
    x *= sy;
    y *= sx;
    const q = f(x, y);
    return vertical ? vec(cx - q.y, cy + q.x) : vec(cx + q.x, cy + q.y);
  };
}
