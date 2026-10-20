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

const multiply = (b: number, s: number) => b * s;
const screen = (b: number, s: number) => b + s - b * s;
const hardLight = (b: number, s: number) => (s <= 0.5 ? multiply(b, 2 * s) : screen(b, 2 * s - 1));

function softLight(b: number, s: number): number {
  if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
  return b + (2 * s - 1) * (d - b);
}

const separable: Record<string, (b: number, s: number) => number> = {
  normal: (_, s) => s,
  darken: Math.min,
  multiply,
  "color burn": (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  "linear burn": (b, s) => Math.max(0, b + s - 1),
  lighten: Math.max,
  screen,
  "color dodge": (b, s) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s))),
  "linear dodge": (b, s) => Math.min(1, b + s),
  overlay: (b, s) => hardLight(s, b),
  "soft light": softLight,
  "hard light": hardLight,
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
  subtract: (b, s) => Math.max(0, b - s),
  divide: (b, s) => (s <= 0 ? (b <= 0 ? 0 : 1) : Math.min(1, b / s)),
};

type RGB = [number, number, number];

const lum = ([r, g, b]: RGB) => 0.3 * r + 0.59 * g + 0.11 * b;

function clipColor(c: RGB): RGB {
  const l = lum(c);
  const n = Math.min(...c);
  const x = Math.max(...c);
  let out = c;
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n)) as RGB;
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as RGB;
  return out;
}

function setLum(c: RGB, l: number): RGB {
  const d = l - lum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

const sat = (c: RGB) => Math.max(...c) - Math.min(...c);

function setSat(c: RGB, s: number): RGB {
  const mx = Math.max(...c);
  const mn = Math.min(...c);
  if (mx <= mn) return [0, 0, 0];
  return c.map((v) => ((v - mn) * s) / (mx - mn)) as RGB;
}

const nonSeparable: Record<string, (b: RGB, s: RGB) => RGB> = {
  hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)),
  saturation: (b, s) => setLum(setSat(b, sat(s)), lum(b)),
  color: (b, s) => setLum(s, lum(b)),
  luminosity: (b, s) => setLum(b, lum(s)),
};

/** B(Cb, Cs) for unpremultiplied colour components in [0, 1]. */
export function blendColor(mode: BlendMode, b: RGB, s: RGB): RGB {
  const ns = nonSeparable[mode];
  if (ns) return ns(b, s);
  const f = separable[mode];
  return [f(b[0], s[0]), f(b[1], s[1]), f(b[2], s[2])];
}

/**
 * Composites a straight-alpha source pixel onto a premultiplied destination,
 * in place. `dst` is [r, g, b, a] premultiplied floats in [0, 1].
 */
export function compositePixel(
  dst: Float32Array | number[],
  di: number,
  sr: number,
  sg: number,
  sb: number,
  sa: number,
  mode: BlendMode,
): void {
  if (sa <= 0) return;
  const da = dst[di + 3];
  if (mode === "normal" || da <= 0) {
    dst[di] = sr * sa + dst[di] * (1 - sa);
    dst[di + 1] = sg * sa + dst[di + 1] * (1 - sa);
    dst[di + 2] = sb * sa + dst[di + 2] * (1 - sa);
    dst[di + 3] = sa + da * (1 - sa);
    return;
  }
  const cb: RGB = [dst[di] / da, dst[di + 1] / da, dst[di + 2] / da];
  const mixed = blendColor(mode, cb, [sr, sg, sb]);
  const both = sa * da;
  const srcOnly = sa * (1 - da);
  const dstOnly = 1 - sa;
  dst[di] = sr * srcOnly + mixed[0] * both + dst[di] * dstOnly;
  dst[di + 1] = sg * srcOnly + mixed[1] * both + dst[di + 1] * dstOnly;
  dst[di + 2] = sb * srcOnly + mixed[2] * both + dst[di + 2] * dstOnly;
  dst[di + 3] = sa + da * (1 - sa);
}
