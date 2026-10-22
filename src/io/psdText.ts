import type { LayerTextData, ParagraphStyle as PsdParagraphStyle, TextStyle as PsdTextStyle, Warp as PsdWarp, WarpStyle as PsdWarpStyle } from "ag-psd";
import { boundsOf, multiply, translation, type Mat } from "../core/geometry";
import { areaPolygons, measurePath, pointAlong } from "../text/paths";
import {
  DEFAULT_CHAR_STYLE,
  DEFAULT_ENGINE,
  DEFAULT_PARAGRAPH_STYLE,
  normalizeRuns,
  type AntiAlias,
  type CharStyle,
  type FontRef,
  type ParagraphStyle,
  type TextContent,
  type TextStyles,
  type TextWarp,
  type WarpStyle,
} from "../text/model";

/**
 * Type layers in PSD. Photoshop's own type data (style runs, paragraph
 * runs, warp, frame, transform) is written for Photoshop and read from it.
 * It can't say everything our type does (optical kerning, most OpenType
 * features, variable font axes…), so the exact content also goes into the
 * document's XMP; reading uses it for a layer only while that layer's text
 * and placement are as written — edited elsewhere, Photoshop's data wins.
 */

const WARPS: Record<WarpStyle, PsdWarpStyle> = {
  arc: "arc",
  "arc-lower": "arcLower",
  "arc-upper": "arcUpper",
  arch: "arch",
  bulge: "bulge",
  "shell-lower": "shellLower",
  "shell-upper": "shellUpper",
  flag: "flag",
  wave: "wave",
  fish: "fish",
  rise: "rise",
  fisheye: "fisheye",
  inflate: "inflate",
  squeeze: "squeeze",
  twist: "twist",
};
const FROM_WARP = Object.fromEntries(Object.entries(WARPS).map(([k, v]) => [v, k])) as Partial<Record<PsdWarpStyle, WarpStyle>>;

const CAPS = ["normal", "small", "all"] as const;
const BASELINE = ["normal", "superscript", "subscript"] as const;

function charToPsd(s: CharStyle): PsdTextStyle {
  return {
    font: { name: s.font.postScriptName },
    fontSize: s.size,
    fauxBold: s.fauxBold,
    fauxItalic: s.fauxItalic,
    autoLeading: s.leading === null,
    ...(s.leading !== null && { leading: s.leading }),
    horizontalScale: s.horizontalScale,
    verticalScale: s.verticalScale,
    tracking: s.tracking,
    autoKerning: s.kerning === "metrics",
    kerning: typeof s.kerning === "number" ? s.kerning : 0,
    baselineShift: s.baselineShift,
    fontCaps: CAPS.indexOf(s.caps),
    fontBaseline: BASELINE.indexOf(s.position),
    underline: s.underline,
    strikethrough: s.strikethrough,
    ligatures: s.ligatures,
    dLigatures: s.discretionaryLigatures,
    noBreak: s.noBreak,
    tsume: s.tsume,
    fillColor: { r: s.color.r, g: s.color.g, b: s.color.b },
    hindiNumbers: s.digits === "hindi",
  };
}

/** "MyriadPro-BoldIt" → family "Myriad Pro", style "Bold Italic": a guess, for fonts we can't look up (the editor resolves names it knows). */
export function fontFromName(postScriptName: string): FontRef {
  const [fam, style = "Regular"] = postScriptName.split("-");
  const words = (s: string) => s.replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/\bIt\b/, "Italic");
  return { postScriptName, family: words(fam), style: words(style) };
}

