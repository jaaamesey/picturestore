import type { RGB } from "./color";

/**
 * Photoshop's adjustments (Image ▸ Adjustments, and adjustment layers):
 * their settings, with Photoshop's ranges and defaults, and how each turns
 * into a colour transform.
 *
 * Settings compile to a {@link Program}: per-channel curves (most of them),
 * or a handful of dedicated per-pixel transforms. The formulas follow
 * Photopea's, which match Photoshop closely; where Photoshop's are its own
 * (Brightness/Contrast, Vibrance, Black & White) these are close fits, not
 * bit-exact. Programs run on the CPU here (the reference, and destructive
 * adjustments) and on the GPU (adjustment layers, in `gpu/adjust.ts`).
 */

export interface LevelsChannel {
  /** Input black and white points, 0–255. */
  readonly inBlack: number;
  readonly inWhite: number;
  /** Midtone gamma, 0.01–9.99 (1 = none). */
  readonly gamma: number;
  /** Output black and white levels, 0–255. */
  readonly outBlack: number;
  readonly outWhite: number;
}

/** A curve point (0–255 both ways); a corner point breaks the curve's smoothness there. */
export interface CurvePoint {
  readonly x: number;
  readonly y: number;
  readonly corner?: boolean;
}

export type ChannelSet<T> = { readonly rgb: T; readonly red: T; readonly green: T; readonly blue: T };

/** Hue/Saturation's ranges, in Photoshop's order. */
export const HUE_RANGES = ["reds", "yellows", "greens", "cyans", "blues", "magentas"] as const;
export type HueRange = (typeof HUE_RANGES)[number];

export interface HueSatValues {
  /** −180…180 degrees. */
  readonly hue: number;
  /** −100…100 (Colorize: 0…100). */
  readonly saturation: number;
  /** −100…100. */
  readonly lightness: number;
}

export interface HueSatRange extends HueSatValues {
  /** The range's falloff and full-effect span, in degrees (begin falloff, begin, end, end falloff). */
  readonly span: readonly [number, number, number, number];
}

/** Selective Color's ranges, in Photoshop's order. */
export const SELECTIVE_RANGES = ["reds", "yellows", "greens", "cyans", "blues", "magentas", "whites", "neutrals", "blacks"] as const;
export type SelectiveRange = (typeof SELECTIVE_RANGES)[number];

/** Cyan, Magenta, Yellow, Black, each −100…100 %. */
export interface CMYK {
  readonly cyan: number;
  readonly magenta: number;
  readonly yellow: number;
  readonly black: number;
}

/** Channel Mixer: one output channel as percentages of the inputs (−200…200) plus a constant (−200…200). */
export interface MixerRow {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly constant: number;
}

/** A gradient (Gradient Map): colour stops at locations 0–1, each with a midpoint (0–1) to the next. */
export interface Gradient {
  readonly stops: readonly { readonly location: number; readonly color: RGB; readonly midpoint: number }[];
}

export type Adjustment =
  | { readonly kind: "brightness-contrast"; readonly brightness: number; readonly contrast: number; readonly legacy: boolean }
  | { readonly kind: "levels"; readonly channels: ChannelSet<LevelsChannel> }
  | { readonly kind: "curves"; readonly channels: ChannelSet<readonly CurvePoint[]> }
  | { readonly kind: "exposure"; readonly exposure: number; readonly offset: number; readonly gamma: number }
  | { readonly kind: "vibrance"; readonly vibrance: number; readonly saturation: number }
  | {
      readonly kind: "hue-saturation";
      readonly colorize: boolean;
      readonly master: HueSatValues;
      readonly ranges: Readonly<Record<HueRange, HueSatRange>>;
    }
  | {
      readonly kind: "color-balance";
      /** Cyan–Red, Magenta–Green, Yellow–Blue, each −100…100, per tonal range. */
      readonly shadows: readonly [number, number, number];
      readonly midtones: readonly [number, number, number];
      readonly highlights: readonly [number, number, number];
      readonly preserveLuminosity: boolean;
    }
  | {
      readonly kind: "black-white";
      /** −200…300 % each. */
      readonly reds: number;
      readonly yellows: number;
      readonly greens: number;
      readonly cyans: number;
      readonly blues: number;
      readonly magentas: number;
      readonly tint: boolean;
      readonly tintColor: RGB;
    }
  | { readonly kind: "photo-filter"; readonly color: RGB; readonly density: number; readonly preserveLuminosity: boolean }
  | { readonly kind: "channel-mixer"; readonly monochrome: boolean; readonly red: MixerRow; readonly green: MixerRow; readonly blue: MixerRow; readonly gray: MixerRow }
  | { readonly kind: "color-lookup"; readonly lut: ColorLookupTable | null }
  | { readonly kind: "invert" }
  | { readonly kind: "posterize"; readonly levels: number }
  | { readonly kind: "threshold"; readonly level: number }
  | { readonly kind: "gradient-map"; readonly gradient: Gradient; readonly reverse: boolean; readonly dither: boolean }
  | { readonly kind: "selective-color"; readonly absolute: boolean; readonly colors: Readonly<Record<SelectiveRange, CMYK>> };

