import bidiFactory from "bidi-js";
import type { RGB } from "../core/color";
import { EMPTY_RECT, rect, union, vec, type Rect, type Vec2 } from "../core/geometry";
import { breakOpportunities, hyphenationPoints } from "./breaks";
import { compose, FORCED, type Item } from "./compose";
import type { FontLibrary, LoadedFace } from "./fonts";
import { DEFAULT_ENGINE, DEFAULT_FONT, paragraphRanges, type CharStyle, type ParagraphStyle, type TextContent } from "./model";
import { areaPolygons, measurePath, pointAlong, polygonsTop, spanBetween } from "./paths";

/**
 * Lays type out: Photoshop's text engine, in text space. Per paragraph:
 *
 * 1. Characters are styled from their runs; caps and faux small caps,
 *    superscript and subscript change what's drawn and its size.
 * 2. The text is split into items (same font, features, direction) and
 *    shaped by HarfBuzz; characters a font lacks come from another font
 *    that has them (Missing Glyph Protection).
 * 3. Kerning (the font's metrics, optical from the outlines, or manual),
 *    tracking, scaling and the paragraph's desired spacing give each
 *    character its advance.
 * 4. Frames that wrap compose lines (see compose.ts) at Unicode break
 *    opportunities and hyphenation points; lines are aligned or justified
 *    (word spacing, then letter spacing, then glyph scaling).
 * 5. Lines stack by leading (the largest on each line) and paragraph
 *    spacing, along the block axis: down for horizontal type, leftwards for
 *    vertical columns; along a path for path type.
 *
 * Positions are "inline" (along a line) and "block" (across lines) and
 * mapped into text space by the frame, so vertical and path type reuse
 * everything.
 */

export interface LayoutGlyph {
  readonly face: LoadedFace;
  readonly gid: number;
  readonly variations: Readonly<Record<string, number>> | undefined;
  /** The glyph's origin (on its baseline) in text space. */
  readonly x: number;
  readonly y: number;
  /** Ems to pixels, across and up (y up in the glyph, down in text space). */
  readonly sx: number;
  readonly sy: number;
  /** Turned clockwise about its origin (vertical Roman, path type). */
  readonly rotate: number;
  /** Faux italic: the slant (tan of the angle). */
  readonly skew: number;
  /** Faux bold: an outline this wide, in pixels. */
  readonly bold: number;
  readonly color: RGB;
  /** The character it draws (the first of a ligature's). */
  readonly char: number;
}

export interface LayoutLine {
  /** Characters [start, end), excluding the paragraph's "\n". */
  readonly start: number;
  readonly end: number;
  readonly paragraph: number;
  /** Baseline position along the block axis. */
  readonly block: number;
  readonly ascent: number;
  readonly descent: number;
  /** Inline position of each caret stop, start..end (length end - start + 1). */
  readonly carets: Float64Array;
  /** Box and area type hide lines that don't fit (the frame overflows). */
  readonly visible: boolean;
  readonly hyphenated: boolean;
}

export interface Decoration {
  /** A filled polygon in text space (underline, strikethrough). */
  readonly polygon: readonly Vec2[];
  readonly color: RGB;
}

export interface TextLayout {
  readonly glyphs: readonly LayoutGlyph[];
  readonly lines: readonly LayoutLine[];
  readonly decorations: readonly Decoration[];
  /** The text's frame in text space: the box, or the lines' extent for point and path type. */
  readonly bounds: Rect;
  /** Text didn't fit the frame. */
  readonly overflow: boolean;
  /** PostScript names of fonts that weren't available (drawn in the default font). */
  readonly missing: ReadonlySet<string>;
  readonly vertical: boolean;
  /** Inline/block → text space, and the inline direction there (radians). */
  readonly place: (inline: number, block: number) => Vec2;
  readonly angle: (inline: number) => number;
}

const bidi = bidiFactory();

const isSpace = (c: number) => c === 0x20 || c === 0x3000 || c === 0x09;
const isSpaceLike = (c: number) => isSpace(c) || c === 0xa0;
/** Characters that stand upright in vertical type (CJK and fullwidth). */
const isUpright = (c: number) =>
  (c >= 0x1100 && c <= 0x11ff) ||
  (c >= 0x2e80 && c <= 0xa4cf) ||
  (c >= 0xac00 && c <= 0xd7af) ||
  (c >= 0xf900 && c <= 0xfaff) ||
  (c >= 0xfe30 && c <= 0xfe4f) ||
  (c >= 0xff00 && c <= 0xff60) ||
  (c >= 0xffe0 && c <= 0xffe6) ||
  c >= 0x20000;
/** Hanging punctuation (Roman Hanging Punctuation): at a line's start, and at its end. */
const HANG_START = new Set([..."\"'“‘«‹([{-–—"].map((c) => c.charCodeAt(0)));
const HANG_END = new Set([..."\"'”’»›.,:;-–—!?)]}"].map((c) => c.charCodeAt(0)));

