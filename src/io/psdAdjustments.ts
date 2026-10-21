import type { AdjustmentLayer, Color as PsdColor, CurvesAdjustmentChannel, HueSaturationAdjustmentChannel, LevelsAdjustmentChannel } from "ag-psd";
import {
  HUE_RANGES,
  HUE_RANGE_SPANS,
  SELECTIVE_RANGES,
  defaultAdjustment,
  parseCube,
  type Adjustment,
  type ChannelSet,
  type CurvePoint,
  type HueSatRange,
  type LevelsChannel,
} from "../core/adjustments";
import type { RGB } from "../core/color";

/**
 * Adjustment layers to and from PSD (as ag-psd models them). Settings are
 * stored in Photoshop's own units, so they round-trip with Photoshop.
 */

/** An ag-psd colour as RGB 0–255 (null for colour models other than RGB). */
export function rgbOf(c: PsdColor | undefined): RGB | null {
  if (!c) return null;
  // ag-psd uses 0–255 for RGB(A) and 0–1 floats for FRGB.
  if ("fr" in c) return { r: Math.round(c.fr * 255), g: Math.round(c.fg * 255), b: Math.round(c.fb * 255) };
  if ("r" in c) return { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) };
  return null;
}

const CHANNELS = ["rgb", "red", "green", "blue"] as const;
/** Gradient stop locations are stored in 1/4096ths. */
const LOCATION = 4096;

const channels = <T>(f: (k: (typeof CHANNELS)[number]) => T): ChannelSet<T> =>
  Object.fromEntries(CHANNELS.map((k) => [k, f(k)])) as unknown as ChannelSet<T>;

const levelsIn = (c: LevelsAdjustmentChannel | undefined): LevelsChannel =>
  c
    ? { inBlack: c.shadowInput, inWhite: c.highlightInput, gamma: c.midtoneInput || 1, outBlack: c.shadowOutput, outWhite: c.highlightOutput }
    : { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };

const curveIn = (c: CurvesAdjustmentChannel | undefined): readonly CurvePoint[] =>
  c && c.length >= 2 ? c.map((p) => ({ x: p.input, y: p.output })) : [{ x: 0, y: 0 }, { x: 255, y: 255 }];