function charFromPsd(s: PsdTextStyle, base: CharStyle): CharStyle {
  const c = s.fillColor as { r?: number; g?: number; b?: number } | undefined;
  return {
    ...base,
    ...(s.font?.name && { font: fontFromName(s.font.name), variations: {} }),
    ...(s.fontSize !== undefined && { size: s.fontSize }),
    ...(s.fauxBold !== undefined && { fauxBold: s.fauxBold }),
    ...(s.fauxItalic !== undefined && { fauxItalic: s.fauxItalic }),
    ...(s.autoLeading !== undefined && { leading: s.autoLeading ? null : (s.leading ?? null) }),
    ...(s.horizontalScale !== undefined && { horizontalScale: s.horizontalScale }),
    ...(s.verticalScale !== undefined && { verticalScale: s.verticalScale }),
    ...(s.tracking !== undefined && { tracking: s.tracking }),
    ...(s.autoKerning !== undefined && { kerning: s.autoKerning ? "metrics" : (s.kerning ?? 0) }),
    ...(s.baselineShift !== undefined && { baselineShift: s.baselineShift }),
    ...(s.fontCaps !== undefined && { caps: CAPS[s.fontCaps] ?? "normal" }),
    ...(s.fontBaseline !== undefined && { position: BASELINE[s.fontBaseline] ?? "normal" }),
    ...(s.underline !== undefined && { underline: s.underline }),
    ...(s.strikethrough !== undefined && { strikethrough: s.strikethrough }),
    ...(s.ligatures !== undefined && { ligatures: s.ligatures }),
    ...(s.dLigatures !== undefined && { discretionaryLigatures: s.dLigatures }),
    ...(s.noBreak !== undefined && { noBreak: s.noBreak }),
    ...(s.tsume !== undefined && { tsume: s.tsume }),
    ...(s.hindiNumbers !== undefined && { digits: s.hindiNumbers ? "hindi" : "default" }),
    ...(c && c.r !== undefined && { color: { r: Math.round(c.r), g: Math.round(c.g ?? 0), b: Math.round(c.b ?? 0) } }),
  };
}

function paragraphToPsd(p: ParagraphStyle): PsdParagraphStyle {
  return {
    justification: p.align,
    firstLineIndent: p.indentFirst,
    startIndent: p.indentStart,
    endIndent: p.indentEnd,
    spaceBefore: p.spaceBefore,
    spaceAfter: p.spaceAfter,
    autoHyphenate: p.hyphenate,
    hyphenatedWordSize: p.hyphenation.minWord,
    preHyphen: p.hyphenation.afterFirst,
    postHyphen: p.hyphenation.beforeLast,
    consecutiveHyphens: p.hyphenation.limit,
    zone: p.hyphenation.zone,
    wordSpacing: [...p.wordSpacing],
    letterSpacing: [...p.letterSpacing],
    glyphSpacing: [...p.glyphScaling],
    autoLeading: p.autoLeading,
    hanging: p.hangingPunctuation,
    everyLineComposer: p.composer === "every",
  };
}

const range3 = (v: number[] | undefined, d: readonly [number, number, number]) => (v?.length === 3 ? ([v[0], v[1], v[2]] as const) : d);

function paragraphFromPsd(s: PsdParagraphStyle, base: ParagraphStyle): ParagraphStyle {
  return {
    ...base,
    ...(s.justification && { align: s.justification }),
    ...(s.firstLineIndent !== undefined && { indentFirst: s.firstLineIndent }),
    ...(s.startIndent !== undefined && { indentStart: s.startIndent }),
    ...(s.endIndent !== undefined && { indentEnd: s.endIndent }),
    ...(s.spaceBefore !== undefined && { spaceBefore: s.spaceBefore }),
    ...(s.spaceAfter !== undefined && { spaceAfter: s.spaceAfter }),
    ...(s.autoHyphenate !== undefined && { hyphenate: s.autoHyphenate }),
    hyphenation: {
      ...base.hyphenation,
      ...(s.hyphenatedWordSize !== undefined && { minWord: s.hyphenatedWordSize }),
      ...(s.preHyphen !== undefined && { afterFirst: s.preHyphen }),
      ...(s.postHyphen !== undefined && { beforeLast: s.postHyphen }),
      ...(s.consecutiveHyphens !== undefined && { limit: s.consecutiveHyphens }),
      ...(s.zone !== undefined && { zone: s.zone }),
    },
    wordSpacing: range3(s.wordSpacing, base.wordSpacing),
    letterSpacing: range3(s.letterSpacing, base.letterSpacing),
    glyphScaling: range3(s.glyphSpacing, base.glyphScaling),
    ...(s.autoLeading !== undefined && { autoLeading: s.autoLeading }),
    ...(s.hanging !== undefined && { hangingPunctuation: s.hanging }),
    ...(s.everyLineComposer !== undefined && { composer: s.everyLineComposer ? "every" : "single" }),
  };
}

