import type { Filter } from "../core/rasterize";

/**
 * The logic of Photoshop's Image Size dialog, independent of the UI:
 * units, constrained proportions, Resample on/off and Fit To presets.
 *
 * With Resample on, pixel dimensions change and the physical size follows
 * from the resolution; changing the resolution keeps the physical size (so
 * the pixel dimensions change). With Resample off, the pixels are fixed:
 * width, height and resolution are tied, so changing one physical
 * dimension changes the resolution, and proportions are always kept.
 */
export type LengthUnit = "percent" | "pixels" | "inches" | "centimeters" | "millimeters" | "points" | "picas";
export type ResolutionUnit = "ppi" | "ppcm";

export const LENGTH_UNITS: readonly { readonly id: LengthUnit; readonly label: string }[] = [
  { id: "percent", label: "Percent" },
  { id: "pixels", label: "Pixels" },
  { id: "inches", label: "Inches" },
  { id: "centimeters", label: "Centimeters" },
  { id: "millimeters", label: "Millimeters" },
  { id: "points", label: "Points" },
  { id: "picas", label: "Picas" },
];

/** Inches per unit, for physical units. */
const INCHES: Partial<Record<LengthUnit, number>> = { inches: 1, centimeters: 1 / 2.54, millimeters: 1 / 25.4, points: 1 / 72, picas: 1 / 6 };

export const isPhysical = (u: LengthUnit) => u in INCHES;

/** Pixels for a length in `unit` at `ppi`; percent is of `original` pixels. */
export function toPixels(value: number, unit: LengthUnit, ppi: number, original: number): number {
  if (unit === "pixels") return value;
  if (unit === "percent") return (value / 100) * original;
  return value * INCHES[unit]! * ppi;
}

export function fromPixels(px: number, unit: LengthUnit, ppi: number, original: number): number {
  if (unit === "pixels") return px;
  if (unit === "percent") return (px / original) * 100;
  return px / (INCHES[unit]! * ppi);
}

export const ppiFrom = (value: number, unit: ResolutionUnit) => (unit === "ppcm" ? value * 2.54 : value);
export const ppiTo = (ppi: number, unit: ResolutionUnit) => (unit === "ppcm" ? ppi / 2.54 : ppi);

/** Resample methods we implement. (Photoshop's Preserve Details and Bicubic Smoother/Sharper are proprietary variants.) */
export const RESAMPLE_METHODS: readonly { readonly id: "automatic" | Filter; readonly label: string }[] = [
  { id: "automatic", label: "Automatic" },
  { id: "bicubic", label: "Bicubic (smooth gradients)" },
  { id: "nearest", label: "Nearest Neighbor (hard edges)" },
  { id: "bilinear", label: "Bilinear" },
];

/** Our bicubic prefilters for reduction (mipmapped), so it suits both directions. */
export const resampleFilter = (m: (typeof RESAMPLE_METHODS)[number]["id"]): Filter => (m === "automatic" ? "bicubic" : m);

export interface SizeState {
  /** Pixel dimensions: whole numbers once resolved. */
  readonly width: number;
  readonly height: number;
  /** Pixels per inch. */
  readonly resolution: number;
  readonly constrain: boolean;
  readonly resample: boolean;
}

export interface Original {
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
}

export const initialState = (o: Original): SizeState => ({ ...o, constrain: true, resample: true });

const MAX = 300_000;
const clampPx = (v: number) => Math.min(MAX, Math.max(1, Math.round(v)));

/** The user typed a width or height in `unit`. */
export function setDimension(s: SizeState, axis: "width" | "height", value: number, unit: LengthUnit, o: Original): SizeState {
  if (!Number.isFinite(value) || value <= 0) return s;
  const other = axis === "width" ? "height" : "width";
  if (!s.resample) {
    // Pixels are fixed: a physical size sets the resolution (pixel and percent units don't apply).
    if (!isPhysical(unit)) return s;
    const resolution = s[axis] / (value * INCHES[unit]!);
    return { ...s, resolution };
  }
  const px = clampPx(toPixels(value, unit, s.resolution, o[axis]));
  if (!s.constrain) return { ...s, [axis]: px };
  return { ...s, [axis]: px, [other]: clampPx((px * o[other]) / o[axis]) };
}