/** Our settings for a PSD adjustment layer; null for what isn't supported (noise gradients, ICC lookups). */
export function fromPsd(a: AdjustmentLayer): Adjustment | null {
  switch (a.type) {
    case "brightness/contrast":
      return { kind: "brightness-contrast", brightness: a.brightness ?? 0, contrast: a.contrast ?? 0, legacy: !!a.useLegacy };
    case "levels":
      return { kind: "levels", channels: channels((k) => levelsIn(a[k])) };
    case "curves":
      return { kind: "curves", channels: channels((k) => curveIn(a[k])) };
    case "exposure":
      return { kind: "exposure", exposure: a.exposure ?? 0, offset: a.offset ?? 0, gamma: a.gamma ?? 1 };
    case "vibrance":
      return { kind: "vibrance", vibrance: a.vibrance ?? 0, saturation: a.saturation ?? 0 };
    case "hue/saturation": {
      const m = a.master;
      // The master record's first four values are Colorize's flag and its hue, saturation and lightness.
      const colorize = !!m?.a;
      const range = (r: (typeof HUE_RANGES)[number]): HueSatRange => {
        const c = a[r];
        return {
          hue: c?.hue ?? 0,
          saturation: c?.saturation ?? 0,
          lightness: c?.lightness ?? 0,
          span: c && (c.a || c.b || c.c || c.d) ? [c.a, c.b, c.c, c.d] : HUE_RANGE_SPANS[r],
        };
      };
      return {
        kind: "hue-saturation",
        colorize,
        master: colorize ? { hue: m!.b, saturation: m!.c, lightness: m!.d } : { hue: m?.hue ?? 0, saturation: m?.saturation ?? 0, lightness: m?.lightness ?? 0 },
        ranges: Object.fromEntries(HUE_RANGES.map((r) => [r, range(r)])) as Record<(typeof HUE_RANGES)[number], HueSatRange>,
      };
    }
    case "color balance": {
      const v = (c: { cyanRed: number; magentaGreen: number; yellowBlue: number } | undefined) =>
        [c?.cyanRed ?? 0, c?.magentaGreen ?? 0, c?.yellowBlue ?? 0] as const;
      return { kind: "color-balance", shadows: v(a.shadows), midtones: v(a.midtones), highlights: v(a.highlights), preserveLuminosity: a.preserveLuminosity ?? true };
    }
    case "black & white": {
      const d = defaultAdjustment("black-white") as Extract<Adjustment, { kind: "black-white" }>;
      return {
        kind: "black-white",
        reds: a.reds ?? d.reds,
        yellows: a.yellows ?? d.yellows,
        greens: a.greens ?? d.greens,
        cyans: a.cyans ?? d.cyans,
        blues: a.blues ?? d.blues,
        magentas: a.magentas ?? d.magentas,
        tint: !!a.useTint,
        tintColor: rgbOf(a.tintColor) ?? d.tintColor,
      };
    }
    case "photo filter": {
      const d = defaultAdjustment("photo-filter") as Extract<Adjustment, { kind: "photo-filter" }>;
      return { kind: "photo-filter", color: rgbOf(a.color) ?? d.color, density: a.density ?? d.density, preserveLuminosity: a.preserveLuminosity ?? true };
    }
    case "channel mixer": {
      const d = defaultAdjustment("channel-mixer") as Extract<Adjustment, { kind: "channel-mixer" }>;
      return { kind: "channel-mixer", monochrome: !!a.monochrome, red: a.red ?? d.red, green: a.green ?? d.green, blue: a.blue ?? d.blue, gray: a.gray ?? d.gray };
    }
    case "color lookup": {
      const bytes = a.lut3DFileData;
      if (!bytes || a.lutFormat !== "cube") return { kind: "color-lookup", lut: null };
      try {
        return { kind: "color-lookup", lut: parseCube(new TextDecoder().decode(bytes), a.lut3DFileName ?? a.name ?? "LUT") };
      } catch {
        return { kind: "color-lookup", lut: null };
      }
    }
    case "invert":
      return { kind: "invert" };
    case "posterize":
      return { kind: "posterize", levels: a.levels ?? 4 };
    case "threshold":
      return { kind: "threshold", level: a.level ?? 128 };
    case "gradient map": {
      if (a.gradientType !== "solid" || !a.colorStops?.length) return null;
      return {
        kind: "gradient-map",
        gradient: { stops: a.colorStops.map((s) => ({ location: s.location / LOCATION, midpoint: s.midpoint, color: rgbOf(s.color) ?? { r: 0, g: 0, b: 0 } })) },
        reverse: !!a.reverse,
        dither: !!a.dither,
      };
    }
    case "selective color":
      return {
        kind: "selective-color",
        absolute: a.mode === "absolute",
        colors: Object.fromEntries(
          SELECTIVE_RANGES.map((r) => {
            const c = a[r];
            return [r, { cyan: c?.c ?? 0, magenta: c?.m ?? 0, yellow: c?.y ?? 0, black: c?.k ?? 0 }];
          }),
        ) as Extract<Adjustment, { kind: "selective-color" }>["colors"],
      };
  }
}

const levelsOut = (l: LevelsChannel): LevelsAdjustmentChannel => ({
  shadowInput: l.inBlack,
  highlightInput: l.inWhite,
  midtoneInput: l.gamma,
  shadowOutput: l.outBlack,
  highlightOutput: l.outWhite,
});

const hueOut = (v: { hue: number; saturation: number; lightness: number }, span: readonly number[] = [0, 0, 0, 0]): HueSaturationAdjustmentChannel => ({
  a: span[0],
  b: span[1],
  c: span[2],
  d: span[3],
  ...v,
});