/** OpenType features for a style (kerning is set per character range). */
function featuresOf(s: CharStyle, face: LoadedFace, smallCaps: boolean): string[] {
  const f: string[] = [];
  if (!s.ligatures) f.push("liga=0", "clig=0");
  if (!s.contextualAlternates) f.push("calt=0");
  if (s.discretionaryLigatures) f.push("dlig");
  if (s.swash) f.push("swsh");
  if (s.stylisticAlternates) f.push("salt");
  if (s.titlingAlternates) f.push("titl");
  if (s.ordinals) f.push("ordn");
  if (s.fractions) f.push("frac");
  if (s.oldStyle) f.push("onum");
  if (s.ornaments) f.push("ornm");
  if (smallCaps && face.features.has("smcp")) f.push("smcp");
  return f;
}

/** A character as it's drawn: what's shaped in its place, its size factor and baseline offset. */
interface Styled {
  readonly style: CharStyle;
  readonly face: LoadedFace;
  /** Size multiplier: superscript, subscript, faux small caps. */
  readonly scale: number;
  /** Baseline offset in pixels, up: baseline shift plus superscript or subscript. */
  readonly rise: number;
  readonly smallCaps: boolean;
}

interface Glyph {
  readonly face: LoadedFace;
  readonly gid: number;
  readonly variations: Readonly<Record<string, number>> | undefined;
  /** Inline advance in pixels (spacing, kerning and tracking included). */
  advance: number;
  /** Offset from the pen, inline and across (up), in pixels. */
  readonly dx: number;
  readonly dy: number;
  readonly sx: number;
  readonly sy: number;
  readonly char: number;
  /** Characters it covers [char, char + count). */
  readonly count: number;
  readonly upright: boolean;
  readonly rtl: boolean;
}

/** One paragraph shaped: glyphs in logical order and every character's advance. */
interface ShapedParagraph {
  readonly start: number;
  readonly end: number;
  readonly glyphs: Glyph[];
  /** Per character (index - start): its share of the advance, and its style. */
  readonly advance: Float64Array;
  readonly styled: Styled[];
  readonly levels: Uint8Array;
}

/** Optical kerning: the gap between two glyphs judged by their shapes, in ems. */
const profiles = new WeakMap<LoadedFace, Map<string, { left: Float64Array; right: Float64Array }>>();
const BANDS = 12;

function profile(face: LoadedFace, gid: number, variations?: Readonly<Record<string, number>>) {
  let byFace = profiles.get(face);
  if (!byFace) profiles.set(face, (byFace = new Map()));
  const key = `${gid}|${JSON.stringify(variations ?? {})}`;
  let p = byFace.get(key);
  if (!p) {
    const m = face.metrics(variations);
    const left = new Float64Array(BANDS).fill(Infinity), right = new Float64Array(BANDS).fill(-Infinity);
    for (const contour of face.outline(gid, variations))
      for (const k of contour)
        for (const q of [k.anchor, k.in, k.out]) {
          const b = Math.floor(((q.y - m.descender) / (m.ascender - m.descender)) * BANDS);
          if (b < 0 || b >= BANDS) continue;
          left[b] = Math.min(left[b], q.x);
          right[b] = Math.max(right[b], q.x);
        }
    byFace.set(key, (p = { left, right }));
  }
  return p;
}

function opticalGap(face: LoadedFace, a: number, advA: number, b: number, v?: Readonly<Record<string, number>>): number | null {
  const pa = profile(face, a, v), pb = profile(face, b, v);
  let sum = 0, n = 0;
  for (let i = 0; i < BANDS; i++) {
    if (!Number.isFinite(pa.right[i]) && !Number.isFinite(pb.left[i])) continue;
    const ra = Number.isFinite(pa.right[i]) ? pa.right[i] : Math.max(...pa.right.filter(Number.isFinite), 0) - 0.15;
    const lb = Number.isFinite(pb.left[i]) ? pb.left[i] : Math.min(...pb.left.filter(Number.isFinite), advA) + 0.15;
    sum += Math.min(0.3, advA - ra + lb);
    n++;
  }
  return n ? sum / n : null;
}

export interface LayoutOptions {
  readonly fonts: FontLibrary;
  /** Fonts tried for characters the chosen one lacks. */
  readonly fallbacks?: readonly string[];
}

