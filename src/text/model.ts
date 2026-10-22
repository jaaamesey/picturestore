import { BLACK, type RGB } from "../core/color";
import { IDENTITY, type Mat } from "../core/geometry";

/**
 * Type layers, as Photoshop models them: a string of paragraphs with
 * character attributes in runs and one set of paragraph attributes per
 * paragraph, laid out in a frame (a point, a box, a path or a closed
 * shape), optionally warped, then placed by an affine transform from text
 * space into the document. Text space is in document pixels before the
 * transform, so sizes are pixels; the UI shows them in the type units of
 * Preferences (points by default) through the document's resolution.
 *
 * Runs store resolved attributes. Named character and paragraph styles are
 * applied by writing their attributes into runs, remembering which style
 * each run came from: a run's overrides are where it differs from its
 * style (Photoshop's "+"), and redefining a style changes only what wasn't
 * overridden.
 */

/** A font as type layers name it (PostScript name first, as PSD does). */
export interface FontRef {
  readonly postScriptName: string;
  readonly family: string;
  readonly style: string;
}

export type Caps = "normal" | "all" | "small";
export type BaselinePosition = "normal" | "superscript" | "subscript";
/** Metrics (the font's kerning), Optical (from glyph shapes), or a manual value in 1/1000 em before this character. */
export type Kerning = "metrics" | "optical" | number;

export interface CharStyle {
  readonly font: FontRef;
  /** Pixels in text space. */
  readonly size: number;
  /** Baseline-to-baseline distance in pixels, or null for Auto (the paragraph's Auto Leading × size). */
  readonly leading: number | null;
  readonly kerning: Kerning;
  /** 1/1000 em added after each character. */
  readonly tracking: number;
  /** 1 = 100%. */
  readonly verticalScale: number;
  readonly horizontalScale: number;
  /** Pixels, up. */
  readonly baselineShift: number;
  readonly color: RGB;
  readonly fauxBold: boolean;
  readonly fauxItalic: boolean;
  readonly caps: Caps;
  readonly position: BaselinePosition;
  readonly underline: boolean;
  readonly strikethrough: boolean;
  /** OpenType: standard ligatures (liga, clig) and the rest of the Character panel's OpenType buttons. */
  readonly ligatures: boolean;
  readonly contextualAlternates: boolean;
  readonly discretionaryLigatures: boolean;
  readonly swash: boolean;
  readonly stylisticAlternates: boolean;
  readonly titlingAlternates: boolean;
  readonly ordinals: boolean;
  readonly fractions: boolean;
  readonly oldStyle: boolean;
  readonly ornaments: boolean;
  /** BCP 47; drives hyphenation, spelling and language-specific glyphs. */
  readonly language: string;
  /** Kept together on one line. */
  readonly noBreak: boolean;
  /** Off rounds advances to whole pixels (Photoshop's Fractional Widths). */
  readonly fractionalWidths: boolean;
  /** Variable font axes, beyond the named instance in `font` (e.g. { wght: 650 }). */
  readonly variations: Readonly<Record<string, number>>;
  /** Vertical type: Roman characters stand upright instead of turning (Standard Vertical Roman Alignment off). */
  readonly uprightRoman: boolean;
  /** Vertical type: which side of the column the underline is on. */
  readonly underlineSide: "right" | "left";
  /** Middle Eastern: the digits drawn for 0–9. */
  readonly digits: "default" | "arabic" | "hindi" | "farsi";
  /** Vertical type: these characters run horizontally within the column (Tate-Chu-Yoko). */
  readonly tateChuYoko: boolean;
  /** Tightens the space around CJK characters, [0, 1]. */
  readonly tsume: number;
}

export type Alignment = "left" | "center" | "right" | "justify-left" | "justify-center" | "justify-right" | "justify-all";

/** Paragraph ▸ Hyphenation. Lengths in letters, zone in pixels. */
export interface Hyphenation {
  /** Words Longer Than. */
  readonly minWord: number;
  readonly afterFirst: number;
  readonly beforeLast: number;
  /** Hyphen Limit: consecutive hyphenated lines (0 = no limit). */
  readonly limit: number;
  /** Hyphenation Zone (Single-line Composer, unjustified text): within it of the right edge, a line breaks rather than hyphenates. */
  readonly zone: number;
  readonly capitalized: boolean;
}