export type AdjustmentKind = Adjustment["kind"];

/** A 3D LUT (Color Lookup): `size`³ RGB entries, red fastest, values 0–1. */
export interface ColorLookupTable {
  readonly name: string;
  readonly size: number;
  readonly data: Float32Array;
}

/** Photoshop's adjustment-layer menu, in order, with its names. */
export const ADJUSTMENTS: readonly { readonly kind: AdjustmentKind; readonly label: string }[] = [
  { kind: "brightness-contrast", label: "Brightness/Contrast" },
  { kind: "levels", label: "Levels" },
  { kind: "curves", label: "Curves" },
  { kind: "exposure", label: "Exposure" },
  { kind: "vibrance", label: "Vibrance" },
  { kind: "hue-saturation", label: "Hue/Saturation" },
  { kind: "color-balance", label: "Color Balance" },
  { kind: "black-white", label: "Black & White" },
  { kind: "photo-filter", label: "Photo Filter" },
  { kind: "channel-mixer", label: "Channel Mixer" },
  { kind: "color-lookup", label: "Color Lookup" },
  { kind: "invert", label: "Invert" },
  { kind: "posterize", label: "Posterize" },
  { kind: "threshold", label: "Threshold" },
  { kind: "gradient-map", label: "Gradient Map" },
  { kind: "selective-color", label: "Selective Color" },
];

export const adjustmentLabel = (k: AdjustmentKind) => ADJUSTMENTS.find((a) => a.kind === k)!.label;

const LEVELS_IDENTITY: LevelsChannel = { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };
const CURVE_IDENTITY: readonly CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 255, y: 255 },
];
const NO_HUE: HueSatValues = { hue: 0, saturation: 0, lightness: 0 };
const NO_CMYK: CMYK = { cyan: 0, magenta: 0, yellow: 0, black: 0 };

/** Photoshop's default spans for Hue/Saturation's ranges. */
export const HUE_RANGE_SPANS: Readonly<Record<HueRange, readonly [number, number, number, number]>> = {
  reds: [315, 345, 15, 45],
  yellows: [15, 45, 75, 105],
  greens: [75, 105, 135, 165],
  cyans: [135, 165, 195, 225],
  blues: [195, 225, 255, 285],
  magentas: [255, 285, 315, 345],
};

/** Photoshop's Photo Filter presets. */
export const PHOTO_FILTERS: readonly { readonly name: string; readonly color: RGB }[] = [
  { name: "Warming Filter (85)", color: { r: 236, g: 138, b: 0 } },
  { name: "Warming Filter (LBA)", color: { r: 250, g: 150, b: 0 } },
  { name: "Warming Filter (81)", color: { r: 235, g: 177, b: 19 } },
  { name: "Cooling Filter (80)", color: { r: 0, g: 109, b: 255 } },
  { name: "Cooling Filter (LBB)", color: { r: 0, g: 93, b: 255 } },
  { name: "Cooling Filter (82)", color: { r: 0, g: 181, b: 255 } },
  { name: "Red", color: { r: 234, g: 26, b: 26 } },
  { name: "Orange", color: { r: 243, g: 132, b: 23 } },
  { name: "Yellow", color: { r: 249, g: 227, b: 28 } },
  { name: "Green", color: { r: 25, g: 201, b: 25 } },
  { name: "Cyan", color: { r: 29, g: 203, b: 234 } },
  { name: "Blue", color: { r: 29, g: 53, b: 234 } },
  { name: "Violet", color: { r: 155, g: 29, b: 234 } },
  { name: "Magenta", color: { r: 227, g: 24, b: 227 } },
  { name: "Sepia", color: { r: 172, g: 122, b: 51 } },
  { name: "Deep Red", color: { r: 255, g: 0, b: 0 } },
  { name: "Deep Blue", color: { r: 0, g: 34, b: 205 } },
  { name: "Deep Emerald", color: { r: 0, g: 140, b: 0 } },
  { name: "Deep Yellow", color: { r: 255, g: 213, b: 0 } },
  { name: "Underwater", color: { r: 0, g: 193, b: 177 } },
];

/**
 * Photoshop's defaults for a new adjustment. Gradient Map runs from the
 * foreground colour to the background colour, as in Photoshop.
 */
