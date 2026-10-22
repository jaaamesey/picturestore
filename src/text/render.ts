import type { RGB } from "../core/color";
import { EMPTY_RECT, apply, rect, union, vec, type Vec2 } from "../core/geometry";
import { ANTI_ALIAS, STROKE_MODES, flattenContours, strokePolygons, type AntiAliasCode, type VectorDrawing, type VectorPaint } from "../core/shape";
import type { LayoutGlyph, TextLayout } from "./layout";
import type { AntiAlias, TextContent } from "./model";
import { warpMap } from "./warp";

/**
 * Type as vector art: every glyph's outline through its placement, the
 * warp and the layer's transform, flattened in document space (so the
 * flattening tolerance holds however it's scaled), in paints by colour —
 * faux bold as an outline stroke in the same colour, underlines and
 * strikethroughs as fills — with the layer's anti-aliasing.
 */

const AA: Record<AntiAlias, AntiAliasCode> = {
  none: ANTI_ALIAS.none,
  sharp: ANTI_ALIAS.sharp,
  crisp: ANTI_ALIAS.crisp,
  strong: ANTI_ALIAS.strong,
  smooth: ANTI_ALIAS.smooth,
  platform: ANTI_ALIAS.sharp,
  platformLCD: ANTI_ALIAS.sharp,
};

const signedArea = (poly: readonly Vec2[]) => {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
};

/** Text space → document: the warp (over the text's bounds), then the transform. */
export function textMap(c: TextContent, layout: TextLayout): (p: Vec2) => Vec2 {
  const warp = c.warp ? warpMap(c.warp, layout.bounds) : null;
  return warp ? (p) => apply(c.transform, warp(p)) : (p) => apply(c.transform, p);
}

/** A glyph's em space → text space. */
export function glyphMap(g: LayoutGlyph): (p: Vec2) => Vec2 {
  const c = Math.cos(g.rotate), s = Math.sin(g.rotate);
  return (p) => {
    // y up in the glyph, down in text space; the slant leans the top right.
    const lx = p.x * g.sx + g.skew * p.y * g.sy, ly = -p.y * g.sy;
    return vec(g.x + lx * c - ly * s, g.y + lx * s + ly * c);
  };
}

/** Polygons through `map`, densified first so straight edges bend with a warp. */
function mapPolygon(poly: readonly Vec2[], map: (p: Vec2) => Vec2, step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++) out.push(map(vec(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n)));
  }
  return out;
}

const sameColor = (a: RGB, b: RGB) => a.r === b.r && a.g === b.g && a.b === b.b;

/** A type layer's drawing (document space). */
export function textDrawing(c: TextContent, layout: TextLayout): VectorDrawing {
  const map = textMap(c, layout);
  const warped = !!c.warp;
  const t = c.transform;
  const scale = Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2]));
  const aa = AA[c.antiAlias];
  // Paints by colour and faux bold, in the order first used.
  const groups: { color: RGB; bold: number; fill: Vec2[][]; stroke: Vec2[][] }[] = [];
  const group = (color: RGB, bold: number) => {
    let g = groups.find((x) => sameColor(x.color, color) && x.bold === bold);
    if (!g) groups.push((g = { color, bold, fill: [], stroke: [] }));
    return g;
  };
  let bounds = EMPTY_RECT;
  const grow = (polys: readonly (readonly Vec2[])[], pad: number) => {
    for (const p of polys) for (const q of p) bounds = union(bounds, rect(q.x - pad, q.y - pad, pad * 2 + 0.001, pad * 2 + 0.001));
  };
  for (const g of layout.glyphs) {
    const outline = g.face.outline(g.gid, g.variations);
    if (!outline.length) continue;
    const gm = glyphMap(g);
    const polys = flattenContours(outline, (p) => map(gm(p)));
    // One orientation for every glyph (TrueType and CFF wind opposite ways), so overlaps union.
    if (polys.reduce((s, p) => s + signedArea(p), 0) < 0) for (const p of polys) p.reverse();
    const bold = g.bold * scale;
    const target = group(g.color, bold);
    target.fill.push(...polys);
    if (bold > 0) target.stroke.push(...strokePolygons(polys, bold));
    grow(polys, bold);
  }
  for (const d of layout.decorations) {
    const poly = mapPolygon(d.polygon, map, warped ? 2 : Infinity);
    if (signedArea(poly) < 0) poly.reverse();
    group(d.color, 0).fill.push(poly);
    grow([poly], 0);
  }
  const paints: VectorPaint[] = groups.map((g) => ({
    fill: g.fill,
    stroke: g.stroke,
    strokeMode: g.stroke.length ? STROKE_MODES.center : STROKE_MODES.none,
    fillColor: g.color,
    strokeColor: g.stroke.length ? g.color : null,
    aa,
  }));
  return { paints, bounds };
}

/** The text's frame in document space (the transform box: the paragraph box, or the lines' extent). */
export function textFrame(c: TextContent, layout: TextLayout): readonly [Vec2, Vec2, Vec2, Vec2] {
  const b = layout.bounds;
  return [vec(b.x, b.y), vec(b.x + b.w, b.y), vec(b.x + b.w, b.y + b.h), vec(b.x, b.y + b.h)].map((p) => apply(c.transform, p)) as unknown as readonly [Vec2, Vec2, Vec2, Vec2];
}
