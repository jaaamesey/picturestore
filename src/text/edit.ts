import { apply, invert, vec, type Vec2 } from "../core/geometry";
import type { LayoutLine, TextLayout } from "./layout";
import { paragraphRanges, type TextContent } from "./model";
import { warpMap } from "./warp";

/**
 * Editing type on the canvas: where the caret is, what a click hits,
 * how the caret moves, and what a selection covers — in text space, from
 * a layout. Positions are caret stops: 0..text.length.
 */

/** The line a caret stop is on (at a line break, the line it ends). */
export function lineOf(layout: TextLayout, index: number, preferNext = false): number {
  const lines = layout.lines;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (index < l.start) return Math.max(0, i - 1);
    if (index <= l.end) return preferNext && index === l.end && i + 1 < lines.length && lines[i + 1].start === index ? i + 1 : i;
  }
  return Math.max(0, lines.length - 1);
}

const inlineAt = (l: LayoutLine, index: number) => l.carets[Math.max(0, Math.min(l.carets.length - 1, index - l.start))];

/** The caret's ends (top, bottom) in text space, through the frame. */
export function caretGeometry(layout: TextLayout, index: number, preferNext = false): { top: Vec2; bottom: Vec2 } | null {
  const l = layout.lines[lineOf(layout, index, preferNext)];
  if (!l) return null;
  const s = inlineAt(l, index);
  return { top: layout.place(s, l.block - l.ascent), bottom: layout.place(s, l.block + l.descent) };
}

/** The caret stop nearest a text-space point. */
export function indexAt(layout: TextLayout, p: Vec2): number {
  const lines = layout.lines.filter((l) => l.visible);
  if (!lines.length) return 0;
  // Nearest line across, then nearest stop along it (in the frame's own coordinates).
  let best = lines[0], bestD = Infinity;
  for (const l of lines) {
    const mid = layout.place((l.carets[0] + l.carets[l.carets.length - 1]) / 2, l.block);
    const a = layout.place(l.carets[0], l.block), b = layout.place(l.carets[l.carets.length - 1], l.block);
    const d = layout.vertical || isPath(layout) ? Math.min(distToSegment(p, a, b), Math.hypot(p.x - mid.x, p.y - mid.y)) : lineDistance(p.y, l);
    if (d < bestD) ((bestD = d), (best = l));
  }
  let index = best.start, nearest = Infinity;
  for (let k = 0; k < best.carets.length; k++) {
    const q = layout.place(best.carets[k], best.block);
    const d = layout.vertical ? Math.abs(p.y - q.y) : isPath(layout) ? Math.hypot(p.x - q.x, p.y - q.y) : Math.abs(p.x - q.x);
    if (d < nearest) ((nearest = d), (index = best.start + k));
  }
  return index;
}

const isPath = (layout: TextLayout) => layout.onPath;