function warpToPsd(w: TextWarp | null): PsdWarp {
  if (!w) return { style: "none", value: 0, perspective: 0, perspectiveOther: 0, rotate: "horizontal" };
  return { style: WARPS[w.style], value: w.bend * 100, perspective: w.horizontalDistortion * 100, perspectiveOther: w.verticalDistortion * 100, rotate: w.orientation };
}

function warpFromPsd(w: PsdWarp | undefined): TextWarp | null {
  const style = w?.style && FROM_WARP[w.style];
  if (!w || !style) return null;
  return { style, orientation: w.rotate ?? "horizontal", bend: (w.value ?? 0) / 100, horizontalDistortion: (w.perspective ?? 0) / 100, verticalDistortion: (w.perspectiveOther ?? 0) / 100 };
}

/** Photoshop's type data for a layer. */
export function textToPsd(c: TextContent): LayerTextData {
  const e = c.engine ?? DEFAULT_ENGINE;
  const paragraphs = c.text.split("\n");
  return {
    // (ag-psd writes the returns Photoshop separates paragraphs with.)
    text: c.text,
    transform: [...c.transform],
    antiAlias: c.antiAlias,
    orientation: c.orientation,
    warp: warpToPsd(c.warp),
    useFractionalGlyphWidths: c.runs.every((r) => r.style.fractionalWidths),
    style: charToPsd(c.runs[0].style),
    styleRuns: c.runs.filter((r) => r.length > 0).map((r) => ({ length: r.length, style: charToPsd(r.style) })),
    paragraphStyle: paragraphToPsd(c.paragraphs[0].style),
    paragraphStyleRuns: c.paragraphs.map((p, i) => ({ length: paragraphs[i].length + (i < paragraphs.length - 1 ? 1 : 0), style: paragraphToPsd(p.style) })),
    superscriptSize: e.superscriptSize,
    superscriptPosition: e.superscriptPosition,
    subscriptSize: e.subscriptSize,
    subscriptPosition: e.subscriptPosition,
    smallCapSize: e.smallCapSize,
    ...frameToPsd(c),
  };
}

/**
 * The frame as Photoshop's data can say it: area and path type (which ag-psd
 * can't write) as paragraph type in the shape's bounds and point type at
 * the path's start. Our files keep the real frame (in XMP).
 */
function frameToPsd(c: TextContent): Partial<LayerTextData> {
  const f = c.frame;
  switch (f.kind) {
    case "box":
      return { shapeType: "box", boxBounds: [0, 0, f.width, f.height] };
    case "area": {
      const b = boundsOf(areaPolygons(f.contours).flat());
      return { shapeType: "box", boxBounds: [b.x, b.y, b.x + b.w, b.y + b.h] };
    }
    case "path": {
      const { p } = pointAlong(measurePath(f.knots, f.closed), f.start);
      return { shapeType: "point", pointBase: [0, 0], transform: [...multiply(c.transform, translation(p.x, p.y))] };
    }
    case "point":
      return { shapeType: "point", pointBase: [0, 0] };
  }
}