export function defaultAdjustment(kind: AdjustmentKind, foreground: RGB = { r: 0, g: 0, b: 0 }, background: RGB = { r: 255, g: 255, b: 255 }): Adjustment {
  switch (kind) {
    case "brightness-contrast":
      return { kind, brightness: 0, contrast: 0, legacy: false };
    case "levels":
      return { kind, channels: { rgb: LEVELS_IDENTITY, red: LEVELS_IDENTITY, green: LEVELS_IDENTITY, blue: LEVELS_IDENTITY } };
    case "curves":
      return { kind, channels: { rgb: CURVE_IDENTITY, red: CURVE_IDENTITY, green: CURVE_IDENTITY, blue: CURVE_IDENTITY } };
    case "exposure":
      return { kind, exposure: 0, offset: 0, gamma: 1 };
    case "vibrance":
      return { kind, vibrance: 0, saturation: 0 };
    case "hue-saturation":
      return {
        kind,
        colorize: false,
        master: NO_HUE,
        ranges: Object.fromEntries(HUE_RANGES.map((r) => [r, { ...NO_HUE, span: HUE_RANGE_SPANS[r] }])) as Record<HueRange, HueSatRange>,
      };
    case "color-balance":
      return { kind, shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLuminosity: true };
    case "black-white":
      return { kind, reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: false, tintColor: { r: 225, g: 211, b: 179 } };
    case "photo-filter":
      return { kind, color: PHOTO_FILTERS[0].color, density: 25, preserveLuminosity: true };
    case "channel-mixer":
      return {
        kind,
        monochrome: false,
        red: { red: 100, green: 0, blue: 0, constant: 0 },
        green: { red: 0, green: 100, blue: 0, constant: 0 },
        blue: { red: 0, green: 0, blue: 100, constant: 0 },
        gray: { red: 40, green: 40, blue: 20, constant: 0 },
      };
    case "color-lookup":
      return { kind, lut: null };
    case "invert":
      return { kind };
    case "posterize":
      return { kind, levels: 4 };
    case "threshold":
      return { kind, level: 128 };
    case "gradient-map":
      return {
        kind,
        gradient: {
          stops: [
            { location: 0, color: foreground, midpoint: 0.5 },
            { location: 1, color: background, midpoint: 0.5 },
          ],
        },
        reverse: false,
        dither: false,
      };
    case "selective-color":
      return { kind, absolute: false, colors: Object.fromEntries(SELECTIVE_RANGES.map((r) => [r, NO_CMYK])) as Record<SelectiveRange, CMYK> };
  }
}

// ---------------------------------------------------------------------------
// Programs: what adjustments compile to.

/** Per-channel tone curves, sampled over [0, 1] (any length ≥ 2), linearly interpolated. */
export interface CurvesProgram {
  readonly kind: "curves";
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  /** Indexed by luminosity (0.3 R + 0.59 G + 0.11 B) instead of each channel (Gradient Map, Threshold). */
  readonly luma: boolean;
  /** The result keeps the original's luminosity (Photo Filter). */
  readonly preserveLuminosity: boolean;
}

export type Program =
  | CurvesProgram
  | {
      readonly kind: "hue-saturation";
      /** Per hue (N entries over [0, 1]): hue shift in turns (Colorize: the hue), saturation (mapped), lightness, 0. */
      readonly map: Float32Array;
      /** Master lightness: what's mixed in (`lift`) and kept (`keep`). */
      readonly lift: number;
      readonly keep: number;
      readonly colorize: boolean;
    }
  | { readonly kind: "vibrance"; readonly luma: number; readonly chroma: number }
  | { readonly kind: "selective-color"; readonly table: Float32Array }
  | {
      readonly kind: "black-white";
      readonly weights: Float32Array;
      readonly tint: boolean;
      readonly hue: number;
      readonly hueLuma: number;
      readonly chroma: number;
      readonly low: number;
      readonly high: number;
    }
  | { readonly kind: "channel-mixer"; readonly matrix: Float32Array }
  | { readonly kind: "lut3d"; readonly size: number; readonly data: Float32Array };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ramp = (n = 256) => Float32Array.from({ length: n }, (_, i) => i / (n - 1));
const curves = (r: Float32Array, g = r, b = r, luma = false, preserveLuminosity = false): CurvesProgram => ({ kind: "curves", r, g, b, luma, preserveLuminosity });

/** Samples a curve through `points` (0–255) at `n` evenly spaced inputs, as 0–1 outputs (clamped). */
export function sampleCurve(points: readonly CurvePoint[], n = 256): Float32Array {
  const pts = [...points].sort((a, b) => a.x - b.x);
  const out = new Float32Array(n);
  // Smooth (natural cubic) between corners: each run of points gets its own spline.
  const runs: CurvePoint[][] = [[pts[0]]];
  for (let i = 1; i < pts.length; i++) {
    runs[runs.length - 1].push(pts[i]);
    if (pts[i].corner && i < pts.length - 1) runs.push([pts[i]]);
  }
  const slopes = runs.map((r) => splineSlopes(r));
  for (let i = 0; i < n; i++) {
    const x = (i * 255) / (n - 1);
    let y: number;
    if (x <= pts[0].x) y = pts[0].y;
    else if (x >= pts[pts.length - 1].x) y = pts[pts.length - 1].y;
    else {
      const ri = runs.findIndex((r) => x <= r[r.length - 1].x);
      y = hermite(runs[ri], slopes[ri], x);
    }
    out[i] = clamp01(y / 255);
  }
  return out;
}