/** Lays out type content. */
export function layoutText(c: TextContent, o: LayoutOptions): TextLayout {
  const engine = c.engine ?? DEFAULT_ENGINE;
  const missing = new Set<string>();
  const fallbackFace = o.fonts.resolve(DEFAULT_FONT);
  if (!fallbackFace) throw new Error("The default font isn't loaded");
  const faceOf = (s: CharStyle): LoadedFace => {
    const f = o.fonts.resolve(s.font);
    if (f) return f;
    missing.add(s.font.postScriptName);
    return fallbackFace;
  };
  const fallbacks = [fallbackFace, ...(o.fallbacks ?? []).map((ps) => o.fonts.resolve({ postScriptName: ps, family: "", style: "" })).filter((f): f is LoadedFace => !!f)];
  const glyphFace = (face: LoadedFace, code: number): LoadedFace => {
    if (code < 0x20 || isSpaceLike(code) || face.hasChar(code)) return face;
    return fallbacks.find((f) => f.hasChar(code)) ?? o.fonts.list().map((i) => o.fonts.face(i)).find((f) => f.hasChar(code)) ?? face;
  };
  const vertical = c.orientation === "vertical";

  // Per-character styles.
  const charStyles: CharStyle[] = new Array(c.text.length);
  {
    let pos = 0;
    for (const r of c.runs) for (let i = 0; i < r.length; i++) charStyles[pos++] = r.style;
  }
  const typing = c.runs[c.runs.length - 1].style;

  function shapeParagraph(start: number, end: number, para: ParagraphStyle): ShapedParagraph {
    const n = end - start;
    const src = c.text.slice(start, end);
    // What's drawn: caps applied, mapped back to source characters.
    let disp = "";
    const map: number[] = [];
    const styled: Styled[] = [];
    for (let i = 0; i < n; ) {
      const code = src.codePointAt(i)!;
      const len = code > 0xffff ? 2 : 1;
      const s = charStyles[start + i];
      const face = glyphFace(faceOf(s), code);
      const ch = src.slice(i, i + len);
      let out = ch, scale = 1, smallCaps = false;
      if (s.caps === "all") out = ch.toLocaleUpperCase(s.language);
      else if (s.caps === "small") {
        const up = ch.toLocaleUpperCase(s.language);
        if (face.features.has("smcp")) smallCaps = true;
        else if (up !== ch) ((out = up), (scale = engine.smallCapSize));
      }
      if (s.position === "superscript") scale *= engine.superscriptSize;
      if (s.position === "subscript") scale *= engine.subscriptSize;
      const rise = s.baselineShift + (s.position === "superscript" ? s.size * engine.superscriptPosition : s.position === "subscript" ? -s.size * engine.subscriptPosition : 0);
      for (let k = 0; k < len; k++) styled.push({ style: s, face, scale, rise, smallCaps });
      for (let k = 0; k < out.length; k++) map.push(i + Math.min(k, len - 1));
      disp += out;
      i += len;
    }
    map.push(n);
    // Bidi levels (all left-to-right is the common case and skips the algorithm).
    let levels: Uint8Array = new Uint8Array(disp.length);
    if (para.direction === "rtl" || /[֐-ࣿיִ-﷿ﹰ-﻿]/.test(disp)) levels = bidi.getEmbeddingLevels(disp, para.direction).levels;
    // Items: runs of the same face, size factor, features and direction.
    const glyphs: Glyph[] = [];
    const advance = new Float64Array(n);
    const keyOf = (i: number) => {
      const st = styled[map[i]];
      const s = st.style;
      return `${st.face.info.ref.postScriptName}|${st.scale}|${st.smallCaps}|${JSON.stringify(s.variations)}|${featuresOf(s, st.face, st.smallCaps).join()}|${s.language}|${levels[i] & 1}|${vertical && isUpright(disp.codePointAt(i)!) && !s.tateChuYoko ? "u" : vertical && s.uprightRoman ? "r" : ""}`;
    };
    for (let a = 0; a < disp.length; ) {
      const key = keyOf(a);
      let b = a + 1;
      while (b < disp.length && keyOf(b) === key) b++;
      const st = styled[map[a]];
      const s = st.style;
      const rtl = (levels[a] & 1) === 1;
      const upright = vertical && !s.tateChuYoko && (isUpright(disp.codePointAt(a)!) || s.uprightRoman);
      // Kerning per character range. A pair's kerning belongs to its second character (Photoshop's
      // manual kerning is set there), but fonts kern a pair on its first glyph.
      const features = featuresOf(s, st.face, st.smallCaps);
      const metricsAt = (i: number) => styled[map[Math.min(i + 1, disp.length - 1)]].style.kerning === "metrics";
      for (let i = a; i < b; ) {
        const metrics = metricsAt(i);
        let j = i + 1;
        while (j < b && metricsAt(j) === metrics) j++;
        if (!metrics) features.push(`kern[${i}:${j}]=0`);
        i = j;
      }
      const variations = opticalSize(st.face, s);
      const shaped = st.face.shape(disp, a, b, { features, direction: upright ? "ttb" : rtl ? "rtl" : "ltr", language: s.language, variations });
      const size = s.size * st.scale;
      for (let g = 0; g < shaped.glyphs.length; g++) {
        const cl = shaped.clusters[g];
        // The characters this glyph's cluster covers (to the next cluster in logical order).
        let next = disp.length;
        for (let h = 0; h < shaped.glyphs.length; h++) if (shaped.clusters[h] > cl && shaped.clusters[h] < next) next = shaped.clusters[h];
        next = Math.min(next, b);
        const charStart = map[cl], charEnd = Math.max(map[next] ?? n, charStart + 1);
        const gs = styled[charStart].style;
        const sx = size * gs.horizontalScale * para.glyphScaling[1], sy = size * gs.verticalScale;
        const inlineAdv = upright ? -shaped.yAdvance[g] * size * gs.verticalScale : shaped.xAdvance[g] * sx;
        glyphs.push({
          face: st.face,
          gid: shaped.glyphs[g],
          variations,
          advance: inlineAdv,
          dx: upright ? shaped.xOffset[g] * sx : shaped.xOffset[g] * sx,
          dy: upright ? shaped.yOffset[g] * sy : shaped.yOffset[g] * sy,
          sx,
          sy,
          char: start + charStart,
          count: charEnd - charStart,
          upright,
          rtl,
        });
      }
      a = b;
    }
    // Glyphs in logical order (RTL items come back reversed).
    glyphs.sort((p, q) => p.char - q.char || 0);
    // Spacing: optical and manual kerning, tracking, desired letter and word spacing, fractional widths.
    for (let g = 0; g < glyphs.length; g++) {
      const gl = glyphs[g];
      const s = charStyles[gl.char];
      const isLastOfCluster = g === glyphs.length - 1 || glyphs[g + 1].char !== gl.char;
      if (!isLastOfCluster) continue;
      const nextGlyph = glyphs[g + 1];
      const code = c.text.charCodeAt(gl.char);
      const space = isSpaceLike(code);
      const size = s.size * styled[gl.char - start].scale;
      if (nextGlyph) {
        const ns = charStyles[nextGlyph.char];
        if (typeof ns.kerning === "number") gl.advance += (ns.kerning / 1000) * ns.size;
        else if (ns.kerning === "optical" && nextGlyph.face === gl.face && !space && !isSpaceLike(c.text.charCodeAt(nextGlyph.char))) {
          const gap = opticalGap(gl.face, gl.gid, gl.advance / gl.sx, nextGlyph.gid, gl.variations);
          const ref = opticalReference(gl.face, gl.variations);
          if (gap !== null && ref !== null) gl.advance += Math.max(-0.2, Math.min(0.2, ref - gap)) * gl.sx;
        }
      }
      gl.advance += (s.tracking / 1000) * size;
      if (space) gl.advance *= para.wordSpacing[1];
      else if (nextGlyph) gl.advance += para.letterSpacing[1] * spaceWidth(gl.face, size, gl.variations);
      if (!s.fractionalWidths) gl.advance = Math.round(gl.advance);
    }
    for (const gl of glyphs) for (let k = 0; k < gl.count; k++) advance[gl.char - start + k] += gl.advance / gl.count;
    return { start, end, glyphs, advance, styled, levels: levels.length === n ? levels : remapLevels(levels, map, n) };
  }

  // --- The frame --------------------------------------------------------------
  const frame = c.frame;
  const path = frame.kind === "path" ? measurePath(frame.knots, frame.closed) : null;
  const area = frame.kind === "area" ? areaPolygons(frame.contours) : null;
  const areaTop = area ? polygonsTop(area) : null;
  const box = frame.kind === "box" ? frame : null;
  /** The inline extent lines may fill (null: unbounded, for point type). */
  const extent = box ? (vertical ? box.height : box.width) : path ? path.length : null;

  const paragraphs = paragraphRanges(c.text);
  const lines: LayoutLine[] = [];
  const glyphsOut: LayoutGlyph[] = [];
  const decorations: Decoration[] = [];
  let block = 0;
  let overflow = false;
  let first = true;
  let bounds = EMPTY_RECT;
  // Area type: each line's span, by its block position.
  const areaSpan = (top: number, bottom: number) => (area ? spanBetween(area, top, bottom) : null);

  paragraphs.forEach((pr, pi) => {
    const para = c.paragraphs[pi]?.style ?? c.paragraphs[c.paragraphs.length - 1].style;
    const shaped = shapeParagraph(pr.start, pr.end, para);
    const n = pr.end - pr.start;
    const baseStyle = n ? charStyles[pr.start] : pr.start > 0 ? charStyles[pr.start - 1] : typing;
    const leadingOf = (s: CharStyle) => s.leading ?? s.size * para.autoLeading;

    // Lines: [start, end) in paragraph-relative characters.
    let breaks: { start: number; end: number; hyphenated: boolean }[];
    if (extent === null && !area) breaks = [{ start: 0, end: n, hyphenated: false }];
    else {
      const widthOf = (line: number) => {
        const indent = para.indentStart + para.indentEnd + (line === 0 ? para.indentFirst : 0);
        if (area && areaTop) {
          const lead = leadingOf(baseStyle);
          const top = (first ? areaTop.top : block) + lead * line;
          const span = areaSpan(top, top + lead);
          return span ? span[1] - span[0] - indent : 0;
        }
        return extent! - indent;
      };
      breaks = composeParagraph(shaped, para, widthOf, c.text);
    }

    if (!first) block += para.spaceBefore;
    breaks.forEach((br, li) => {
      const start = pr.start + br.start, end = pr.start + br.end;
      // Line metrics: the largest leading, ascent and descent among its characters.
      let lead = 0, ascent = 0, descent = 0;
      for (let i = br.start; i < Math.max(br.end, br.start + 1); i++) {
        const st = n ? shaped.styled[Math.min(i, n - 1)] : { style: baseStyle, face: faceOf(baseStyle), scale: 1, rise: 0 };
        const m = st.face.metrics(st.style.variations);
        lead = Math.max(lead, leadingOf(st.style));
        ascent = Math.max(ascent, m.ascender * st.style.size * st.scale + Math.max(0, st.rise));
        descent = Math.max(descent, -m.descender * st.style.size * st.scale - Math.min(0, st.rise));
      }
      if (vertical) ascent = descent = Math.max(ascent, descent);
      // The first line sits by its ascent (the frame's top); others by leading.
      if (first) {
        block = frame.kind === "point" || path ? 0 : area && areaTop ? areaTop.top + ascent : vertical ? lead / 2 : ascent;
        first = false;
      } else block += lead;
      const visible =
        box ? (vertical ? block + descent <= box.width + 0.5 : block <= box.height + 0.5) : area && areaTop ? block + descent <= areaTop.bottom && !!areaSpan(block - ascent, block + descent) : true;
      if (!visible) overflow = true;

      // Inline placement.
      const indent = para.indentStart + (li === 0 ? para.indentFirst : 0);
      let lineStart = indent, lineWidth = extent === null ? 0 : extent - indent - para.indentEnd;
      if (area) {
        const span = areaSpan(block - ascent, block + descent);
        lineStart = (span ? span[0] : 0) + indent;
        lineWidth = span ? span[1] - span[0] - indent - para.indentEnd : 0;
      }
      const placed = placeLine(shaped, br.start, br.end, br.hyphenated, para, lineWidth, extent === null && !area, li === breaks.length - 1, c.text);
      let x0 = lineStart;
      const align = para.align;
      const slack = lineWidth - placed.width;
      if (extent === null && !area) {
        // Point type aligns about its origin.
        x0 = align === "center" || align === "justify-center" ? indent - placed.width / 2 : align === "right" || align === "justify-right" ? -placed.width - para.indentEnd : indent;
      } else if (!placed.justified) {
        if (align === "center" || align === "justify-center") x0 += slack / 2;
        else if (align === "right" || align === "justify-right") x0 += slack;
      }
      if (para.hangingPunctuation) {
        const fc = c.text.charCodeAt(start);
        if (HANG_START.has(fc) && end > start && (align === "left" || align.startsWith("justify"))) x0 -= shaped.advance[br.start];
      }
      if (path && frame.kind === "path") x0 += frame.start;

      const carets = new Float64Array(end - start + 1);
      for (let k = 0; k <= end - start; k++) carets[k] = x0 + placed.carets[k];
      lines.push({ start, end, paragraph: pi, block, ascent, descent, carets, visible, hyphenated: br.hyphenated });
      if (!visible) return;

      for (const pg of placed.glyphs) {
        const s = charStyles[pg.glyph.char] ?? baseStyle;
        const st = shaped.styled[pg.glyph.char - pr.start];
        const inline = x0 + pg.inline;
        const g = pg.glyph;
        const bold = s.fauxBold ? s.size * st.scale * 0.04 : 0;
        const skew = s.fauxItalic ? 0.21 : 0;
        const rise = st.rise;
        let x: number, y: number, rotate = 0;
        if (path) {
          // Each glyph turns with the path at its middle.
          const mid = inline + (g.advance * pg.scale) / 2;
          const at = pointAlong(path, mid);
          rotate = at.angle;
          const back = (g.advance * pg.scale) / 2;
          x = at.p.x - Math.cos(at.angle) * back + Math.sin(at.angle) * rise;
          y = at.p.y - Math.sin(at.angle) * back - Math.cos(at.angle) * rise;
          if (frame.kind === "path" && frame.flipped) rotate += Math.PI;
        } else if (vertical) {
          const column = box ? box.width - block : -block;
          if (g.upright) {
            x = column + g.dx;
            y = inline - g.dy;
          } else {
            // Roman turned clockwise, centred on the column.
            const m = g.face.metrics(g.variations);
            rotate = Math.PI / 2;
            x = column - ((m.ascender + m.descender) / 2) * g.sy - rise;
            y = inline + g.dx;
          }
        } else {
          x = inline + g.dx;
          y = block - g.dy - rise;
        }
        glyphsOut.push({ face: g.face, gid: g.gid, variations: g.variations, x, y, sx: g.sx * pg.scale, sy: g.sy, rotate, skew, bold, color: s.color, char: g.char });
      }
      // Underline and strikethrough, as runs over the line.
      for (const dec of ["underline", "strikethrough"] as const) {
        for (let i = start; i < end; ) {
          const s = charStyles[i];
          if (!s[dec] || isSpaceLike(c.text.charCodeAt(i)) && i === end - 1) {
            i++;
            continue;
          }
          let j = i + 1;
          while (j < end && charStyles[j][dec] && charStyles[j].color === s.color) j++;
          // Not under trailing spaces.
          let k = j;
          while (k > i && isSpaceLike(c.text.charCodeAt(k - 1)) && k === end) k--;
          const st = shaped.styled[i - pr.start];
          const m = st.face.metrics(s.variations);
          const size = s.size * st.scale;
          const thickness = Math.max(size * m.underlineThickness, 0.5);
          const offset = dec === "underline" ? -m.underlinePosition * size + thickness / 2 : -m.strikeoutPosition * size;
          const a = carets[i - start], b = carets[k - start];
          const t0 = block + offset - thickness / 2 - st.rise, t1 = t0 + thickness;
          const quad = [vec(a, t0), vec(b, t0), vec(b, t1), vec(a, t1)];
          if (vertical) {
            const column = box ? box.width - block : -block;
            decorations.push({ polygon: quad.map((q) => vec(column - (q.y - block), q.x)), color: s.color });
          } else decorations.push({ polygon: quad, color: s.color });
          i = j;
        }
      }
      const lineRect = vertical
        ? rect((box ? box.width - block : -block) - descent, Math.min(carets[0], carets[carets.length - 1]), ascent + descent, Math.abs(carets[carets.length - 1] - carets[0]))
        : rect(Math.min(carets[0], carets[carets.length - 1]), block - ascent, Math.abs(carets[carets.length - 1] - carets[0]), ascent + descent);
      bounds = union(bounds, lineRect.w > 0 || lineRect.h > 0 ? { ...lineRect, w: Math.max(lineRect.w, 0.001), h: Math.max(lineRect.h, 0.001) } : lineRect);
    });
    block += para.spaceAfter;
  });
  if (path && frame.kind === "path") {
    const last = lines[lines.length - 1];
    if (last && last.carets[last.carets.length - 1] > path.length + 0.5) overflow = true;
  }

  const frameBounds = box ? rect(0, 0, box.width, box.height) : bounds;
  const place = path
    ? (s: number, t: number) => {
        const at = pointAlong(path, s);
        return vec(at.p.x + Math.sin(at.angle) * t, at.p.y - Math.cos(at.angle) * t);
      }
    : vertical
      ? (s: number, t: number) => vec(box ? box.width - t : -t, s)
      : (s: number, t: number) => vec(s, t);
  const angle = path ? (s: number) => pointAlong(path, s).angle : vertical ? () => Math.PI / 2 : () => 0;
  return { glyphs: glyphsOut, lines, decorations, bounds: frameBounds, overflow, missing, vertical, place, angle };
}