/** min, desired, max. */
export type Range3 = readonly [number, number, number];

export interface ParagraphStyle {
  readonly align: Alignment;
  /** Pixels. */
  readonly indentStart: number;
  readonly indentEnd: number;
  readonly indentFirst: number;
  readonly spaceBefore: number;
  readonly spaceAfter: number;
  readonly hyphenate: boolean;
  readonly hyphenation: Hyphenation;
  /** Justification: word spacing as fractions of a space, letter spacing as fractions of a space added between letters, glyph scaling. */
  readonly wordSpacing: Range3;
  readonly letterSpacing: Range3;
  readonly glyphScaling: Range3;
  /** Auto Leading, as a fraction of the font size. */
  readonly autoLeading: number;
  readonly composer: "single" | "every";
  readonly hangingPunctuation: boolean;
  /** Middle Eastern: the paragraph's direction. */
  readonly direction: "ltr" | "rtl";
}

export interface CharRun {
  readonly length: number;
  readonly style: CharStyle;
  /** The character style it came from (null: none, Photoshop's "None"). */
  readonly styleId: string | null;
}

export interface Paragraph {
  readonly style: ParagraphStyle;
  readonly styleId: string | null;
}

export type AntiAlias = "none" | "sharp" | "crisp" | "strong" | "smooth" | "platform" | "platformLCD";

export type WarpStyle =
  | "arc"
  | "arc-lower"
  | "arc-upper"
  | "arch"
  | "bulge"
  | "shell-lower"
  | "shell-upper"
  | "flag"
  | "wave"
  | "fish"
  | "rise"
  | "fisheye"
  | "inflate"
  | "squeeze"
  | "twist";

/** Type ▸ Warp Text. Percentages as fractions in [-1, 1]. */
export interface TextWarp {
  readonly style: WarpStyle;
  readonly orientation: "horizontal" | "vertical";
  readonly bend: number;
  readonly horizontalDistortion: number;
  readonly verticalDistortion: number;
}

/** A path's knots in text space, for type on a path and inside a shape. */
export interface PathKnot {
  readonly anchor: { readonly x: number; readonly y: number };
  readonly in: { readonly x: number; readonly y: number };
  readonly out: { readonly x: number; readonly y: number };
}

/**
 * Where the text is laid out, in text space. Point type starts at the
 * origin (its first baseline, at the alignment point); paragraph type
 * fills a box from the origin; path type runs along a path, starting
 * `start` along it; area type fills a closed path.
 */
export type TextFrame =
  | { readonly kind: "point" }
  | { readonly kind: "box"; readonly width: number; readonly height: number }
  | { readonly kind: "path"; readonly knots: readonly PathKnot[]; readonly closed: boolean; readonly start: number; readonly flipped: boolean }
  | { readonly kind: "area"; readonly contours: readonly (readonly PathKnot[])[] };

/** Document-wide text engine settings (Photoshop keeps them per document; PSD per layer). */
export interface TextEngine {
  readonly superscriptSize: number;
  readonly superscriptPosition: number;
  readonly subscriptSize: number;
  readonly subscriptPosition: number;
  readonly smallCapSize: number;
}

export const DEFAULT_ENGINE: TextEngine = { superscriptSize: 0.583, superscriptPosition: 0.333, subscriptSize: 0.583, subscriptPosition: 0.333, smallCapSize: 0.7 };

export interface TextContent {
  readonly kind: "text";
  /** Paragraphs separated by "\n". */
  readonly text: string;
  /** Cover `text` exactly; one empty run holds the typing style of empty text. */
  readonly runs: readonly CharRun[];
  /** One per paragraph. */
  readonly paragraphs: readonly Paragraph[];
  readonly frame: TextFrame;
  readonly orientation: "horizontal" | "vertical";
  readonly antiAlias: AntiAlias;
  readonly warp: TextWarp | null;
  /** Text space → document. Affine: Photoshop allows scale, rotation and skew on live type. */
  readonly transform: Mat;
  readonly engine?: TextEngine;
  /**
   * Drawn by another application (an imported PSD): its pixels are shown
   * until the text is edited or updated, as Photoshop shows a layer whose
   * fonts it lacks.
   */
  readonly stale?: boolean;
}

