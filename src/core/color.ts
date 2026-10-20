/** 8-bit sRGB colour. */
export interface RGB {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface HSV {
  /** Degrees, [0, 360). */
  readonly h: number;
  /** [0, 1] */
  readonly s: number;
  /** [0, 1] */
  readonly v: number;
}

export const rgb = (r: number, g: number, b: number): RGB => ({ r, g, b });
export const BLACK = rgb(0, 0, 0);
export const WHITE = rgb(255, 255, 255);

const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");

export const toHex = (c: RGB) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;

export function parseHex(s: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return rgb(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
}

export function rgbToHsv({ r, g, b }: RGB): HSV {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const d = max - Math.min(rr, gg, bb);
  let h = 0;
  if (d > 0) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }: HSV): RGB {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return rgb(f(5), f(3), f(1));
}