/** Slopes at each point of a natural cubic spline through `p` (a tridiagonal system, solved directly). */
function splineSlopes(p: readonly CurvePoint[]): Float64Array {
  const n = p.length;
  const k = new Float64Array(n);
  if (n < 2) return k;
  if (n === 2) {
    k[0] = k[1] = (p[1].y - p[0].y) / (p[1].x - p[0].x);
    return k;
  }
  const a = new Float64Array(n), b = new Float64Array(n), c = new Float64Array(n), d = new Float64Array(n);
  const h = (i: number) => p[i + 1].x - p[i].x;
  const dy = (i: number) => (p[i + 1].y - p[i].y) / (h(i) * h(i));
  b[0] = 2 / h(0);
  c[0] = 1 / h(0);
  d[0] = 3 * dy(0);
  for (let i = 1; i < n - 1; i++) {
    a[i] = 1 / h(i - 1);
    b[i] = 2 * (1 / h(i - 1) + 1 / h(i));
    c[i] = 1 / h(i);
    d[i] = 3 * (dy(i - 1) + dy(i));
  }
  a[n - 1] = 1 / h(n - 2);
  b[n - 1] = 2 / h(n - 2);
  d[n - 1] = 3 * dy(n - 2);
  // Thomas algorithm.
  for (let i = 1; i < n; i++) {
    const m = a[i] / b[i - 1];
    b[i] -= m * c[i - 1];
    d[i] -= m * d[i - 1];
  }
  k[n - 1] = d[n - 1] / b[n - 1];
  for (let i = n - 2; i >= 0; i--) k[i] = (d[i] - c[i] * k[i + 1]) / b[i];
  return k;
}

function hermite(p: readonly CurvePoint[], k: Float64Array, x: number): number {
  let i = 1;
  while (p[i].x < x) i++;
  const x0 = p[i - 1].x, x1 = p[i].x, y0 = p[i - 1].y, y1 = p[i].y;
  const t = (x - x0) / (x1 - x0);
  const a = k[i - 1] * (x1 - x0) - (y1 - y0), b = -k[i] * (x1 - x0) + (y1 - y0);
  return (1 - t) * y0 + t * y1 + t * (1 - t) * (a * (1 - t) + b * t);
}

/** Linear lookup in a curve sampled over [0, 1]. */
export function lookup(curve: Float32Array, v: number): number {
  const p = clamp01(v) * (curve.length - 1);
  const i = Math.min(curve.length - 2, Math.floor(p));
  const t = p - i;
  return curve[i] * (1 - t) + curve[i + 1] * t;
}

/** Composes curves: `outer(inner(x))`. */
const compose = (inner: Float32Array, outer: Float32Array) => inner.map((v) => lookup(outer, v));

/** Hue/Saturation's saturation response: Photoshop's slider is far from linear above 0. */
const satCurve = (s: number) => (s < 0 ? s : Math.pow(Math.tan((Math.PI / 2) * Math.min(s, 0.9999)), 1.3));
const satInverse = (s: number) => (s < 0 ? s : Math.atan2(Math.pow(s, 1 / 1.3), 1) / (Math.PI / 2));

/** Signed shortest turn from hue `a` to hue `b` (both in turns). */
function hueDelta(a: number, b: number) {
  let d = b - a;
  if (Math.abs(d - 1) < Math.abs(d)) d -= 1;
  else if (Math.abs(d + 1) < Math.abs(d)) d += 1;
  return d;
}

/** How much hue `h` belongs to the colour centred at `centre` (a triangle a sixth of the wheel wide each way). */
export const hueWeight = (h: number, centre: number) => {
  const e = hueDelta(h, centre) * 6;
  return clamp01(e < 0 ? 1 + e : 1 - e);
};

const lumOf = (r: number, g: number, b: number) => 0.3 * r + 0.59 * g + 0.11 * b;

/** Compiles an adjustment's settings into what's applied per pixel. */
export function compile(a: Adjustment): Program {
  switch (a.kind) {
    case "brightness-contrast":
      return curves(brightnessContrastCurve(a.brightness, a.contrast, a.legacy));
    case "levels":
      return levelsProgram(a.channels);
    case "curves": {
      // Each channel's curve, then the composite (RGB) curve.
      const master = sampleCurve(a.channels.rgb);
      return curves(compose(sampleCurve(a.channels.red), master), compose(sampleCurve(a.channels.green), master), compose(sampleCurve(a.channels.blue), master));
    }
    case "exposure":
      return curves(exposureCurve(a.exposure, a.offset, a.gamma));
    case "vibrance": {
      const p = a.vibrance / 100;
      const chroma = 1 + p * (p > 0 ? 0.25 : 0.5);
      return { kind: "vibrance", luma: 0.8 + 0.2 / chroma, chroma: chroma * (1 + a.saturation / 100) };
    }
    case "hue-saturation":
      return hueSatProgram(a);
    case "color-balance":
      return colorBalanceProgram(a);
    case "black-white":
      return blackWhiteProgram(a);
    case "photo-filter": {
      const d = a.density / 100;
      const ch = (c: number) => ramp().map((x) => d * clamp01(x * (c / 255)) + (1 - d) * x);
      return curves(ch(a.color.r), ch(a.color.g), ch(a.color.b), false, a.preserveLuminosity);
    }
    case "channel-mixer": {
      const rows = a.monochrome ? [a.gray, a.gray, a.gray] : [a.red, a.green, a.blue];
      return { kind: "channel-mixer", matrix: Float32Array.from(rows.flatMap((r) => [r.red, r.green, r.blue, r.constant].map((v) => v / 100))) };
    }
    case "color-lookup":
      return a.lut ? { kind: "lut3d", size: a.lut.size, data: a.lut.data } : curves(ramp(2));
    case "invert":
      return curves(ramp().map((x) => 1 - x));
    case "posterize": {
      const n = Math.max(2, Math.min(255, Math.round(a.levels)));
      return curves(Float32Array.from({ length: 256 }, (_, x) => Math.floor((x * n) / 255.001) / (n - 1)));
    }
    case "threshold": {
      // A step: luminosity at or above the level becomes white.
      const t = Float32Array.from({ length: 256 }, (_, x) => (x >= a.level ? 1 : 0));
      return curves(t, t, t, true);
    }
    case "gradient-map": {
      const s = sampleGradient(a.gradient, 1024, a.reverse);
      return curves(s.r, s.g, s.b, true);
    }
    case "selective-color":
      return selectiveColorProgram(a);
  }
}

