import { apply, multiply, translation, vec, type Vec2 } from "../core/geometry";
import { flattenContours, type Knot } from "../core/shape";
import type { Subpath, VectorPath } from "../core/path";
import { textLayout } from "./engine";
import type { TextLayout } from "./layout";
import { insertContent, replaceText, styleAt, type TextContent } from "./model";
import { glyphMap, textMap } from "./render";

/**
 * Type ▸ Convert Text Shape Type, and Type ▸ Convert to Shape / Create
 * Work Path's outlines.
 */

/** Where the first line starts, in text space. */
function firstCaret(l: TextLayout): Vec2 | null {
  const line = l.lines[0];
  return line ? l.place(line.carets[0], line.block) : null;
}

/** `next` moved so its first line starts where `prev`'s did. */
function keepPlace(prev: TextContent, next: TextContent): TextContent {
  const a = firstCaret(textLayout(prev)), b = firstCaret(textLayout(next));
  return a && b ? { ...next, transform: multiply(prev.transform, translation(a.x - b.x, a.y - b.y)) } : next;
}

/**
 * Point type → paragraph type: a box around the text as it's set, so it
 * reads the same (with room to spare, so no line rewraps).
 */
export function toParagraphText(c: TextContent): TextContent {
  if (c.frame.kind !== "point") return c;
  const b = textLayout(c).bounds;
  const vertical = c.orientation === "vertical";
  const slack = 2;
  const box = { kind: "box", width: Math.ceil(b.w) + (vertical ? 0 : slack), height: Math.ceil(b.h) + (vertical ? slack : 0) } as const;
  return keepPlace(c, { ...c, frame: box, transform: multiply(c.transform, translation(b.x, b.y)) });
}

/**
 * Paragraph type → point type: each line ends with a return where the box
 * wrapped it, and text that overflowed the box is dropped (Photoshop asks
 * first; see `overflowLost`).
 */
export function toPointText(c: TextContent): TextContent {
  if (c.frame.kind !== "box") return c;
  const l = textLayout(c);
  const visible = l.lines.filter((x) => x.visible);
  let out: TextContent = c;
  const last = visible[visible.length - 1];
  if (last && last.end < c.text.length) out = replaceText(out, { start: last.end, end: out.text.length }, "");
  // Soft breaks become returns, from the end so indices hold; the spaces at a break go.
  for (let i = visible.length - 2; i >= 0; i--) {
    const line = visible[i], next = visible[i + 1];
    if (next.paragraph !== line.paragraph) continue;
    const hyphen = line.hyphenated ? "-" : "";
    const text = `${hyphen}\n`;
    let end = line.end;
    while (end > line.start && /\s/.test(out.text[end - 1])) end--;
    out = insertContent(out, { start: end, end: next.start }, { text, runs: [{ ...styleAt(out, end), length: text.length }] });
  }
  return keepPlace(c, { ...out, frame: { kind: "point" } });
}

/** Converting to point type would lose text that overflows the box. */
export function overflowLost(c: TextContent): boolean {
  return c.frame.kind === "box" && textLayout(c).overflow;
}

/**
 * The type's outlines in document space as a path, as Convert to Shape and
 * Create Work Path make them: glyph curves mapped exactly (an affine map
 * keeps Béziers Bézier), warped type flattened finely, underlines and
 * strikethroughs as rectangles. Counters (the hole in an "a") are
 * components that subtract, so the path doesn't depend on winding.
 */
export function textOutlines(c: TextContent): VectorPath {
  const l = textLayout(c);
  const map = textMap(c, l);
  const corner = (p: Vec2): Knot => ({ anchor: p, in: p, out: p });
  const subpaths: Subpath[] = [];
  /** A glyph's contours: its outer ones combine, its counters (wound the other way) subtract just after. */
  const add = (contours: Knot[][]) => {
    const dir = contours.reduce((s, k) => s + signedArea(k.map((q) => q.anchor)), 0) < 0 ? -1 : 1;
    const part = (op: "combine" | "subtract") =>
      contours.flatMap((k) => {
        const outer = signedArea(k.map((q) => q.anchor)) * dir > 0;
        // Each component is wound one way, whatever the font does.
        return outer === (op === "combine") ? [{ knots: signedArea(k.map((q) => q.anchor)) < 0 ? reverse(k) : k, closed: true, op }] : [];
      });
    subpaths.push(...part("combine"), ...part("subtract"));
  };
  for (const g of l.glyphs) {
    const gm = glyphMap(g);
    const outline = g.face.outline(g.gid, g.variations);
    if (c.warp) add(flattenContours(outline, (p) => map(gm(p))).map((poly) => poly.map(corner)));
    else {
      const m = (p: Vec2) => apply(c.transform, gm(p));
      add(outline.map((contour) => contour.map((k) => ({ anchor: m(k.anchor), in: m(k.in), out: m(k.out) }))));
    }
  }
  for (const d of l.decorations) add([d.polygon.map((p) => corner(map(vec(p.x, p.y))))]);
  return { subpaths };
}

const signedArea = (poly: readonly Vec2[]) => poly.reduce((s, a, i) => s + a.x * poly[(i + 1) % poly.length].y - poly[(i + 1) % poly.length].x * a.y, 0) / 2;
const reverse = (k: readonly Knot[]): Knot[] => k.map((q) => ({ anchor: q.anchor, in: q.out, out: q.in })).reverse();

/** Faux bold has no outline of its own: Photoshop won't convert such type to a shape or path. */
export const usesFauxBold = (c: TextContent) => c.runs.some((r) => r.length > 0 && r.style.fauxBold);