/** The user changed the resolution. */
export function setResolutionValue(s: SizeState, ppi: number): SizeState {
  if (!Number.isFinite(ppi) || ppi <= 0) return s;
  if (!s.resample) return { ...s, resolution: ppi };
  // Physical size is kept, so the pixel dimensions follow.
  const k = ppi / s.resolution;
  return { ...s, resolution: ppi, width: clampPx(s.width * k), height: clampPx(s.height * k) };
}

/** Turning Resample off returns to the document's own pixels (and resolution), which can't change without it. */
export function setResample(s: SizeState, resample: boolean, o: Original): SizeState {
  if (resample) return { ...s, resample };
  return { ...s, resample, constrain: true, width: o.width, height: o.height, resolution: o.resolution };
}

export interface FitPreset {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly unit: LengthUnit;
  readonly resolution: number;
}

/** Photoshop's Fit To presets. */
export const FIT_PRESETS: readonly FitPreset[] = [
  { label: "4 x 6 in 300 ppi", width: 4, height: 6, unit: "inches", resolution: 300 },
  { label: "5 x 7 in 300 ppi", width: 5, height: 7, unit: "inches", resolution: 300 },
  { label: "8 x 10 in 300 ppi", width: 8, height: 10, unit: "inches", resolution: 300 },
  { label: "8.5 x 11 in 300 ppi", width: 8.5, height: 11, unit: "inches", resolution: 300 },
  { label: "11 x 17 in 300 ppi", width: 11, height: 17, unit: "inches", resolution: 300 },
  { label: "A4 210 x 297 mm 300 ppi", width: 210, height: 297, unit: "millimeters", resolution: 300 },
  { label: "A3 297 x 420 mm 300 ppi", width: 297, height: 420, unit: "millimeters", resolution: 300 },
  { label: "B5 176 x 250 mm 300 ppi", width: 176, height: 250, unit: "millimeters", resolution: 300 },
  { label: "640 x 480 px 72 ppi", width: 640, height: 480, unit: "pixels", resolution: 72 },
  { label: "800 x 600 px 72 ppi", width: 800, height: 600, unit: "pixels", resolution: 72 },
  { label: "1024 x 768 px 72 ppi", width: 1024, height: 768, unit: "pixels", resolution: 72 },
  { label: "1280 x 800 px 72 ppi", width: 1280, height: 800, unit: "pixels", resolution: 72 },
  { label: "1366 x 768 px 72 ppi", width: 1366, height: 768, unit: "pixels", resolution: 72 },
  { label: "1920 x 1080 px 72 ppi", width: 1920, height: 1080, unit: "pixels", resolution: 72 },
];

/**
 * Fit To: the image, proportions kept, fitted within the preset's box (turned
 * to match the image's orientation), at the preset's resolution. Turns
 * Resample on.
 */
export function fitTo(s: SizeState, p: FitPreset, o: Original): SizeState {
  let bw = toPixels(p.width, p.unit, p.resolution, o.width), bh = toPixels(p.height, p.unit, p.resolution, o.height);
  if (bw > bh !== o.width > o.height && o.width !== o.height) [bw, bh] = [bh, bw];
  const k = Math.min(bw / o.width, bh / o.height);
  return { ...s, resample: true, constrain: true, resolution: p.resolution, width: clampPx(o.width * k), height: clampPx(o.height * k) };
}

/** Photoshop's size readout: RGB, 8 bits per channel ("703.1K", "2.64M"). */
export function formatSize(width: number, height: number): string {
  const bytes = width * height * 3;
  const units = ["K", "M", "G"];
  let v = bytes / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(1) : v.toFixed(v >= 10 ? 1 : 2)}${units[i]}`;
}

/** A value for display: whole pixels, else two decimals (trailing zeros dropped). */
export const display = (v: number, unit: LengthUnit) => (unit === "pixels" ? Math.round(v) : Math.round(v * 100) / 100);