function remapLevels(levels: Uint8Array, map: readonly number[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < map.length - 1; i++) out[map[i]] = levels[i];
  return out;
}

/** Optical size follows the type's size where the font has the axis and it isn't set. */
function opticalSize(face: LoadedFace, s: CharStyle): Readonly<Record<string, number>> | undefined {
  const opsz = face.info.axes.find((a) => a.tag === "opsz");
  if (!opsz || s.variations.opsz !== undefined || face.info.coords.opsz !== undefined) return Object.keys(s.variations).length ? s.variations : undefined;
  return { ...s.variations, opsz: Math.max(opsz.min, Math.min(opsz.max, s.size)) };
}

const spaces = new WeakMap<LoadedFace, number>();
function spaceWidth(face: LoadedFace, size: number, variations?: Readonly<Record<string, number>>): number {
  let w = spaces.get(face);
  if (w === undefined) {
    const gid = face.glyphFor(0x20);
    spaces.set(face, (w = gid === undefined ? 0.25 : face.advance(gid, variations)));
  }
  return w * size;
}

const references = new WeakMap<LoadedFace, number | null>();
function opticalReference(face: LoadedFace, v?: Readonly<Record<string, number>>): number | null {
  if (references.has(face)) return references.get(face)!;
  const n = face.glyphFor(0x6e), o = face.glyphFor(0x6f);
  const ref = n !== undefined && o !== undefined ? opticalGap(face, n, face.advance(n, v), o, v) : null;
  references.set(face, ref);
  return ref;
}