/** A PSD adjustment layer's settings for ours. */
export function toPsd(a: Adjustment): AdjustmentLayer {
  switch (a.kind) {
    case "brightness-contrast":
      return { type: "brightness/contrast", brightness: a.brightness, contrast: a.contrast, useLegacy: a.legacy };
    case "levels":
      return { type: "levels", rgb: levelsOut(a.channels.rgb), red: levelsOut(a.channels.red), green: levelsOut(a.channels.green), blue: levelsOut(a.channels.blue) };
    case "curves": {
      const c = (p: readonly CurvePoint[]) => p.map((q) => ({ input: Math.round(q.x), output: Math.round(q.y) }));
      return { type: "curves", rgb: c(a.channels.rgb), red: c(a.channels.red), green: c(a.channels.green), blue: c(a.channels.blue) };
    }
    case "exposure":
      return { type: "exposure", exposure: a.exposure, offset: a.offset, gamma: a.gamma };
    case "vibrance":
      return { type: "vibrance", vibrance: a.vibrance, saturation: a.saturation };
    case "hue-saturation": {
      const m = a.master;
      const master = a.colorize ? hueOut(m, [256, m.hue, m.saturation, m.lightness]) : hueOut(m);
      return { type: "hue/saturation", master, ...Object.fromEntries(HUE_RANGES.map((r) => [r, hueOut(a.ranges[r], a.ranges[r].span)])) };
    }
    case "color-balance": {
      const v = ([cyanRed, magentaGreen, yellowBlue]: readonly number[]) => ({ cyanRed, magentaGreen, yellowBlue });
      return { type: "color balance", shadows: v(a.shadows), midtones: v(a.midtones), highlights: v(a.highlights), preserveLuminosity: a.preserveLuminosity };
    }
    case "black-white":
      return {
        type: "black & white",
        reds: a.reds,
        yellows: a.yellows,
        greens: a.greens,
        cyans: a.cyans,
        blues: a.blues,
        magentas: a.magentas,
        useTint: a.tint,
        tintColor: { ...a.tintColor },
      };
    case "photo-filter":
      return { type: "photo filter", color: { ...a.color }, density: a.density, preserveLuminosity: a.preserveLuminosity };
    case "channel-mixer":
      return { type: "channel mixer", monochrome: a.monochrome, red: { ...a.red }, green: { ...a.green }, blue: { ...a.blue }, gray: { ...a.gray } };
    case "color-lookup":
      return a.lut
        ? { type: "color lookup", lookupType: "3dlut", lutFormat: "cube", name: a.lut.name, lut3DFileName: `${a.lut.name}.cube`, lut3DFileData: new TextEncoder().encode(cubeText(a.lut)) }
        : { type: "color lookup" };
    case "invert":
      return { type: "invert" };
    case "posterize":
      return { type: "posterize", levels: a.levels };
    case "threshold":
      return { type: "threshold", level: a.level };
    case "gradient-map":
      return {
        type: "gradient map",
        gradientType: "solid",
        name: "Custom",
        reverse: a.reverse,
        dither: a.dither,
        colorStops: a.gradient.stops.map((s) => ({ location: Math.round(s.location * LOCATION), midpoint: s.midpoint, color: { ...s.color } })),
        opacityStops: [
          { location: 0, midpoint: 0.5, opacity: 1 },
          { location: LOCATION, midpoint: 0.5, opacity: 1 },
        ],
      };
    case "selective-color":
      return {
        type: "selective color",
        mode: a.absolute ? "absolute" : "relative",
        ...Object.fromEntries(SELECTIVE_RANGES.map((r) => [r, { c: a.colors[r].cyan, m: a.colors[r].magenta, y: a.colors[r].yellow, k: a.colors[r].black }])),
      };
  }
}

/** A 3D LUT as a .cube file. */
function cubeText(lut: { name: string; size: number; data: Float32Array }): string {
  const lines = [`TITLE "${lut.name}"`, `LUT_3D_SIZE ${lut.size}`];
  for (let i = 0; i < lut.data.length; i += 3) lines.push(`${lut.data[i].toFixed(6)} ${lut.data[i + 1].toFixed(6)} ${lut.data[i + 2].toFixed(6)}`);
  return lines.join("\n");
}
