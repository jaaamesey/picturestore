/**
 * Line composition, as Photoshop's two composers do it:
 *
 * - Every-line Composer: Knuth and Plass's total-fit algorithm (TeX's),
 *   choosing breaks for the whole paragraph at once to keep spacing even
 *   and hyphens few. For unjustified text it minimizes the rag instead.
 * - Single-line Composer: a line at a time, compressing spacing before
 *   hyphenating, and hyphenating before expanding, with Photoshop's
 *   hyphenation zone for ragged text.
 *
 * Text is a list of boxes (unbreakable content), glue (breakable space,
 * dropped at a break) and penalties (places to break: hyphenation points,
 * the paragraph's end), each with its natural width and how far it may
 * stretch or shrink.
 */

export type Item =
  | { readonly kind: "box"; readonly width: number; readonly stretch: number; readonly shrink: number }
  | { readonly kind: "glue"; readonly width: number; readonly stretch: number; readonly shrink: number }
  | { readonly kind: "penalty"; readonly width: number; readonly penalty: number; readonly flagged: boolean };

export const FORCED = -Infinity;

export interface ComposeOptions {
  /** Width available to line `i` (indents differ for the first). */
  readonly width: (line: number) => number;
  readonly justified: boolean;
  /** Justify the last line too (Justify All). */
  readonly justifyLast: boolean;
  /** Most hyphenated lines in a row (0 = no limit). */
  readonly hyphenLimit: number;
  /** Single-line composer, unjustified text: within this of the edge, break rather than hyphenate. */
  readonly zone: number;
  /** How far ragged lines may fall short before the every-line composer minds (typically a few ems). */
  readonly rag: number;
}

export interface ComposedLine {
  /** Items [start, end): `end` is the break (glue or penalty), or the list's length. */
  readonly start: number;
  readonly end: number;
  /** Ends at a hyphenation point. */
  readonly hyphenated: boolean;
}

interface Sums {
  readonly width: Float64Array;
  readonly stretch: Float64Array;
  readonly shrink: Float64Array;
}

function sums(items: readonly Item[]): Sums {
  const n = items.length;
  const s = { width: new Float64Array(n + 1), stretch: new Float64Array(n + 1), shrink: new Float64Array(n + 1) };
  items.forEach((it, i) => {
    const flex = it.kind !== "penalty";
    s.width[i + 1] = s.width[i] + (it.kind === "penalty" ? 0 : it.width);
    s.stretch[i + 1] = s.stretch[i] + (flex ? it.stretch : 0);
    s.shrink[i + 1] = s.shrink[i] + (flex ? it.shrink : 0);
  });
  return s;
}

/** Where a line starting after break `b` begins: glue and penalties after a break are discarded. */
function lineStart(items: readonly Item[], b: number): number {
  let i = b;
  while (i < items.length && items[i].kind !== "box") i++;
  return i;
}

const isBreak = (items: readonly Item[], i: number) => {
  const it = items[i];
  if (it.kind === "penalty") return it.penalty < Infinity;
  return it.kind === "glue" && i > 0 && items[i - 1].kind === "box";
};

/** The natural width, stretch and shrink of items [a, b) ended by a break at b. */
function measure(items: readonly Item[], s: Sums, a: number, b: number) {
  const end = items[b];
  const extra = end && end.kind === "penalty" ? end.width : 0;
  return { width: s.width[b] - s.width[a] + extra, stretch: s.stretch[b] - s.stretch[a], shrink: s.shrink[b] - s.shrink[a] };
}

function fitness(r: number) {
  return r < -0.5 ? 0 : r <= 0.5 ? 1 : r <= 1 ? 2 : 3;
}

interface Node {
  readonly position: number;
  readonly line: number;
  readonly fitness: number;
  readonly hyphens: number;
  readonly demerits: number;
  readonly previous: Node | null;
}