/**
 * Brightness/Contrast. Legacy is a straight shift and stretch. The modern
 * one is two curves, as Photoshop's behaves: brightness bends the midtones
 * (keeping black and white), contrast an S-curve.
 */
function brightnessContrastCurve(brightness: number, contrast: number, legacy: boolean): Float32Array {
  if (legacy) {
    const shift = brightness / 255;
    let m = 1 + contrast / 100;
    if (m > 1) m = 1 + Math.tan(((Math.PI / 2) * contrast) / 101);
    return ramp().map((x) => clamp01((x + shift) * m + (1 - m) / 2));
  }
  const N = 1024;
  const c = -30 + (60 * (contrast + 100)) / 200;
  const contrastCurve = sampleCurve([{ x: 0, y: 0 }, { x: 64, y: 64 - c }, { x: 192, y: 192 + c }, { x: 255, y: 255 }], N);
  const k = Math.abs(brightness) / 100;
  let bright = sampleCurve(
    [{ x: 0, y: 0 }, { x: 130 - k * 26, y: 130 + k * 51 }, { x: 233 - k * 48, y: 233 + k * 10 }, { x: 255, y: 255 }].sort((a, b) => a.x - b.x),
    N,
  );
  if (brightness < 0) {
    // Darkening is the brightening curve's inverse.
    const inv = new Float32Array(N);
    for (let i = 0, j = N - 1; i < N; i++) {
      const v = i / (N - 1);
      j = N - 1;
      while (j > 1 && bright[j] > v) j--;
      inv[i] = j / (N - 1);
    }
    bright = inv;
  }
  return bright.map((v) => contrastCurve[Math.round((N - 1) * v)]);
}

/**
 * Levels, in Photoshop's order: each channel's input range and gamma, then
 * the composite's; then each channel's output range, then the composite's.
 */
function levelsProgram(ch: ChannelSet<LevelsChannel>): CurvesProgram {
  const m = ch.rgb;
  const input = (l: LevelsChannel, x: number) => clamp01((x - l.inBlack / 255) / Math.max(1e-6, (l.inWhite - l.inBlack) / 255));
  const output = (l: LevelsChannel, x: number) => clamp01(l.outBlack / 255 + (x * (l.outWhite - l.outBlack)) / 255);
  const channel = (c: LevelsChannel) =>
    ramp().map((x) => {
      let v = clamp01(Math.pow(input(c, x), 1 / c.gamma));
      v = clamp01(Math.pow(input(m, v), 1 / m.gamma));
      return output(m, output(c, v));
    });
  return curves(channel(ch.red), channel(ch.green), channel(ch.blue));
}

/** Exposure: exposure in stops on the highlights, offset on the shadows, then a gamma (Photopea's fit of Photoshop's 8-bit behaviour). */
function exposureCurve(exposure: number, offset: number, gamma: number): Float32Array {
  const f = Math.pow(Math.abs(offset), 1 / (Math.PI / 2));
  return ramp().map((x) => {
    let v = x;
    if (offset > 0) {
      v = Math.max(offset / Math.E, v) * Math.exp(offset / 1.75 + exposure / Math.PI);
      v = (1 - f) * v + f;
    } else {
      v = v * Math.exp(-offset * 1.75 + exposure / Math.PI) - f * 1.14;
    }
    return clamp01(Math.pow(Math.max(0, v), 1 / gamma));
  });
}

