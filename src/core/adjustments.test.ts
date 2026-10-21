import { describe, expect, it } from "vitest";
import {
  ADJUSTMENTS,
  applyProgram,
  compile,
  defaultAdjustment,
  equalizeCurve,
  parseCube,
  sampleCurve,
  type Adjustment,
  type AdjustmentKind,
} from "./adjustments";

const apply = (a: Adjustment, rgb: [number, number, number]) => {
  const o = [0, 0, 0];
  applyProgram(compile(a), rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, o);
  return o.map((v) => Math.round(v * 255));
};

const SAMPLES: [number, number, number][] = [
  [0, 0, 0],
  [255, 255, 255],
  [200, 30, 60],
  [12, 140, 220],
  [128, 128, 128],
  [250, 240, 10],
];

describe("adjustments", () => {
  const neutral: AdjustmentKind[] = [
    "brightness-contrast",
    "levels",
    "curves",
    "exposure",
    "vibrance",
    "hue-saturation",
    "color-balance",
    "channel-mixer",
    "color-lookup",
    "selective-color",
  ];

  it.each(neutral)("%s does nothing at its defaults", (kind) => {
    for (const c of SAMPLES) for (const [i, v] of apply(defaultAdjustment(kind), c).entries()) expect(Math.abs(v - c[i])).toBeLessThanOrEqual(1);
  });

  it("lists Photoshop's sixteen adjustment layers", () => {
    expect(ADJUSTMENTS).toHaveLength(16);
  });

  it("Levels maps the input black and white points to the output range, through the gamma", () => {
    const l = (o: Partial<{ inBlack: number; inWhite: number; gamma: number; outBlack: number; outWhite: number }>): Adjustment => {
      const a = defaultAdjustment("levels") as Extract<Adjustment, { kind: "levels" }>;
      return { ...a, channels: { ...a.channels, rgb: { ...a.channels.rgb, ...o } } };
    };
    expect(apply(l({ inBlack: 50, inWhite: 200 }), [50, 125, 200])).toEqual([0, 128, 255]);
    expect(apply(l({ outBlack: 20, outWhite: 220 }), [0, 255, 0])).toEqual([20, 220, 20]);
    // Gamma 2 brightens midtones: 0.5^(1/2).
    expect(apply(l({ gamma: 2 }), [128, 128, 128])[0]).toBe(Math.round(Math.sqrt(128 / 255) * 255));
  });

  it("Levels applies a channel's settings before the composite's", () => {
    const a = defaultAdjustment("levels") as Extract<Adjustment, { kind: "levels" }>;
    const both: Adjustment = { ...a, channels: { ...a.channels, red: { ...a.channels.red, inWhite: 128 }, rgb: { ...a.channels.rgb, outWhite: 128 } } };
    expect(apply(both, [64, 64, 64])).toEqual([64, 32, 32]);
  });

  it("Curves pass through their points, smoothly unless a point is a corner", () => {
    const c = sampleCurve([
      { x: 0, y: 0 },
      { x: 64, y: 128 },
      { x: 255, y: 255 },
    ]);
    expect(c[64] * 255).toBeCloseTo(128, 3);
    expect(c[0]).toBe(0);
    expect(c[255]).toBe(1);
    // Smooth: no kink at the point.
    expect(c[65] - c[64]).toBeCloseTo(c[64] - c[63], 2);
    const corner = sampleCurve([
      { x: 0, y: 0 },
      { x: 128, y: 200, corner: true },
      { x: 255, y: 255 },
    ]);
    expect(corner[129] - corner[128]).not.toBeCloseTo(corner[128] - corner[127], 3);
  });

  it("Curves beyond the end points hold their values", () => {
    const a = defaultAdjustment("curves") as Extract<Adjustment, { kind: "curves" }>;
    const c: Adjustment = { ...a, channels: { ...a.channels, rgb: [{ x: 50, y: 30 }, { x: 200, y: 220 }] } };
    expect(apply(c, [10, 250, 50])).toEqual([30, 220, 30]);
  });

  it("Invert, Posterize and Threshold", () => {
    expect(apply({ kind: "invert" }, [200, 30, 60])).toEqual([55, 225, 195]);
    expect(apply({ kind: "posterize", levels: 2 }, [127, 128, 255])).toEqual([0, 255, 255]);
    // Threshold works on luminosity.
    expect(apply({ kind: "threshold", level: 128 }, [255, 0, 0])).toEqual([0, 0, 0]);
    expect(apply({ kind: "threshold", level: 128 }, [0, 255, 0])).toEqual([255, 255, 255]);
  });

  it("Hue/Saturation shifts hue, removes saturation, and lightens to white", () => {
    const hs = (master: { hue?: number; saturation?: number; lightness?: number }, colorize = false): Adjustment => {
      const a = defaultAdjustment("hue-saturation") as Extract<Adjustment, { kind: "hue-saturation" }>;
      return { ...a, colorize, master: { ...a.master, ...master } };
    };
    expect(apply(hs({ hue: 120 }), [255, 0, 0])).toEqual([0, 255, 0]);
    const grey = apply(hs({ saturation: -100 }), [200, 30, 60]);
    expect(grey[0]).toBe(grey[1]);
    expect(grey[0]).toBe(Math.round((200 + 30) / 2)); // HSL lightness
    expect(apply(hs({ lightness: 100 }), [200, 30, 60])).toEqual([255, 255, 255]);
    expect(apply(hs({ lightness: -100 }), [200, 30, 60])).toEqual([0, 0, 0]);
    // Colorize: one hue at the given saturation, keeping lightness.
    const [r, g, b] = apply(hs({ hue: 0, saturation: 100 }, true), [128, 128, 128]);
    expect(r).toBeGreaterThan(g);
    expect(g).toBe(b);
  });

  it("Hue/Saturation ranges affect only their colours", () => {
    const a = defaultAdjustment("hue-saturation") as Extract<Adjustment, { kind: "hue-saturation" }>;
    const reds: Adjustment = { ...a, ranges: { ...a.ranges, reds: { ...a.ranges.reds, saturation: -100 } } };
    const r = apply(reds, [255, 0, 0]);
    expect(r[0]).toBe(r[1]);
    expect(apply(reds, [0, 0, 255])).toEqual([0, 0, 255]);
  });

  it("Black & White weights each colour's contribution", () => {
    const bw = (reds: number) => ({ ...(defaultAdjustment("black-white") as Extract<Adjustment, { kind: "black-white" }>), reds });
    const dark = apply(bw(0), [255, 0, 0]), light = apply(bw(200), [255, 0, 0]);
    expect(dark[0]).toBe(dark[1]);
    expect(light[0]).toBeGreaterThan(dark[0]);
    // Greys stay as they are.
    expect(apply(bw(0), [100, 100, 100])).toEqual([100, 100, 100]);
  });

  it("Photo Filter with Preserve Luminosity keeps luminosity", () => {
    const lum = ([r, g, b]: number[]) => 0.3 * r + 0.59 * g + 0.11 * b;
    const pf = defaultAdjustment("photo-filter");
    const out = apply({ ...pf, density: 100 } as Adjustment, [120, 130, 140]);
    expect(Math.abs(lum(out) - lum([120, 130, 140]))).toBeLessThan(1.5);
    expect(out[0]).toBeGreaterThan(out[2]); // warmed
  });

  it("Channel Mixer mixes channels, or makes greys in Monochrome", () => {
    const m = defaultAdjustment("channel-mixer") as Extract<Adjustment, { kind: "channel-mixer" }>;
    const swap: Adjustment = { ...m, red: { red: 0, green: 0, blue: 100, constant: 0 }, blue: { red: 100, green: 0, blue: 0, constant: 0 } };
    expect(apply(swap, [200, 30, 60])).toEqual([60, 30, 200]);
    const mono = apply({ ...m, monochrome: true }, [200, 30, 60]);
    expect(mono).toEqual([104, 104, 104]);
  });

  it("Gradient Map maps luminosity onto the gradient", () => {
    const g = defaultAdjustment("gradient-map");
    expect(apply(g, [255, 255, 255])).toEqual([255, 255, 255]);
    expect(apply(g, [255, 0, 0])).toEqual([77, 77, 77]);
    expect(apply({ ...g, reverse: true } as Adjustment, [0, 0, 0])).toEqual([255, 255, 255]);
  });

  it("Selective Color adjusts a colour range's CMYK, relatively or absolutely", () => {
    const sc = defaultAdjustment("selective-color") as Extract<Adjustment, { kind: "selective-color" }>;
    const cyanReds = (absolute: boolean): Adjustment => ({ ...sc, absolute, colors: { ...sc.colors, reds: { cyan: 100, magenta: 0, yellow: 0, black: 0 } } });
    // Pure red has no cyan: relative changes scale nothing; absolute adds it.
    expect(apply(cyanReds(false), [255, 0, 0])).toEqual([255, 0, 0]);
    expect(apply(cyanReds(true), [255, 0, 0])).toEqual([0, 0, 0]);
    expect(apply(cyanReds(true), [0, 0, 255])).toEqual([0, 0, 255]);
  });

  it("Vibrance's saturation removes colour", () => {
    const [r, g, b] = apply({ kind: "vibrance", vibrance: 0, saturation: -100 }, [200, 30, 60]);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it("Exposure brightens by stops and darkens with negative offset", () => {
    expect(apply({ kind: "exposure", exposure: 2, offset: 0, gamma: 1 }, [60, 60, 60])[0]).toBeGreaterThan(60);
    expect(apply({ kind: "exposure", exposure: 0, offset: -0.2, gamma: 1 }, [60, 60, 60])[0]).toBeLessThan(60);
    expect(apply({ kind: "exposure", exposure: 0, offset: 0, gamma: 2 }, [64, 64, 64])[0]).toBe(Math.round(Math.sqrt(64 / 255) * 255));
  });

  it("Brightness/Contrast: legacy shifts and stretches; modern keeps black and white", () => {
    expect(apply({ kind: "brightness-contrast", brightness: 100, contrast: 0, legacy: true }, [10, 100, 200])).toEqual([110, 200, 255]);
    const modern = apply({ kind: "brightness-contrast", brightness: 100, contrast: 0, legacy: false }, [0, 128, 255]);
    expect(modern[0]).toBe(0);
    expect(modern[1]).toBeGreaterThan(128);
    expect(modern[2]).toBe(255);
    const dark = apply({ kind: "brightness-contrast", brightness: -100, contrast: 0, legacy: false }, [0, 128, 255]);
    expect(dark[1]).toBeLessThan(128);
    const contrast = apply({ kind: "brightness-contrast", brightness: 0, contrast: 100, legacy: false }, [64, 128, 192]);
    expect(contrast[0]).toBeLessThan(64);
    expect(contrast[2]).toBeGreaterThan(192);
  });

  it("Color Balance pushes a tonal range towards a colour", () => {
    const cb = defaultAdjustment("color-balance") as Extract<Adjustment, { kind: "color-balance" }>;
    const out = apply({ ...cb, midtones: [50, 0, 0], preserveLuminosity: false }, [128, 128, 128]);
    expect(out[0]).toBeGreaterThan(128);
    expect(out[1]).toBe(128);
  });

  it("parses .cube 3D LUTs and applies them trilinearly", () => {
    const lines = ["TITLE \"swap\"", "LUT_3D_SIZE 2"];
    for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) lines.push(`${b} ${g} ${r}`);
    const lut = parseCube(lines.join("\n"), "swap");
    expect(apply({ kind: "color-lookup", lut }, [200, 30, 60])).toEqual([60, 30, 200]);
    expect(() => parseCube("LUT_3D_SIZE 3\n0 0 0", "bad")).toThrow();
  });

  it("Equalize spreads values by the histogram", () => {
    const h = new Float64Array(256);
    h[10] = 1;
    h[20] = 1;
    const lut = equalizeCurve(h);
    expect(lut[10]).toBe(0.5);
    expect(lut[20]).toBe(1);
  });
});
