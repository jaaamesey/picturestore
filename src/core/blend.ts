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

export const isBlendMode = (s: string): s is BlendMode => (BLEND_MODES as readonly string[]).includes(s);

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
 * Composites `n` straight-alpha RGBA8 source pixels onto a premultiplied
 * float accumulator: dst[di…] ← src[si…] ⊕ dst[di…] with layer `opacity`.
 */
export type RowKernel = (dst: Float32Array, di: number, src: Uint8ClampedArray, si: number, n: number, opacity: number) => void;

const INV255 = 1 / 255;

const normalKernel: RowKernel = (dst, di, src, si, n, opacity) => {
  const k = opacity * INV255;
  for (let end = si + n * 4; si < end; si += 4, di += 4) {
    const sa = src[si + 3] * k;
    if (sa <= 0) continue;
    const t = 1 - sa;
    dst[di] = src[si] * INV255 * sa + dst[di] * t;
    dst[di + 1] = src[si + 1] * INV255 * sa + dst[di + 1] * t;
    dst[di + 2] = src[si + 2] * INV255 * sa + dst[di + 2] * t;
    dst[di + 3] = sa + dst[di + 3] * t;
  }
};

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

function modeKernel(m: number): RowKernel {
  const separable = m < FIRST_NON_SEPARABLE;
  return (dst, di, src, si, n, opacity) => {
    const k = opacity * INV255;
    for (let end = si + n * 4; si < end; si += 4, di += 4) {
      const sa = src[si + 3] * k;
      if (sa <= 0) continue;
      const da = dst[di + 3];
      const sr = src[si] * INV255, sg = src[si + 1] * INV255, sb = src[si + 2] * INV255;
      const t = 1 - sa;
      if (da <= 0) {
        dst[di] = sr * sa;
        dst[di + 1] = sg * sa;
        dst[di + 2] = sb * sa;
        dst[di + 3] = sa;
        continue;
      }
      const inv = 1 / da, both = sa * da, only = sa * (1 - da);
      const br = dst[di] * inv, bg = dst[di + 1] * inv, bb = dst[di + 2] * inv;
      if (separable) {
        OR = channel(m, br, sr);
        OG = channel(m, bg, sg);
        OB = channel(m, bb, sb);
      } else {
        nonSeparable(m, br, bg, bb, sr, sg, sb);
      }
      dst[di] = sr * only + OR * both + dst[di] * t;
      dst[di + 1] = sg * only + OG * both + dst[di + 1] * t;
      dst[di + 2] = sb * only + OB * both + dst[di + 2] * t;
      dst[di + 3] = sa + da * t;
    }
  };
}

export const KERNELS: Readonly<Record<BlendMode, RowKernel>> = Object.fromEntries(
  BLEND_MODES.map((mode, i) => [mode, mode === "normal" ? normalKernel : modeKernel(i)]),
) as Record<BlendMode, RowKernel>;