/** The every-line composer. Lines too loose or too tight past `tolerance` are avoided; null if no breaks fit within it. */
function totalFit(items: readonly Item[], o: ComposeOptions, tolerance: number): ComposedLine[] | null {
  const s = sums(items);
  let active: Node[] = [{ position: 0, line: 0, fitness: 1, hyphens: 0, demerits: 0, previous: null }];
  const last = items.length - 1;
  for (let b = 0; b < items.length; b++) {
    if (!isBreak(items, b)) continue;
    const it = items[b];
    const penalty = it.kind === "penalty" ? it.penalty : 0;
    const flagged = it.kind === "penalty" && it.flagged;
    const best: (Node | null)[] = [null, null, null, null];
    const keep: Node[] = [];
    for (const a of active) {
      const start = lineStart(items, a.position === 0 ? 0 : a.position);
      const m = measure(items, s, start, b);
      const target = o.width(a.line);
      const final = b === last && !o.justifyLast;
      let stretch = m.stretch, shrink = m.shrink;
      if (!o.justified) {
        stretch = o.rag;
        shrink = 0;
      }
      let r: number;
      if (m.width < target) r = final ? 0 : stretch > 0 ? (target - m.width) / stretch : Infinity;
      else if (m.width > target) r = shrink > 0 ? (target - m.width) / shrink : -Infinity;
      else r = 0;
      // Too tight already, lines from `a` only get longer; and forced breaks end every line.
      if (r >= -1 && penalty !== FORCED) keep.push(a);
      const hyphens = flagged ? a.hyphens + 1 : 0;
      // At infinite tolerance (the last resort) overfull lines are allowed, at a cost.
      const feasible = (r >= -1 || tolerance === Infinity) && r <= tolerance && !(o.hyphenLimit > 0 && hyphens > o.hyphenLimit);
      if (!feasible) continue;
      const badness = 100 * Math.abs(Math.max(-1, Math.min(r, 10))) ** 3;
      const linePenalty = (10 + badness) ** 2;
      let d = penalty >= 0 ? linePenalty + penalty ** 2 : penalty > FORCED ? linePenalty - penalty ** 2 : linePenalty;
      const f = fitness(r);
      if (flagged && a.hyphens > 0) d += 3000;
      if (Math.abs(f - a.fitness) > 1) d += 3000;
      // An overfull emergency line costs more than any good one.
      if (r < -1) d += 1e8 * (1 - r);
      const node: Node = { position: b, line: a.line + 1, fitness: f, hyphens, demerits: a.demerits + d, previous: a };
      if (!best[f] || node.demerits < best[f]!.demerits) best[f] = node;
    }
    active = keep;
    for (const n of best) if (n) active.push(n);
    if (!active.length) return null;
  }
  const ends = active.filter((n) => n.position === last);
  if (!ends.length) return null;
  let node: Node | null = ends.reduce((x, y) => (y.demerits < x.demerits ? y : x));
  const breaks: Node[] = [];
  for (; node && node.previous; node = node.previous) breaks.unshift(node);
  return toLines(items, breaks.map((n) => n.position));
}

function toLines(items: readonly Item[], breaks: readonly number[]): ComposedLine[] {
  const out: ComposedLine[] = [];
  let prev = 0;
  for (const b of breaks) {
    const it = items[b];
    out.push({ start: lineStart(items, prev), end: b, hyphenated: it.kind === "penalty" && it.flagged });
    prev = b;
  }
  return out;
}

/** The single-line composer. */
function firstFit(items: readonly Item[], o: ComposeOptions): ComposedLine[] {
  const s = sums(items);
  const breaks: number[] = [];
  let start = 0, line = 0, hyphens = 0;
  const last = items.length - 1;
  while (start <= last) {
    const from = lineStart(items, start === 0 ? 0 : start);
    const target = o.width(line);
    let plain = -1, hyphen = -1;
    for (let b = from; b <= last; b++) {
      if (!isBreak(items, b)) continue;
      const m = measure(items, s, from, b);
      const it = items[b];
      const fits = m.width - (o.justified ? m.shrink : 0) <= target + 1e-9;
      if (!fits && (plain >= 0 || hyphen >= 0)) break;
      if (it.kind === "penalty" && it.flagged) hyphen = b;
      else plain = b;
      if (!fits || (it.kind === "penalty" && it.penalty === FORCED)) break;
    }
    let b = plain;
    if (hyphen > plain && !(o.hyphenLimit > 0 && hyphens >= o.hyphenLimit)) {
      // Ragged text within the zone of the edge breaks before the word rather than hyphenating it.
      const left = plain >= 0 ? target - measure(items, s, from, plain).width : Infinity;
      if (o.justified || left > o.zone) b = hyphen;
    }
    if (b < 0) b = hyphen >= 0 ? hyphen : last;
    const it = items[b];
    hyphens = it.kind === "penalty" && it.flagged ? hyphens + 1 : 0;
    breaks.push(b);
    if (b >= last) break;
    start = b;
    line++;
  }
  return toLines(items, breaks);
}

/** Breaks a paragraph's items into lines. The last item must be a forced penalty. */
export function compose(items: readonly Item[], composer: "single" | "every", o: ComposeOptions): ComposedLine[] {
  if (composer === "single") return firstFit(items, o);
  return totalFit(items, o, 2) ?? totalFit(items, o, 10) ?? totalFit(items, o, Infinity) ?? firstFit(items, o);
}