/** Type from Photoshop's data: drawn from Photoshop's pixels (`stale`) until it's edited. */
export function textFromPsd(t: LayerTextData): TextContent {
  const text = t.text.replace(/\r\n?/g, "\n");
  const baseChar = charFromPsd(t.style ?? {}, DEFAULT_CHAR_STYLE);
  const runs = t.styleRuns?.length
    ? normalizeRuns(t.styleRuns.map((r) => ({ length: r.length, style: charFromPsd(r.style, baseChar), styleId: null })))
    : [{ length: text.length, style: baseChar, styleId: null }];
  // Runs cover the text exactly (Photoshop's count a trailing return).
  let total = runs.reduce((n, r) => n + r.length, 0);
  while (total > text.length && runs.length) {
    const last = runs[runs.length - 1];
    const cut = Math.min(last.length, total - text.length);
    runs[runs.length - 1] = { ...last, length: last.length - cut };
    total -= cut;
    if (runs[runs.length - 1].length === 0 && runs.length > 1) runs.pop();
  }
  if (total < text.length) runs[runs.length - 1] = { ...runs[runs.length - 1], length: runs[runs.length - 1].length + text.length - total };
  const basePara = paragraphFromPsd(t.paragraphStyle ?? {}, DEFAULT_PARAGRAPH_STYLE);
  const count = text.split("\n").length;
  const paraRuns = t.paragraphStyleRuns ?? [];
  const paragraphs = Array.from({ length: count }, (_, i) => ({ style: paragraphFromPsd(paraRuns[Math.min(i, paraRuns.length - 1)]?.style ?? {}, basePara), styleId: null }));
  const m = (t.transform?.length === 6 ? t.transform : [1, 0, 0, 1, 0, 0]) as unknown as Mat;
  const box = t.shapeType === "box" && t.boxBounds?.length === 4 ? t.boxBounds : null;
  return {
    kind: "text",
    text,
    runs: normalizeRuns(runs),
    paragraphs,
    frame: box ? { kind: "box", width: box[2] - box[0], height: box[3] - box[1] } : { kind: "point" },
    orientation: t.orientation ?? "horizontal",
    antiAlias: (t.antiAlias ?? "sharp") as AntiAlias,
    warp: warpFromPsd(t.warp),
    transform: box ? multiply(m, translation(box[0], box[1])) : m,
    engine: {
      superscriptSize: t.superscriptSize ?? DEFAULT_ENGINE.superscriptSize,
      superscriptPosition: t.superscriptPosition ?? DEFAULT_ENGINE.superscriptPosition,
      subscriptSize: t.subscriptSize ?? DEFAULT_ENGINE.subscriptSize,
      subscriptPosition: t.subscriptPosition ?? DEFAULT_ENGINE.subscriptPosition,
      smallCapSize: t.smallCapSize ?? DEFAULT_ENGINE.smallCapSize,
    },
    stale: true,
  };
}

// --- The exact content, in XMP -------------------------------------------------

const NS = "https://picturestore.app/ns/type/1.0/";

/** JSON with no <, > or &: plain XML text. */
const xmlJson = (v: unknown) => JSON.stringify(v).replace(/[<>&]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** Our type layers (in document order) as written, and the document's named type styles, for the XMP packet. */
export function typeXmp(contents: readonly TextContent[], styles: TextStyles | undefined): string {
  const json = xmlJson(contents.map(({ stale: _, ...c }) => c));
  const st = styles && (styles.character.length || styles.paragraph.length) ? `<picturestore:typeStyles>${xmlJson(styles)}</picturestore:typeStyles>` : "";
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:picturestore="${NS}"><picturestore:typeLayers>${json}</picturestore:typeLayers>${st}</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
}

/** The type layers an XMP packet holds (written by `typeXmp`), or none. */
export function typeFromXmp(xmp: string | undefined): TextContent[] {
  const m = xmp && /<picturestore:typeLayers>([\s\S]*?)<\/picturestore:typeLayers>/.exec(xmp);
  if (!m) return [];
  try {
    const out = JSON.parse(m[1]) as TextContent[];
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

/** The named type styles an XMP packet holds, if any. */
export function typeStylesFromXmp(xmp: string | undefined): TextStyles | undefined {
  const m = xmp && /<picturestore:typeStyles>([\s\S]*?)<\/picturestore:typeStyles>/.exec(xmp);
  if (!m) return undefined;
  try {
    const s = JSON.parse(m[1]) as TextStyles;
    return Array.isArray(s.character) && Array.isArray(s.paragraph) ? s : undefined;
  } catch {
    return undefined;
  }
}

/** The exact content for a layer read from Photoshop's data, if what was written still matches it (same text, same placement). */
export function exactContent(read: TextContent, written: TextContent | undefined): TextContent | null {
  if (!written || written.kind !== "text" || written.text !== read.text) return null;
  // Read back as Photoshop's data says it (area and path type approximated), which is what's compared.
  const expected = textFromPsd(textToPsd(written));
  const same = expected.transform.every((v, i) => Math.abs(v - read.transform[i]) < 1e-3);
  return same && expected.frame.kind === read.frame.kind ? { ...written, stale: false } : null;
}
