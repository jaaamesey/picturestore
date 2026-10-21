/**
 * Layer blend modes, named exactly as in PSD files (and ag-psd), implemented
 * per the W3C Compositing and Blending spec. This is the CPU reference; the
 * GPU compositor in `gpu/shaders.ts` mirrors it and e2e tests compare the two.
 */
export const BLEND_MODES = [
  "normal",
  "darken",
  "multiply",
  "color burn",
  "linear burn",
  "lighten",
  "screen",
  "color dodge",
  "linear dodge",
  "overlay",
  "soft light",
  "hard light",
  "difference",
  "exclusion",
  "subtract",
  "divide",
  "hue",
  "saturation",
  "color",
  "luminosity",
] as const;

export type BlendMode = (typeof BLEND_MODES)[number];

/**
 * A layer's blend mode. Groups may also pass through: their contents blend
 * straight into what's below, as if ungrouped (Photoshop's default for groups).
 */
export type LayerBlendMode = BlendMode | "pass through";

export const isBlendMode = (s: string): s is BlendMode => (BLEND_MODES as readonly string[]).includes(s);

/** The mode things are blended with: pass-through (only meaningful for groups) blends normally. */
export const effectiveMode = (m: LayerBlendMode): BlendMode => (m === "pass through" ? "normal" : m);

/** Index used by the GPU compositor's `mode` uniform. */
export const blendModeIndex = (m: BlendMode) => BLEND_MODES.indexOf(m);

type Channel = (b: number, s: number) => number;

const screen: Channel = (b, s) => b + s - b * s;
const hardLight: Channel = (b, s) => (s <= 0.5 ? b * 2 * s : screen(b, 2 * s - 1));
const softLight: Channel = (b, s) => {
  if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return b + (2 * s - 1) * (d - b);
};

// Non-separable modes, written to scalar registers to stay allocation-free.
let OR = 0, OG = 0, OB = 0;

const lum = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

function setLum(r: number, g: number, b: number, l: number) {
  const d = l - lum(r, g, b);
  r += d;
  g += d;
  b += d;
  // ClipColor
  const L = lum(r, g, b);
  const n = Math.min(r, g, b);
  const x = Math.max(r, g, b);
  if (n < 0) {
    const k = L / (L - n);
    r = L + (r - L) * k;
    g = L + (g - L) * k;
    b = L + (b - L) * k;
  }
  if (x > 1) {
    const k = (1 - L) / (x - L);
    r = L + (r - L) * k;
    g = L + (g - L) * k;
    b = L + (b - L) * k;
  }
  OR = r;
  OG = g;
  OB = b;
}

const sat = (r: number, g: number, b: number) => Math.max(r, g, b) - Math.min(r, g, b);

/** SetSat into OR/OG/OB. */
function setSat(r: number, g: number, b: number, s: number) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx <= mn) {
    OR = OG = OB = 0;
    return;
  }
  const k = s / (mx - mn);
  OR = (r - mn) * k;
  OG = (g - mn) * k;
  OB = (b - mn) * k;
}

/** B(Cb, Cs) for unpremultiplied colour components in [0, 1] (the same code path the kernels use). */
export function blendColor(mode: BlendMode, b: readonly number[], s: readonly number[]): [number, number, number] {
  const m = blendModeIndex(mode);
  if (m >= FIRST_NON_SEPARABLE) {
    nonSeparable(m, b[0], b[1], b[2], s[0], s[1], s[2]);
    return [OR, OG, OB];
  }
  return [channel(m, b[0], s[0]), channel(m, b[1], s[1]), channel(m, b[2], s[2])];
}

/**
 * B(b, s) for separable mode index `m`. A switch on a small integer: within a
 * row the branch is perfectly predictable, and the function is small enough
 * for V8 to inline into the kernel loop.
 */
function channel(m: number, b: number, s: number): number {
  switch (m) {
    case 1: return b < s ? b : s;
    case 2: return b * s;
    case 3: return b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s);
    case 4: return Math.max(0, b + s - 1);
    case 5: return b > s ? b : s;
    case 6: return b + s - b * s;
    case 7: return b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s));
    case 8: return Math.min(1, b + s);
    case 9: return hardLight(s, b);
    case 10: return softLight(b, s);
    case 11: return hardLight(b, s);
    case 12: return Math.abs(b - s);
    case 13: return b + s - 2 * b * s;
    case 14: return Math.max(0, b - s);
    case 15: return s <= 0 ? (b <= 0 ? 0 : 1) : Math.min(1, b / s);
    default: return s;
  }
}

const FIRST_NON_SEPARABLE = blendModeIndex("hue");

/** Non-separable mode index `m` into OR/OG/OB. */
function nonSeparable(m: number, br: number, bg: number, bb: number, sr: number, sg: number, sb: number) {
  switch (m) {
    case 16:
      setSat(sr, sg, sb, sat(br, bg, bb));
      return setLum(OR, OG, OB, lum(br, bg, bb));
    case 17:
      setSat(br, bg, bb, sat(sr, sg, sb));
      return setLum(OR, OG, OB, lum(br, bg, bb));
    case 18:
      return setLum(sr, sg, sb, lum(br, bg, bb));
    default:
      return setLum(br, bg, bb, lum(sr, sg, sb));
  }
}

/**
 * Composites `n` premultiplied source pixels onto premultiplied backdrop
 * pixels (both float RGBA, from pixel `di` of `dst` and `si` of `src`),
 * per the W3C compositing model: the source's alpha is scaled by `opacity`
 * and, if given, per-pixel `coverage` (from index `ci`).
 *
 * `atop` composites source-atop: the backdrop keeps its alpha and the
 * source shows only where it's opaque (how layers clipped to a base blend).
 */
export function blendSpan(
  mode: BlendMode,
  dst: Float32Array,
  di: number,
  src: Float32Array,
  si: number,
  n: number,
  opacity: number,
  coverage: Float32Array | null = null,
  ci = 0,
  atop = false,
): void {
  const m = blendModeIndex(mode);
  const separable = m < FIRST_NON_SEPARABLE;
  di *= 4;
  si *= 4;
  for (let k = 0; k < n; k++, di += 4, si += 4) {
    const a0 = src[si + 3];
    if (a0 <= 0) continue;
    const scale = coverage ? opacity * coverage[ci + k] : opacity;
    if (scale <= 0) continue;
    const sa = a0 * scale, t = 1 - sa, da = dst[di + 3];
    const inv = 1 / a0;
    const sr = src[si] * inv, sg = src[si + 1] * inv, sb = src[si + 2] * inv;
    if (m === 0) {
      OR = sr;
      OG = sg;
      OB = sb;
    } else if (da > 0) {
      const dinv = 1 / da;
      const br = dst[di] * dinv, bg = dst[di + 1] * dinv, bb = dst[di + 2] * dinv;
      if (separable) {
        OR = channel(m, br, sr);
        OG = channel(m, bg, sg);
        OB = channel(m, bb, sb);
      } else nonSeparable(m, br, bg, bb, sr, sg, sb);
    }
    // Where there's no backdrop the source shows as is; where both are, their blend.
    const only = atop ? 0 : sa * (1 - da), both = sa * da;
    dst[di] = sr * only + OR * both + dst[di] * t;
    dst[di + 1] = sg * only + OG * both + dst[di + 1] * t;
    dst[di + 2] = sb * only + OB * both + dst[di + 2] * t;
    if (!atop) dst[di + 3] = sa + da * t;
  }
}
