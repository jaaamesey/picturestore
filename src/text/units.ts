import type { TypeUnit } from "../editor/preferences";

/**
 * Type sizes as Photoshop shows them: in the Type unit of Preferences ▸
 * Units & Rulers — points (PostScript, 72 to the inch), pixels or
 * millimetres — at the document's resolution. Text space is pixels.
 */

export const TYPE_UNIT_SUFFIX: Record<TypeUnit, string> = { points: "pt", pixels: "px", millimeters: "mm" };

const PER_INCH: Record<string, number> = { pt: 72, pc: 6, in: 1, mm: 25.4, cm: 2.54 };

/** Pixels → the unit. */
export const toTypeUnit = (px: number, unit: TypeUnit, ppi: number) =>
  unit === "pixels" ? px : (px / ppi) * PER_INCH[TYPE_UNIT_SUFFIX[unit]];

/** The unit → pixels. */
export const fromTypeUnit = (v: number, unit: TypeUnit, ppi: number) =>
  unit === "pixels" ? v : (v / PER_INCH[TYPE_UNIT_SUFFIX[unit]]) * ppi;

/** A typed size ("12", "12 pt", "1 in", "5mm", "2 pica"…) in pixels, or null; plain numbers are in `unit`. */
export function parseTypeLength(text: string, unit: TypeUnit, ppi: number, allowNegative = false): number | null {
  const m = /^\s*(-?\d*\.?\d+)\s*(pt|points?|px|pixels?|mm|cm|in|inch(?:es)?|"|pc|picas?)?\s*$/i.exec(text);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || (!allowNegative && v < 0)) return null;
  const u = (m[2] ?? "").toLowerCase();
  if (!u) return fromTypeUnit(v, unit, ppi);
  if (u.startsWith("px") || u.startsWith("pixel")) return v;
  const key = u.startsWith("pt") || u.startsWith("point") ? "pt" : u.startsWith("pc") || u.startsWith("pica") ? "pc" : u === '"' || u.startsWith("in") ? "in" : u;
  return (v / PER_INCH[key]) * ppi;
}

/** A pixel length in the unit, for fields: "12 pt" (two decimals at most). */
export const formatTypeLength = (px: number, unit: TypeUnit, ppi: number) => `${Math.round(toTypeUnit(px, unit, ppi) * 100) / 100} ${TYPE_UNIT_SUFFIX[unit]}`;

/**
 * How much a type layer's transform scales its type vertically and
 * horizontally: Photoshop shows sizes as they're drawn, so scaled type
 * reads at its scaled size (vertical for font size, leading and baseline
 * shift; horizontal for indents).
 */
export const typeScale = (m: readonly number[]) => ({ x: Math.hypot(m[0], m[1]) || 1, y: Math.hypot(m[2], m[3]) || 1 });