/** Photoshop's default font, Myriad Pro, isn't free: its open sibling by the same designer. */
export const DEFAULT_FONT: FontRef = { postScriptName: "SourceSans3-Regular", family: "Source Sans 3", style: "Regular" };

export const DEFAULT_CHAR_STYLE: CharStyle = {
  font: DEFAULT_FONT,
  size: 12,
  leading: null,
  kerning: "metrics",
  tracking: 0,
  verticalScale: 1,
  horizontalScale: 1,
  baselineShift: 0,
  color: BLACK,
  fauxBold: false,
  fauxItalic: false,
  caps: "normal",
  position: "normal",
  underline: false,
  strikethrough: false,
  ligatures: true,
  contextualAlternates: true,
  discretionaryLigatures: false,
  swash: false,
  stylisticAlternates: false,
  titlingAlternates: false,
  ordinals: false,
  fractions: false,
  oldStyle: false,
  ornaments: false,
  language: "en-US",
  noBreak: false,
  fractionalWidths: true,
  variations: {},
  uprightRoman: false,
  underlineSide: "right",
  digits: "default",
  tateChuYoko: false,
  tsume: 0,
};

/** Photoshop's defaults (Hyphenation and Justification dialogs). */
export const DEFAULT_PARAGRAPH_STYLE: ParagraphStyle = {
  align: "left",
  indentStart: 0,
  indentEnd: 0,
  indentFirst: 0,
  spaceBefore: 0,
  spaceAfter: 0,
  hyphenate: true,
  hyphenation: { minWord: 5, afterFirst: 2, beforeLast: 2, limit: 2, zone: 36, capitalized: true },
  wordSpacing: [0.8, 1, 1.33],
  letterSpacing: [0, 0, 0],
  glyphScaling: [1, 1, 1],
  autoLeading: 1.2,
  composer: "every",
  hangingPunctuation: false,
  direction: "ltr",
};

export const LOREM_IPSUM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.";

export function textContent(
  text: string,
  style: CharStyle = DEFAULT_CHAR_STYLE,
  paragraph: ParagraphStyle = DEFAULT_PARAGRAPH_STYLE,
  frame: TextFrame = { kind: "point" },
  transform: Mat = IDENTITY,
): TextContent {
  return {
    kind: "text",
    text,
    runs: [{ length: text.length, style, styleId: null }],
    paragraphs: text.split("\n").map(() => ({ style: paragraph, styleId: null })),
    frame,
    orientation: "horizontal",
    antiAlias: "sharp",
    warp: null,
    transform,
  };
}

// --- Queries -------------------------------------------------------------------

/** A half-open character range. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

export const range = (a: number, b: number): TextRange => ({ start: Math.min(a, b), end: Math.max(a, b) });

/** Where each paragraph starts and ends (excluding its "\n"). */
export function paragraphRanges(text: string): TextRange[] {
  const out: TextRange[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf("\n", start);
    if (nl < 0) {
      out.push({ start, end: text.length });
      return out;
    }
    out.push({ start, end: nl });
    start = nl + 1;
  }
}