function hueSatProgram(a: Extract<Adjustment, { kind: "hue-saturation" }>): Program {
  const N = 256;
  const hue = new Float64Array(N), sat = new Float64Array(N), light = new Float64Array(N);
  const masterSat = satCurve(a.master.saturation / 100);
  for (let i = 0; i < N; i++) {
    if (a.colorize) {
      hue[i] = a.master.hue / 360;
      sat[i] = masterSat;
      continue;
    }
    const h0 = i / (N - 1);
    hue[i] = a.master.hue / 360;
    for (const r of HUE_RANGES) {
      const { span, ...v } = a.ranges[r];
      const s = span.map((d, k) => (k > 0 && d < span[0] ? d + 360 : d));
      let deg = h0 * 360;
      if (deg < s[0]) deg += 360;
      const up = (deg - s[0]) / (s[1] - s[0]), down = (deg - s[2]) / (s[3] - s[2]);
      const w = up < 0 ? 0 : up < 1 ? up : down < 0 ? 1 : down < 1 ? 1 - down : 0;
      hue[i] += (w * v.hue) / 360;
      sat[i] += w * satCurve(v.saturation / 100);
      light[i] += (w * v.lightness) / 100;
    }
  }
  const map = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const s = a.colorize ? sat[i] : (1 + sat[i]) * (1 + masterSat) - 1;
    map[i * 4] = hue[i];
    map[i * 4 + 1] = satInverse(s);
    map[i * 4 + 2] = a.colorize ? 0 : Math.max(-1, Math.min(1, light[i]));
  }
  const l = a.master.lightness / 100;
  return { kind: "hue-saturation", map, lift: Math.abs(l) * (l < 0 ? 0 : 1), keep: 1 - Math.abs(l), colorize: a.colorize };
}

function colorBalanceProgram(a: Extract<Adjustment, { kind: "color-balance" }>): CurvesProgram {
  const ranges = [a.shadows, a.midtones, a.highlights].map((v) => {
    const t = v.map((x) => x / 100);
    // Preserve Luminosity balances each range's push around zero.
    const mid = a.preserveLuminosity ? (Math.min(...t) + Math.max(...t)) / 2 : 0;
    return t.map((x) => x - mid);
  });
  const [sh, mi, hi] = ranges;
  const channel = (c: number) =>
    ramp().map((x) => {
      let v = x, n = hi[c], w = Math.abs(n);
      v = w * (n < 0 ? Math.pow(v, Math.SQRT2) : 1.63 * (Math.sqrt(v + 0.04) - 0.2)) + (1 - w) * v;
      n = mi[c];
      w = Math.abs(n);
      v = w * (n < 0 ? Math.pow(v, 2) : Math.min(2.35 * (Math.sqrt(v + 0.09) - 0.3), Math.sqrt(v))) + (1 - w) * v;
      n = sh[c];
      w = Math.abs(n);
      v = w * (n < 0 ? (v < 0.4 ? 0 : Math.pow((v - 0.4) / 0.6, Math.SQRT2)) : Math.pow(v, Math.SQRT2 / 2)) + (1 - w) * v;
      return clamp01(v);
    });
  return curves(channel(0), channel(1), channel(2));
}

function blackWhiteProgram(a: Extract<Adjustment, { kind: "black-white" }>): Program {
  const weights = Float32Array.from([a.reds, a.yellows, a.greens, a.cyans, a.blues, a.magentas].map((v) => (v - 50) / 50));
  const { r, g, b } = a.tintColor;
  const hsv = rgbToHsv(r / 255, g / 255, b / 255);
  const pure = hslToRgb(hsv.h, 1, 0.5);
  const hueLuma = lumOf(pure.r, pure.g, pure.b);
  const chroma = hsv.s * hsv.v;
  let low = 0.5, high = 0.5;
  if (hueLuma !== 0.5) {
    low = (chroma * (0.5 - hueLuma)) / (0.5 / hueLuma - 1);
    high = (1 - chroma * (0.5 - hueLuma) - 1 / (2 * (1 - hueLuma))) / (1 - 1 / (2 * (1 - hueLuma)));
  }
  return { kind: "black-white", weights, tint: a.tint, hue: hsv.h, hueLuma, chroma, low, high };
}

function selectiveColorProgram(a: Extract<Adjustment, { kind: "selective-color" }>): Program {
  const table = new Float32Array(9 * 6);
  SELECTIVE_RANGES.forEach((range, i) => {
    const c = a.colors[range];
    const [cy, mg, ye, bk] = [c.cyan, c.magenta, c.yellow, c.black].map((v) => v / 100);
    if (a.absolute) table.set([1, 1, 1, cy * (1 + bk) + bk, mg * (1 + bk) + bk, ye * (1 + bk) + bk], i * 6);
    else table.set([(1 + cy) * (1 + bk), (1 + mg) * (1 + bk), (1 + ye) * (1 + bk), 0, 0, 0], i * 6);
  });
  return { kind: "selective-color", table };
}

/**
 * A gradient sampled at `n` points: each pair of stops interpolated with
 * its midpoint (where the two colours mix evenly) as Photoshop's Classic
 * gradients do.
 */