function lineDistance(y: number, l: LayoutLine): number {
  const top = l.block - l.ascent, bottom = l.block + l.descent;
  return y < top ? top - y : y > bottom ? y - bottom : 0;
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

/** Document space → text space: the transform undone, then the warp (numerically). */
export function toTextSpace(c: TextContent, layout: TextLayout, p: Vec2): Vec2 {
  const q = apply(invert(c.transform), p);
  if (!c.warp) return q;
  const w = warpMap(c.warp, layout.bounds);
  // Newton's method on w(x) = q, from q itself.
  let x = q;
  for (let i = 0; i < 12; i++) {
    const f = w(x), h = 0.5;
    const fx = w(vec(x.x + h, x.y)), fy = w(vec(x.x, x.y + h));
    const a = (fx.x - f.x) / h, b = (fx.y - f.y) / h, cc = (fy.x - f.x) / h, d = (fy.y - f.y) / h;
    const det = a * d - b * cc;
    if (Math.abs(det) < 1e-12) break;
    const ex = q.x - f.x, ey = q.y - f.y;
    x = vec(x.x + (d * ex - cc * ey) / det, x.y + (-b * ex + a * ey) / det);
    if (Math.abs(ex) + Math.abs(ey) < 1e-4) break;
  }
  return x;
}

// --- Words, lines, paragraphs ------------------------------------------------------

const wordSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;
const graphemes = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;

/** The word (or run of spaces or punctuation) around a caret stop: what a double-click selects. */
export function wordAt(text: string, index: number): { start: number; end: number } {
  if (!wordSegmenter) {
    let a = index, b = index;
    while (a > 0 && /\w/.test(text[a - 1])) a--;
    while (b < text.length && /\w/.test(text[b])) b++;
    return { start: a, end: b };
  }
  for (const s of wordSegmenter.segment(text)) {
    const end = s.index + s.segment.length;
    if (index >= s.index && index < end) return { start: s.index, end };
  }
  return { start: index, end: index };
}

/** The next caret stop after `index` by whole characters (grapheme clusters, so emoji and accents stay whole). */
export function nextStop(text: string, index: number): number {
  if (index >= text.length) return text.length;
  if (!graphemes) return index + 1;
  for (const s of graphemes.segment(text.slice(index, index + 16))) return index + s.segment.length;
  return index + 1;
}

export function previousStop(text: string, index: number): number {
  if (index <= 0) return 0;
  if (!graphemes) return index - 1;
  let last = 0;
  const from = Math.max(0, index - 16);
  for (const s of graphemes.segment(text.slice(from, index))) last = s.index;
  return from + last;
}

/** Ctrl+→: the end of the next word. */
export function nextWord(text: string, index: number): number {
  let i = index;
  while (i < text.length && !/[\p{L}\p{N}]/u.test(text[i])) i++;
  while (i < text.length && /[\p{L}\p{N}_'’]/u.test(text[i])) i++;
  return i;
}

/** Ctrl+←: the start of the previous word. */
export function previousWord(text: string, index: number): number {
  let i = index;
  while (i > 0 && !/[\p{L}\p{N}]/u.test(text[i - 1])) i--;
  while (i > 0 && /[\p{L}\p{N}_'’]/u.test(text[i - 1])) i--;
  return i;
}

export function paragraphOf(text: string, index: number): { start: number; end: number } {
  return paragraphRanges(text).find((p) => index >= p.start && index <= p.end) ?? { start: 0, end: text.length };
}

/** The line around a caret stop: what a triple-click selects. */
export function lineRange(layout: TextLayout, index: number): { start: number; end: number } {
  const l = layout.lines[lineOf(layout, index)];
  return l ? { start: l.start, end: l.end } : { start: 0, end: 0 };
}

export type Motion = "left" | "right" | "up" | "down" | "word-left" | "word-right" | "line-start" | "line-end" | "start" | "end" | "paragraph-up" | "paragraph-down";

/**
 * Where a caret moves. Up and down keep to the column where the caret
 * started (`goal`, inline); vertical type turns the arrows a quarter, as
 * its lines are columns.
 */
export function moveCaret(layout: TextLayout, text: string, index: number, motion: Motion, goal: number | null): { index: number; goal: number | null } {
  let m = motion;
  if (layout.vertical) m = ({ up: "left", down: "right", left: "down", right: "up" } as Record<string, Motion>)[m] ?? m;
  switch (m) {
    case "left":
      return { index: previousStop(text, index), goal: null };
    case "right":
      return { index: nextStop(text, index), goal: null };
    case "word-left":
      return { index: previousWord(text, index), goal: null };
    case "word-right":
      return { index: nextWord(text, index), goal: null };
    case "line-start":
      return { index: lineRange(layout, index).start, goal: null };
    case "line-end": {
      const r = lineRange(layout, index);
      // Before the line's trailing space, so the caret stays on it.
      let e = r.end;
      if (e < text.length && text[e] !== "\n" && e > r.start && text[e - 1] === " ") e--;
      return { index: e, goal: null };
    }
    case "start":
      return { index: 0, goal: null };
    case "end":
      return { index: text.length, goal: null };
    case "paragraph-up": {
      const p = paragraphOf(text, index);
      return { index: index > p.start ? p.start : paragraphOf(text, Math.max(0, p.start - 1)).start, goal: null };
    }
    case "paragraph-down": {
      const p = paragraphOf(text, index);
      return { index: index < p.end ? p.end : paragraphOf(text, Math.min(text.length, p.end + 1)).end, goal: null };
    }
    case "up":
    case "down": {
      const li = lineOf(layout, index);
      const line = layout.lines[li];
      if (!line) return { index, goal };
      const g = goal ?? inlineAt(line, index);
      const target = layout.lines[li + (m === "down" ? 1 : -1)];
      if (!target) return { index: m === "down" ? text.length : 0, goal: g };
      let best = target.start, d = Infinity;
      for (let k = 0; k < target.carets.length; k++) {
        const dd = Math.abs(target.carets[k] - g);
        if (dd < d) ((d = dd), (best = target.start + k));
      }
      return { index: best, goal: g };
    }
  }
}

/** A selection's highlight: one quadrilateral per line it covers, in text space. */
export function selectionPolygons(layout: TextLayout, start: number, end: number): Vec2[][] {
  if (start === end) return [];
  const out: Vec2[][] = [];
  for (const l of layout.lines) {
    if (!l.visible || l.end < start || l.start > end) continue;
    const a = Math.max(start, l.start), b = Math.min(end, l.end);
    // A selected line break shows as a sliver past the line's end.
    const breakSelected = end > l.end && start <= l.end;
    if (b <= a && !breakSelected) continue;
    const s0 = inlineAt(l, a), s1 = b > a ? inlineAt(l, b) : s0;
    const lo = Math.min(s0, s1), hi = Math.max(s0, s1) + (breakSelected ? l.ascent * 0.3 : 0);
    const t0 = l.block - l.ascent, t1 = l.block + l.descent;
    // Path type: follow the path in steps.
    const steps = isPath(layout) ? Math.max(1, Math.ceil((hi - lo) / 4)) : 1;
    const top: Vec2[] = [], bottom: Vec2[] = [];
    for (let k = 0; k <= steps; k++) {
      const s = lo + ((hi - lo) * k) / steps;
      top.push(layout.place(s, t0));
      bottom.push(layout.place(s, t1));
    }
    out.push([...top, ...bottom.reverse()]);
  }
  return out;
}

/** A type layer's automatic name: its text's first line, cut short (as Photoshop names them). */
export function textLayerName(text: string): string {
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  const t = first.trim();
  return t.length > 30 ? `${t.slice(0, 30)}…` : t || "Layer";
}