export function paragraphAt(text: string, index: number): number {
  let n = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < index; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/** The paragraphs a range touches (a caret touches its own). */
export function paragraphsIn(text: string, r: TextRange): TextRange {
  return { start: paragraphAt(text, r.start), end: paragraphAt(text, r.end) + 1 };
}

/**
 * The style typed text takes at `index`: the character before it (or after,
 * at the very start), as in Photoshop.
 */
export function styleAt(c: Pick<TextContent, "runs">, index: number): CharRun {
  let pos = 0;
  for (const r of c.runs) {
    if (index <= pos + r.length && (index > pos || pos === 0) && r.length > 0) return r;
    pos += r.length;
  }
  return c.runs[c.runs.length - 1];
}

/** Every run's style over a range, in order (a caret's: the style typing would use). */
export function stylesIn(c: Pick<TextContent, "runs">, r: TextRange): CharRun[] {
  if (r.start === r.end) return [styleAt(c, r.start)];
  const out: CharRun[] = [];
  let pos = 0;
  for (const run of c.runs) {
    const end = pos + run.length;
    if (end > r.start && pos < r.end) out.push(run);
    pos = end;
  }
  return out;
}

/** A value shared over a range, or undefined where it varies (the panels show it blank). */
export function common<T, K extends keyof T>(items: readonly T[], key: K, same: (a: T[K], b: T[K]) => boolean = sameValue): T[K] | undefined {
  if (!items.length) return undefined;
  const v = items[0][key];
  return items.every((i) => same(i[key], v)) ? v : undefined;
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

// --- Edits ----------------------------------------------------------------------

/** Runs normalized: adjacent equal styles merged, empty runs dropped (but never all of them). */
export function normalizeRuns(runs: readonly CharRun[]): CharRun[] {
  const out: CharRun[] = [];
  for (const r of runs) {
    if (r.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.styleId === r.styleId && sameValue(last.style, r.style)) out[out.length - 1] = { ...last, length: last.length + r.length };
    else out.push(r);
  }
  return out.length ? out : [{ ...runs[runs.length - 1], length: 0 }];
}

/** Splits runs at `index`, so a range can be restyled exactly. */
function splitAt(runs: readonly CharRun[], index: number): CharRun[] {
  const out: CharRun[] = [];
  let pos = 0;
  for (const r of runs) {
    if (index > pos && index < pos + r.length) {
      out.push({ ...r, length: index - pos }, { ...r, length: pos + r.length - index });
    } else out.push(r);
    pos += r.length;
  }
  return out;
}

/** Maps the runs over a range (splitting as needed). */
export function mapRuns(c: TextContent, r: TextRange, f: (run: CharRun) => CharRun): TextContent {
  if (r.start === r.end) return c;
  const runs = splitAt(splitAt(c.runs, r.start), r.end);
  let pos = 0;
  const mapped = runs.map((run) => {
    const at = pos;
    pos += run.length;
    return at >= r.start && at + run.length <= r.end && run.length > 0 ? f(run) : run;
  });
  return { ...c, runs: normalizeRuns(mapped) };
}

/** Sets character attributes over a range. An empty text's typing style changes in place. */
export function setCharStyle(c: TextContent, r: TextRange, patch: Partial<CharStyle>): TextContent {
  if (c.text.length === 0) return { ...c, runs: [{ ...c.runs[0], style: { ...c.runs[0].style, ...patch } }] };
  return mapRuns(c, r, (run) => ({ ...run, style: { ...run.style, ...patch } }));
}

/** Sets paragraph attributes on the paragraphs a range touches. */
export function setParagraphStyle(c: TextContent, r: TextRange, patch: Partial<ParagraphStyle>): TextContent {
  const p = paragraphsIn(c.text, r);
  return { ...c, paragraphs: c.paragraphs.map((para, i) => (i >= p.start && i < p.end ? { ...para, style: { ...para.style, ...patch } } : para)) };
}

/**
 * Replaces a range with `insert` (typing, pasting, deleting): inserted
 * characters take `style` (by default the style at the range's start), and
 * a new paragraph takes the attributes of the one it was split from.
 */
export function replaceText(c: TextContent, r: TextRange, insert: string, style?: CharRun): TextContent {
  const typing = style ?? styleAt(c, r.start);
  const text = c.text.slice(0, r.start) + insert + c.text.slice(r.end);
  // Runs: those before the range, the insertion, those after.
  const before: CharRun[] = [], after: CharRun[] = [];
  let pos = 0;
  for (const run of c.runs) {
    const end = pos + run.length;
    if (pos < r.start) before.push({ ...run, length: Math.min(end, r.start) - pos });
    if (end > r.end) after.push({ ...run, length: end - Math.max(pos, r.end) });
    pos = end;
  }
  const runs = normalizeRuns([...before, { ...typing, length: insert.length }, ...after]);
  // Paragraphs: those the range spans collapse into the first; each new break copies it.
  const span = paragraphsIn(c.text, r);
  const first = c.paragraphs[span.start] ?? c.paragraphs[c.paragraphs.length - 1];
  const breaks = insert.split("\n").length - 1;
  const paragraphs = [...c.paragraphs.slice(0, span.start), ...Array.from({ length: breaks + 1 }, () => first), ...c.paragraphs.slice(span.end)];
  return { ...c, text, runs: text.length ? runs : [{ ...typing, length: 0 }], paragraphs };
}

/** The sub-content of a range, for copying with styles. */
export function sliceContent(c: TextContent, r: TextRange): Pick<TextContent, "text" | "runs" | "paragraphs"> {
  const text = c.text.slice(r.start, r.end);
  const runs: CharRun[] = [];
  let pos = 0;
  for (const run of c.runs) {
    const end = pos + run.length;
    const s = Math.max(pos, r.start), e = Math.min(end, r.end);
    if (e > s) runs.push({ ...run, length: e - s });
    pos = end;
  }
  const p = paragraphsIn(c.text, r);
  return { text, runs: runs.length ? runs : [{ ...styleAt(c, r.start), length: 0 }], paragraphs: c.paragraphs.slice(p.start, p.end) };
}

/** Inserts styled text (as copied) over a range. */
export function insertContent(c: TextContent, r: TextRange, piece: Pick<TextContent, "text" | "runs">): TextContent {
  let out = replaceText(c, r, piece.text);
  let pos = r.start;
  for (const run of piece.runs) {
    out = mapRuns(out, { start: pos, end: pos + run.length }, () => ({ ...run, length: run.length }));
    pos += run.length;
  }
  return out;
}

/**
 * If `next` is `prev` moved by whole pixels (a multiple of `step`), the
 * move; else null (see wholePixelMove in core/content.ts).
 */
export function wholePixelTextMove(prev: TextContent, next: TextContent, step = 1): { x: number; y: number } | null {
  if (prev === next) return { x: 0, y: 0 };
  for (const k of Object.keys(next) as (keyof TextContent)[]) if (k !== "transform" && prev[k] !== next[k]) return null;
  const a = prev.transform, b = next.transform;
  for (let i = 0; i < 4; i++) if (Math.abs(a[i] - b[i]) > 1e-9) return null;
  const dx = b[4] - a[4], dy = b[5] - a[5];
  const rx = Math.round(dx), ry = Math.round(dy);
  if (Math.abs(dx - rx) > 1e-6 || Math.abs(dy - ry) > 1e-6 || rx % step !== 0 || ry % step !== 0) return null;
  return { x: rx, y: ry };
}

/** Text space → document, after Image Size and the like. */
export const withTransform = (c: TextContent, transform: Mat): TextContent => ({ ...c, transform });

// --- Named styles ---------------------------------------------------------------

/** A named character or paragraph style: the attributes it sets (others are left as they are). */
export interface NamedStyle<T> {
  readonly id: string;
  readonly name: string;
  readonly attributes: Partial<T>;
}

/** Paragraph styles carry character attributes too (their Basic Character Formats and the rest). */
export type ParagraphStyleAttributes = Partial<ParagraphStyle> & { readonly character?: Partial<CharStyle> };

export interface TextStyles {
  readonly character: readonly NamedStyle<CharStyle>[];
  readonly paragraph: readonly NamedStyle<ParagraphStyleAttributes>[];
}

export const NO_TEXT_STYLES: TextStyles = { character: [], paragraph: [] };

/** The attributes every item shares (what a new style captures from a selection). */
export function commonAttributes<T extends object>(items: readonly T[]): Partial<T> {
  if (!items.length) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(items[0])) if (items.every((i) => sameValue((i as Record<string, unknown>)[k], v))) out[k] = v;
  return out as Partial<T>;
}

/** The next free "Character Style n" / "Paragraph Style n" name. */
export function nextStyleName(base: string, styles: readonly NamedStyle<unknown>[]): string {
  let n = 1;
  while (styles.some((s) => s.name === `${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Where a run differs from its style: Photoshop's "+" overrides. */
export function charOverrides(run: CharRun, styles: TextStyles): Partial<CharStyle> {
  const def = styles.character.find((s) => s.id === run.styleId);
  if (!def) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(def.attributes)) if (!sameValue(run.style[k as keyof CharStyle], v)) out[k] = run.style[k as keyof CharStyle];
  return out as Partial<CharStyle>;
}

export function paragraphOverrides(p: Paragraph, styles: TextStyles): Partial<ParagraphStyle> {
  const def = styles.paragraph.find((s) => s.id === p.styleId);
  if (!def) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(def.attributes)) {
    if (k === "character") continue;
    if (!sameValue(p.style[k as keyof ParagraphStyle], v)) out[k] = p.style[k as keyof ParagraphStyle];
  }
  return out as Partial<ParagraphStyle>;
}

/** Applies a character style to a range; null (None) keeps the attributes but no longer ties them to a style. */
export function applyCharacterStyle(c: TextContent, r: TextRange, style: NamedStyle<CharStyle> | null): TextContent {
  const apply = (run: CharRun): CharRun => (style ? { ...run, styleId: style.id, style: { ...run.style, ...style.attributes } } : { ...run, styleId: null });
  if (c.text.length === 0) return { ...c, runs: [apply(c.runs[0])] };
  return mapRuns(c, r, apply);
}

/** Applies a paragraph style to the paragraphs a range touches, with its character attributes over their text. */
export function applyParagraphStyle(c: TextContent, r: TextRange, style: NamedStyle<ParagraphStyleAttributes> | null): TextContent {
  const span = paragraphsIn(c.text, r);
  const { character, ...attributes } = style?.attributes ?? {};
  let out: TextContent = {
    ...c,
    paragraphs: c.paragraphs.map((p, i) => (i >= span.start && i < span.end ? { styleId: style?.id ?? null, style: { ...p.style, ...attributes } } : p)),
  };
  if (character) {
    const ranges = paragraphRanges(c.text);
    out = setCharStyle(out, { start: ranges[span.start].start, end: ranges[span.end - 1].end }, character);
  }
  return out;
}

/**
 * The text after a style's definition changed from `before` to `after`:
 * runs (or paragraphs) using it take the new values where they weren't
 * overridden.
 */
export function restyle<T extends object>(current: T, before: Partial<T>, after: Partial<T>): T {
  const out = { ...current } as Record<string, unknown>;
  for (const [k, now] of Object.entries(after)) {
    const was = (before as Record<string, unknown>)[k];
    // Overridden: it differed from what the style used to set.
    if (was !== undefined && !sameValue((current as Record<string, unknown>)[k], was)) continue;
    out[k] = now;
  }
  return out as T;
}

/** Text content after a character style's definition changed. */
export function redefineCharacterStyle(c: TextContent, id: string, before: Partial<CharStyle>, after: Partial<CharStyle>): TextContent {
  if (!c.runs.some((r) => r.styleId === id)) return c;
  return { ...c, runs: normalizeRuns(c.runs.map((r) => (r.styleId === id ? { ...r, style: restyle(r.style, before, after) } : r))) };
}

export function redefineParagraphStyle(c: TextContent, id: string, before: ParagraphStyleAttributes, after: ParagraphStyleAttributes): TextContent {
  if (!c.paragraphs.some((p) => p.styleId === id)) return c;
  const { character: cb = {}, ...pb } = before;
  const { character: ca = {}, ...pa } = after;
  let out: TextContent = { ...c, paragraphs: c.paragraphs.map((p) => (p.styleId === id ? { ...p, style: restyle(p.style, pb, pa) } : p)) };
  const ranges = paragraphRanges(c.text);
  c.paragraphs.forEach((p, i) => {
    if (p.styleId !== id) return;
    out = mapRuns(out, ranges[i], (run) => ({ ...run, style: restyle(run.style, cb, ca) }));
  });
  return out;
}