export function sampleGradient(g: Gradient, n: number, reverse = false): { r: Float32Array; g: Float32Array; b: Float32Array } {
  const stops = [...g.stops].sort((a, b) => a.location - b.location);
  const out = { r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    let t = i / (n - 1);
    if (reverse) t = 1 - t;
    let c: RGB;
    if (t <= stops[0].location) c = stops[0].color;
    else if (t >= stops[stops.length - 1].location) c = stops[stops.length - 1].color;
    else {
      let k = 1;
      while (stops[k].location < t) k++;
      const a = stops[k - 1], b = stops[k];
      const u = (t - a.location) / Math.max(1e-9, b.location - a.location);
      // The midpoint maps to an even mix: u' = u^(log 0.5 / log m).
      const m = Math.min(0.999, Math.max(0.001, a.midpoint));
      const w = Math.pow(u, Math.log(0.5) / Math.log(m));
      c = { r: a.color.r + (b.color.r - a.color.r) * w, g: a.color.g + (b.color.g - a.color.g) * w, b: a.color.b + (b.color.b - a.color.b) * w };
    }
    out.r[i] = c.r / 255;
    out.g[i] = c.g / 255;
    out.b[i] = c.b / 255;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Colour models (the forms Photoshop's adjustments work in).

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return { h, s, l };
}

const hueToRgb = (p: number, q: number, t: number) => {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
};

export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  if (s === 0) return { r: l, g: l, b: l };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return { r: hueToRgb(p, q, h + 1 / 3), g: hueToRgb(p, q, h), b: hueToRgb(p, q, h - 1 / 3) };
}

export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

// ---------------------------------------------------------------------------
// Applying programs (the CPU reference; `gpu/adjust.ts` mirrors it).

let OR = 0, OG = 0, OB = 0;

/** Applies `p` to an unpremultiplied colour in [0, 1]; the result is in `out` (r, g, b). */
export function applyProgram(p: Program, r: number, g: number, b: number, out: Float32Array | number[]): void {
  run(p, r, g, b);
  out[0] = OR;
  out[1] = OG;
  out[2] = OB;
}

function run(p: Program, r: number, g: number, b: number) {
  switch (p.kind) {
    case "curves": {
      if (p.luma) {
        const y = lumOf(r, g, b);
        r = g = b = y;
      }
      let nr = lookup(p.r, r), ng = lookup(p.g, g), nb = lookup(p.b, b);
      if (p.preserveLuminosity) {
        const before = lumOf(r, g, b), after = lumOf(nr, ng, nb);
        if (before > after) {
          const k = (before - after) / (1 - after);
          nr += k * (1 - nr);
          ng += k * (1 - ng);
          nb += k * (1 - nb);
        } else if (after === 0) nr = ng = nb = 0;
        else {
          const k = before / after;
          nr *= k;
          ng *= k;
          nb *= k;
        }
      }
      OR = nr;
      OG = ng;
      OB = nb;
      return;
    }
    case "hue-saturation": {
      const n = p.map.length / 4 - 1;
      const pos = rgbToHsl(r, g, b).h * n;
      const i = Math.min(n, Math.floor(pos)), j = Math.min(n, i + 1), t = pos - Math.floor(pos);
      const m = p.map;
      const hue = (1 - t) * m[i * 4] + t * m[j * 4];
      let sat = (1 - t) * m[i * 4 + 1] + t * m[j * 4 + 1];
      const light = (1 - t) * m[i * 4 + 2] + t * m[j * 4 + 2];
      // Per-range lightness pulls towards white (or black) through the colour's extreme channel.
      const k = light > 0 ? light : -light;
      const towards = light > 0 ? Math.max(r, g, b) : Math.min(r, g, b);
      const lift = p.lift + p.keep * k * towards, keep = p.keep * (1 - k);
      r = lift + keep * r;
      g = lift + keep * g;
      b = lift + keep * b;
      const hsl = rgbToHsl(r, g, b);
      let s: number;
      if (p.colorize) s = sat;
      else {
        sat = satCurve(sat);
        s = Math.min(hsl.s * (1 + sat), 1);
      }
      const h = p.colorize ? hue : hsl.h + hue;
      const o = hslToRgb(((h % 1) + 1) % 1, Math.max(0, s), hsl.l);
      OR = o.r;
      OG = o.g;
      OB = o.b;
      return;
    }
    case "vibrance": {
      // In a gamma-2.4 YUV space: chroma scaled, luma slightly compensated.
      const e = 2.4;
      const lr = Math.pow(r, e), lg = Math.pow(g, e), lb = Math.pow(b, e);
      const y = (0.299 * lr + 0.587 * lg + 0.114 * lb) * p.luma;
      const u = (-0.147 * lr - 0.289 * lg + 0.436 * lb) * p.chroma;
      const v = (0.615 * lr - 0.515 * lg - 0.1 * lb) * p.chroma;
      OR = Math.pow(clamp01(y + 1.13983 * v), 1 / e);
      OG = Math.pow(clamp01(y - 0.39465 * u - 0.5806 * v), 1 / e);
      OB = Math.pow(clamp01(y + 2.03211 * u), 1 / e);
      return;
    }
    case "selective-color": {
      const t = p.table;
      const hsl = rgbToHsl(r, g, b);
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const c = 1 - r, m = 1 - g, y = 1 - b;
      let dc = 0, dm = 0, dy = 0;
      for (let k = 0; k < 9; k++) {
        const o = k * 6;
        if (t[o] === 1 && t[o + 1] === 1 && t[o + 2] === 1 && t[o + 3] === 0 && t[o + 4] === 0 && t[o + 5] === 0) continue;
        const w =
          k < 6 ? hueWeight(hsl.h, k / 6) * hsl.s * 2 * Math.min(hsl.l, 1 - hsl.l)
          : k === 6 ? Math.max(0, min - 0.5) * 2
          : k === 7 ? 1 - (Math.abs(max - 0.5) + Math.abs(min - 0.5))
          : Math.max(0, 0.5 - max) * 2;
        dc += (clamp01(c * t[o] + t[o + 3]) - c) * w;
        dm += (clamp01(m * t[o + 1] + t[o + 4]) - m) * w;
        dy += (clamp01(y * t[o + 2] + t[o + 5]) - y) * w;
      }
      OR = 1 - clamp01(c + dc);
      OG = 1 - clamp01(m + dm);
      OB = 1 - clamp01(y + dy);
      return;
    }
    case "black-white": {
      const hsl = rgbToHsl(r, g, b);
      let n = 0;
      for (let k = 0; k < 6; k++) n += Math.min(1, 1.7 * (1 - hsl.l)) * hsl.s * p.weights[k] * hueWeight(hsl.h, k / 6);
      const gray = clamp01(hsl.l * (1 + n));
      let o: { r: number; g: number; b: number };
      if (p.tint) {
        const l = gray < p.low ? gray * (0.5 / p.hueLuma) : gray < p.high ? gray + p.chroma * (0.5 - p.hueLuma) : 1 - ((1 - gray) * 0.5) / (1 - p.hueLuma);
        const s = Math.min(1, p.chroma + 3 * p.chroma * Math.abs(gray - 0.5 * (p.low + p.high)));
        o = hslToRgb(p.hue, s, clamp01(l));
      } else o = { r: gray, g: gray, b: gray };
      OR = o.r;
      OG = o.g;
      OB = o.b;
      return;
    }
    case "channel-mixer": {
      const m = p.matrix;
      OR = clamp01(m[0] * r + m[1] * g + m[2] * b + m[3]);
      OG = clamp01(m[4] * r + m[5] * g + m[6] * b + m[7]);
      OB = clamp01(m[8] * r + m[9] * g + m[10] * b + m[11]);
      return;
    }
    case "lut3d": {
      const s = p.size, d = p.data;
      const fx = clamp01(r) * (s - 1), fy = clamp01(g) * (s - 1), fz = clamp01(b) * (s - 1);
      const x0 = Math.min(s - 2, Math.floor(fx)), y0 = Math.min(s - 2, Math.floor(fy)), z0 = Math.min(s - 2, Math.floor(fz));
      const tx = fx - x0, ty = fy - y0, tz = fz - z0;
      const at = (x: number, y: number, z: number, c: number) => d[((z * s + y) * s + x) * 3 + c];
      const out = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const c00 = at(x0, y0, z0, c) * (1 - tx) + at(x0 + 1, y0, z0, c) * tx;
        const c10 = at(x0, y0 + 1, z0, c) * (1 - tx) + at(x0 + 1, y0 + 1, z0, c) * tx;
        const c01 = at(x0, y0, z0 + 1, c) * (1 - tx) + at(x0 + 1, y0, z0 + 1, c) * tx;
        const c11 = at(x0, y0 + 1, z0 + 1, c) * (1 - tx) + at(x0 + 1, y0 + 1, z0 + 1, c) * tx;
        out[c] = (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
      }
      [OR, OG, OB] = out;
      return;
    }
  }
}

/** Parses a .cube 3D LUT (Adobe/Resolve format): `LUT_3D_SIZE n` and n³ lines of "r g b", red fastest. */
export function parseCube(text: string, name: string): ColorLookupTable {
  let size = 0;
  let min = [0, 0, 0], max = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === "LUT_3D_SIZE") size = Number(parts[1]);
    else if (parts[0] === "DOMAIN_MIN") min = parts.slice(1, 4).map(Number);
    else if (parts[0] === "DOMAIN_MAX") max = parts.slice(1, 4).map(Number);
    else if (/^[-+\d.]/.test(parts[0]) && parts.length >= 3) values.push(...parts.slice(0, 3).map(Number));
  }
  if (!(size >= 2) || values.length !== size * size * size * 3) throw new Error("Not a 3D LUT (.cube) file.");
  const data = Float32Array.from(values, (v, i) => clamp01((v - min[i % 3]) / (max[i % 3] - min[i % 3])));
  return { name, size, data };
}

// ---------------------------------------------------------------------------
// Image ▸ Adjustments that exist only as commands (no adjustment layer).

/**
 * Equalize: a tone curve that spreads the image's values evenly (histogram
 * equalization over all channels together, so colours keep their balance).
 */
export function equalizeCurve(histogram: Float64Array): Float32Array {
  const total = histogram.reduce((a, b) => a + b, 0);
  const lut = new Float32Array(256);
  if (!total) return ramp();
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += histogram[i];
    lut[i] = acc / total;
  }
  return lut;
}