// --- Composition ------------------------------------------------------------------

/** Items for a paragraph: words (and pieces between break opportunities) as boxes, spaces as glue, hyphenation points as penalties. */
function composeParagraph(p: ShapedParagraph, para: ParagraphStyle, width: (line: number) => number, text: string): { start: number; end: number; hyphenated: boolean }[] {
  const n = p.end - p.start;
  if (n === 0) return [{ start: 0, end: 0, hyphenated: false }];
  const src = text.slice(p.start, p.end);
  const opportunities = breakOpportunities(src).filter((b) => b.position < n && !(p.styled[b.position]?.style.noBreak && p.styled[b.position - 1]?.style.noBreak));
  const items: Item[] = [];
  /** The character each item ends at (exclusive). */
  const ends: number[] = [];
  const minWidth = Math.max(1, Math.min(width(0), width(1)));
  const justified = para.align.startsWith("justify");
  const box = (a: number, b: number) => {
    if (b <= a) return;
    let w = 0;
    for (let i = a; i < b; i++) w += p.advance[i];
    const letters = b - a;
    const sp = spaceWidth(p.styled[a].face, p.styled[a].style.size);
    items.push({ kind: "box", width: w, stretch: justified ? (para.letterSpacing[2] - para.letterSpacing[1]) * sp * letters + (para.glyphScaling[2] - para.glyphScaling[1]) * w : 0, shrink: justified ? (para.letterSpacing[1] - para.letterSpacing[0]) * sp * letters + (para.glyphScaling[1] - para.glyphScaling[0]) * w : 0 });
    ends.push(b);
  };
  const word = (a: number, b: number) => {
    // A word wider than any line breaks anywhere, at a high cost (Photoshop's emergency breaks).
    let w = 0;
    for (let i = a; i < b; i++) w += p.advance[i];
    const lang = p.styled[a].style.language;
    const h = para.hyphenation;
    const letters = src.slice(a, b);
    const core = /^[\p{L}\p{M}'’]+/u.exec(letters)?.[0] ?? "";
    let points: number[] = [];
    if (para.hyphenate && core.length >= h.minWord && (h.capitalized || core[0] === core[0].toLocaleLowerCase(lang)) && !p.styled[a].style.noBreak)
      points = hyphenationPoints(core, lang).filter((q) => q >= h.afterFirst && q <= core.length - h.beforeLast);
    let at = a;
    const hyphenWidth = 0.33 * p.styled[a].style.size * p.styled[a].scale;
    for (const q of points) {
      box(at, a + q);
      items.push({ kind: "penalty", width: hyphenWidth, penalty: 50, flagged: true });
      ends.push(a + q);
      at = a + q;
    }
    if (w > minWidth) {
      for (let i = at; i < b; i++) {
        box(i, i + 1);
        if (i + 1 < b) {
          items.push({ kind: "penalty", width: 0, penalty: 5000, flagged: false });
          ends.push(i + 1);
        }
      }
    } else box(at, b);
  };
  let start = 0;
  for (const bk of [...opportunities.map((b) => b.position), n]) {
    if (bk <= start) continue;
    // The piece [start, bk): content, then trailing spaces (glue).
    let contentEnd = bk;
    while (contentEnd > start && isSpaceLike(src.charCodeAt(contentEnd - 1))) contentEnd--;
    word(start, contentEnd);
    if (contentEnd < bk) {
      let w = 0;
      for (let i = contentEnd; i < bk; i++) w += p.advance[i];
      const ws = para.wordSpacing;
      items.push({ kind: "glue", width: w, stretch: justified ? (w * (ws[2] - ws[1])) / ws[1] : 0, shrink: justified ? (w * (ws[1] - ws[0])) / ws[1] : 0 });
      ends.push(bk);
    } else if (bk < n) {
      // A break with no space (after a hyphen, between CJK characters).
      items.push({ kind: "penalty", width: 0, penalty: 0, flagged: false });
      ends.push(bk);
    }
    start = bk;
  }
  items.push({ kind: "penalty", width: 0, penalty: FORCED, flagged: false });
  ends.push(n);
  const size = p.styled[0].style.size;
  const lines = compose(items, para.composer, {
    width,
    justified,
    justifyLast: para.align === "justify-all",
    hyphenLimit: para.hyphenation.limit,
    zone: para.hyphenation.zone,
    rag: size * 3,
  });
  // Items → characters. A line ends after its break's spaces (they stay on it, beyond the edge).
  return lines.map((l, i) => {
    const startChar = l.start > 0 ? ends[l.start - 1] : 0;
    const endChar = i === lines.length - 1 ? n : ends[l.end];
    return { start: i === 0 ? 0 : startChar, end: endChar, hyphenated: l.hyphenated };
  }).map((l, i, all) => (i > 0 ? { ...l, start: all[i - 1].end } : l));
}

interface PlacedGlyph {
  readonly glyph: Glyph;
  readonly inline: number;
  /** Glyph scaling from justification. */
  readonly scale: number;
}

/**
 * Positions a line's glyphs (visual order) from its start, justified if
 * its paragraph is: returns where each glyph goes, the content width
 * (trailing spaces excluded) and caret stops.
 */
function placeLine(p: ShapedParagraph, a: number, b: number, hyphenated: boolean, para: ParagraphStyle, width: number, unbounded: boolean, last: boolean, text: string) {
  const glyphs = p.glyphs.filter((g) => g.char - p.start >= a && g.char - p.start < b);
  // Trailing spaces don't count towards the line's width.
  let content = b;
  while (content > a && isSpaceLike(text.charCodeAt(p.start + content - 1))) content--;
  let natural = 0;
  for (let i = a; i < content; i++) natural += p.advance[i];
  // Hyphen.
  const hyphenAdvance = hyphenated && b > a ? 0.33 * p.styled[b - 1].style.size * p.styled[b - 1].scale : 0;
  natural += hyphenAdvance;
  // Hanging punctuation at the end doesn't count either.
  let hang = 0;
  if (para.hangingPunctuation && content > a && HANG_END.has(text.charCodeAt(p.start + content - 1))) hang = p.advance[content - 1];
  // The last line isn't stretched, but may be compressed to fit (as composition allowed).
  const justify = !unbounded && para.align.startsWith("justify") && (!last || para.align === "justify-all" || natural - hang > width);
  let wordExtra = 0, letterExtra = 0, scale = 1;
  const contentGlyphs = glyphs.filter((g) => g.char - p.start < content);
  const spaceCount = contentGlyphs.filter((g) => isSpaceLike(text.charCodeAt(g.char))).length;
  const letterGaps = Math.max(0, contentGlyphs.length - 1 - spaceCount);
  if (justify) {
    let need = width - (natural - hang);
    const sp = spaceWidth(p.styled[a]?.face ?? p.glyphs[0]?.face, p.styled[a]?.style.size ?? 12);
    const ws = para.wordSpacing, ls = para.letterSpacing, gsc = para.glyphScaling;
    const step = (count: number, room: number) => (count > 0 ? Math.max(-room, Math.min(room, need / count)) : 0);
    if (spaceCount) {
      const unit = sp * ws[1];
      wordExtra = step(spaceCount, (need > 0 ? ws[2] - ws[1] : ws[1] - ws[0]) * (unit / ws[1]));
      need -= wordExtra * spaceCount;
    }
    if (letterGaps) {
      letterExtra = step(letterGaps, (need > 0 ? ls[2] - ls[1] : ls[1] - ls[0]) * sp);
      need -= letterExtra * letterGaps;
    }
    const glyphWidth = natural - spaceCount * sp;
    if (glyphWidth > 0) {
      const room = need > 0 ? gsc[2] - gsc[1] : gsc[1] - gsc[0];
      const k = Math.max(-room, Math.min(room, need / glyphWidth));
      scale = 1 + k / gsc[1];
      need -= k * glyphWidth;
    }
    // Whatever's left goes into the word spaces, past their limit (as Photoshop does), else letters.
    if (Math.abs(need) > 1e-6) {
      if (spaceCount) wordExtra += need / spaceCount;
      else if (letterGaps) letterExtra += need / letterGaps;
    }
  }
  // Visual order: runs of glyphs at the same level reversed for right-to-left.
  const order = visualOrder(glyphs, p);
  const placed: PlacedGlyph[] = [];
  const edges = new Map<number, { x: number; w: number; rtl: boolean; count: number }>();
  let pen = 0;
  for (const g of order) {
    const rel = g.char - p.start;
    const space = isSpaceLike(text.charCodeAt(g.char));
    const inContent = rel < content;
    let adv = space ? g.advance + (inContent ? wordExtra : 0) : g.advance * scale;
    const isLastOfCluster = g === order[order.length - 1] || order[order.indexOf(g) + 1].char !== g.char;
    if (!space && inContent && isLastOfCluster && rel < content - 1) adv += letterExtra;
    placed.push({ glyph: g, inline: pen, scale: space ? 1 : scale });
    const e = edges.get(g.char);
    if (e) e.w += adv;
    else edges.set(g.char, { x: pen, w: adv, rtl: g.rtl, count: g.count });
    pen += adv;
    if (rel === content - 1 && hyphenAdvance && isLastOfCluster) pen += hyphenAdvance;
  }
  // Caret stops: each character's leading edge, and the line's end.
  const carets = new Float64Array(b - a + 1);
  let lastEdge = 0;
  for (let i = a; i < b; ) {
    const e = edges.get(p.start + i);
    if (!e) {
      carets[i - a] = lastEdge;
      i++;
      continue;
    }
    for (let k = 0; k < e.count && i + k < b; k++) carets[i + k - a] = e.rtl ? e.x + e.w - (e.w * k) / e.count : e.x + (e.w * k) / e.count;
    lastEdge = e.rtl ? e.x : e.x + e.w;
    i += Math.max(1, e.count);
  }
  carets[b - a] = b > a ? (p.levels[b - 1] & 1 ? carets[b - 1 - a] - (edges.get(p.start + b - 1)?.w ?? 0) : pen) : 0;
  if (b > a && !(p.levels[b - 1] & 1)) carets[b - a] = Math.max(pen, lastEdge);
  const hyphenGlyph = hyphenated ? hyphenOf(p, b - 1) : null;
  if (hyphenGlyph) {
    let at = 0;
    for (const pg of placed) if (pg.glyph.char - p.start === content - 1) at = pg.inline + pg.glyph.advance * pg.scale;
    placed.push({ glyph: hyphenGlyph, inline: at, scale: 1 });
  }
  const contentWidth = justify ? width : natural - hang;
  return { glyphs: placed, width: contentWidth, carets, justified: justify };
}

/** A hyphen glyph in the style of character `i`. */
function hyphenOf(p: ShapedParagraph, i: number): Glyph | null {
  const st = p.styled[i];
  if (!st) return null;
  const gid = st.face.glyphFor(0x2d);
  if (gid === undefined) return null;
  const size = st.style.size * st.scale;
  const sx = size * st.style.horizontalScale;
  return { face: st.face, gid, variations: undefined, advance: st.face.advance(gid) * sx, dx: 0, dy: 0, sx, sy: size * st.style.verticalScale, char: p.start + i, count: 1, upright: false, rtl: false };
}

function visualOrder(glyphs: readonly Glyph[], p: ShapedParagraph): Glyph[] {
  if (!p.levels.some((l) => l > 0)) return [...glyphs];
  const levelOf = (g: Glyph) => p.levels[g.char - p.start] ?? 0;
  let order = [...glyphs];
  const max = Math.max(...order.map(levelOf));
  const minOdd = Math.min(...order.map(levelOf).filter((l) => l & 1), max) | 1;
  for (let level = max; level >= minOdd; level--) {
    const next: Glyph[] = [];
    for (let i = 0; i < order.length; ) {
      if (levelOf(order[i]) >= level) {
        let j = i;
        while (j < order.length && levelOf(order[j]) >= level) j++;
        next.push(...order.slice(i, j).reverse());
        i = j;
      } else next.push(order[i++]);
    }
    order = next;
  }
  return order;
}
