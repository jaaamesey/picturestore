import * as hb from "harfbuzzjs";
import type { Knot } from "../core/shape";
import type { FontRef } from "./model";

/**
 * Fonts, through HarfBuzz — the shaping engine browsers use: OpenType
 * layout (kerning, ligatures, alternates, complex scripts), variable font
 * axes, metrics and glyph outlines. Outlines go through the same exact-area
 * vector rasterizer as shapes, so type stays sharp through any transform
 * and warp.
 *
 * A font file holds faces (one, or several in a collection); a variable
 * face also lists named instances. Each face or instance is a font a type
 * layer can name, by PostScript name as PSD does.
 */

export type FontOrigin = "bundled" | "uploaded" | "local";

/** An axis of a variable font. */
export interface Axis {
  readonly tag: string;
  readonly name: string;
  readonly min: number;
  readonly default: number;
  readonly max: number;
  readonly hidden: boolean;
}

/** A font that type can use: a face, or a named instance of a variable one. */
export interface FontInfo {
  readonly ref: FontRef;
  readonly fileId: string;
  readonly index: number;
  /** Axis values of a named instance (empty for static faces). */
  readonly coords: Readonly<Record<string, number>>;
  readonly axes: readonly Axis[];
  readonly weight: number;
  readonly italic: boolean;
  readonly origin: FontOrigin;
  /** Other PostScript names that mean this font (a static family's names for a variable instance). */
  readonly aliases: readonly string[];
}

export interface FontFile {
  readonly id: string;
  /** sfnt data (WOFF is decompressed on load). */
  readonly bytes: Uint8Array;
  readonly origin: FontOrigin;
  /** Overrides for bundled files whose names were made for variable-font tooling. */
  readonly family?: string;
  readonly psPrefix?: string;
}

const tag = (b: Uint8Array, o = 0) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** The formats `sfntOf` reads. */
export function fontFormat(b: Uint8Array): "ttf" | "otf" | "ttc" | "woff" | "woff2" | null {
  if (b.length < 12) return null;
  const t = tag(b);
  if (t === "\0\x01\0\0" || t === "true") return "ttf";
  if (t === "OTTO") return "otf";
  if (t === "ttcf") return "ttc";
  if (t === "wOFF") return "woff";
  if (t === "wOF2") return "woff2";
  return null;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** WOFF 1.0 → sfnt: its tables, zlib-compressed one by one, rebuilt into a plain font. */
async function unwoff(b: Uint8Array): Promise<Uint8Array> {
  const v = view(b);
  const numTables = v.getUint16(12);
  const tables: { tag: number; data: Uint8Array; checksum: number }[] = [];
  for (let i = 0; i < numTables; i++) {
    const o = 44 + i * 20;
    const offset = v.getUint32(o + 4), compLength = v.getUint32(o + 8), origLength = v.getUint32(o + 12);
    const raw = b.subarray(offset, offset + compLength);
    tables.push({ tag: v.getUint32(o), data: compLength < origLength ? await inflate(raw) : raw, checksum: v.getUint32(o + 16) });
  }
  const headerSize = 12 + numTables * 16;
  let size = headerSize;
  for (const t of tables) size += (t.data.length + 3) & ~3;
  const out = new Uint8Array(size);
  const w = view(out);
  w.setUint32(0, v.getUint32(4));
  w.setUint16(4, numTables);
  const p2 = 2 ** Math.floor(Math.log2(numTables));
  w.setUint16(6, p2 * 16);
  w.setUint16(8, Math.log2(p2));
  w.setUint16(10, numTables * 16 - p2 * 16);
  let at = headerSize;
  tables.forEach((t, i) => {
    w.setUint32(12 + i * 16, t.tag);
    w.setUint32(16 + i * 16, t.checksum);
    w.setUint32(20 + i * 16, at);
    w.setUint32(24 + i * 16, t.data.length);
    out.set(t.data, at);
    at += (t.data.length + 3) & ~3;
  });
  return out;
}

/** The font data HarfBuzz reads, from a TrueType, OpenType, collection or WOFF file. */
export async function sfntOf(bytes: Uint8Array): Promise<Uint8Array> {
  switch (fontFormat(bytes)) {
    case "ttf":
    case "otf":
    case "ttc":
      return bytes;
    case "woff":
      return unwoff(bytes);
    case "woff2":
      throw new Error("WOFF2 fonts aren't supported yet: use the TTF or OTF version.");
    default:
      throw new Error("This isn't a font file Picturestore can read (TrueType, OpenType or WOFF).");
  }
}

const faceCount = (b: Uint8Array) => (fontFormat(b) === "ttc" ? view(b).getUint32(8) : 1);

/** Named instances in a variable face's fvar table. */
function namedInstances(face: hb.Face): { name: string; postScriptName: string | null; coords: Record<string, number> }[] {
  const t = face.referenceTable("fvar");
  if (!t) return [];
  const v = view(t);
  const axesOffset = v.getUint16(4), axisCount = v.getUint16(8), axisSize = v.getUint16(10), count = v.getUint16(12), size = v.getUint16(14);
  const tags = Array.from({ length: axisCount }, (_, i) => tag(t, axesOffset + i * axisSize));
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = axesOffset + axisCount * axisSize + i * size;
    const coords: Record<string, number> = {};
    tags.forEach((tg, a) => (coords[tg] = v.getInt32(o + 4 + a * 4) / 65536));
    const psId = size >= axisCount * 4 + 6 ? v.getUint16(o + 4 + axisCount * 4) : 0xffff;
    out.push({ name: nameOf(face, v.getUint16(o)), postScriptName: psId !== 0xffff ? nameOf(face, psId) || null : null, coords });
  }
  return out;
}

function nameOf(face: hb.Face, id: number): string {
  const names = face.listNames().filter((n) => n.nameId === id);
  const en = names.find((n) => n.language.startsWith("en")) ?? names[0];
  return en ? face.getName(id, en.language) : "";
}

const os2 = (face: hb.Face) => {
  const t = face.referenceTable("OS/2");
  if (!t || t.length < 64) return { weight: 400, italic: false };
  const v = view(t);
  return { weight: v.getUint16(4), italic: (v.getUint16(62) & 1) !== 0 };
};

const compact = (s: string) => s.replace(/[^A-Za-z0-9]/g, "");

/** Adobe's PostScript style names: "Bold Italic" → "BoldIt", "Italic" → "It". */
const adobeStyle = (style: string) => compact(style.replace(/Italic/g, "It")) || "Regular";

/** The fonts in a file: each face, or each named instance of a variable face. */
export function fontsIn(file: FontFile): FontInfo[] {
  const blob = new hb.Blob(file.bytes);
  const out: FontInfo[] = [];
  for (let index = 0; index < faceCount(file.bytes); index++) {
    const face = new hb.Face(blob, index);
    const family = file.family ?? (nameOf(face, 16) || nameOf(face, 1));
    const subfamily = nameOf(face, 17) || nameOf(face, 2) || "Regular";
    const { weight, italic } = os2(face);
    const axes = Object.values(face.getAxisInfos())
      .sort((a, b) => a.axisIndex - b.axisIndex)
      .map((a) => ({ tag: a.tag, name: nameOf(face, a.nameId) || a.tag, min: a.min, default: a.default, max: a.max, hidden: (a.flags & 1) !== 0 }));
    const instances = namedInstances(face);
    const base = { fileId: file.id, index, axes, origin: file.origin };
    if (!instances.length) {
      const ps = nameOf(face, 6) || `${compact(family)}-${compact(subfamily)}`;
      out.push({ ...base, ref: { postScriptName: file.psPrefix ? `${file.psPrefix}-${adobeStyle(subfamily)}` : ps, family, style: subfamily }, coords: {}, weight, italic, aliases: [ps] });
      continue;
    }
    for (const inst of instances) {
      const isItalic = italic || /italic|oblique/i.test(inst.name);
      const style = italic && !/italic/i.test(inst.name) ? (inst.name === "Regular" ? "Italic" : `${inst.name} Italic`) : inst.name;
      const own = inst.postScriptName ?? `${compact(nameOf(face, 25) || family)}-${compact(inst.name)}`;
      const ps = file.psPrefix ? `${file.psPrefix}-${style === "Regular" ? "Regular" : adobeStyle(style)}` : own;
      out.push({ ...base, ref: { postScriptName: ps, family, style }, coords: inst.coords, weight: inst.coords.wght ?? weight, italic: isItalic, aliases: [own] });
    }
  }
  return out;
}

// --- Loaded faces ----------------------------------------------------------------

/** Metrics in em units (fractions of the font size). Y is up. */
export interface FontMetrics {
  readonly ascender: number;
  readonly descender: number;
  readonly lineGap: number;
  readonly capHeight: number;
  readonly xHeight: number;
  readonly underlinePosition: number;
  readonly underlineThickness: number;
  readonly strikeoutPosition: number;
  readonly strikeoutThickness: number;
}

/** Shaped glyphs in em units, clusters as UTF-16 indices into the text shaped. */
export interface Shaped {
  readonly glyphs: Uint32Array;
  readonly clusters: Uint32Array;
  readonly xAdvance: Float64Array;
  readonly yAdvance: Float64Array;
  readonly xOffset: Float64Array;
  readonly yOffset: Float64Array;
}

export interface ShapeOptions {
  /** OpenType features, as `tag` or `tag=value` (e.g. "liga=0", "salt=2"). */
  readonly features: readonly string[];
  readonly direction: "ltr" | "rtl" | "ttb";
  readonly language?: string;
  readonly variations?: Readonly<Record<string, number>>;
}

/** Outlines in em units, y up, as closed cubic contours. */
export type GlyphOutline = readonly (readonly Knot[])[];

/** Shaping precision: positions come back in 1/16 font units. */
const SUBUNITS = 16;

export class LoadedFace {
  readonly face: hb.Face;
  readonly upem: number;
  private readonly fonts = new Map<string, hb.Font>();
  private readonly outlines = new Map<string, GlyphOutline>();
  private readonly metricsCache = new Map<string, FontMetrics>();
  private readonly coverage = new Map<number, boolean>();
  readonly features: ReadonlySet<string>;

  constructor(
    readonly info: FontInfo,
    blob: hb.Blob,
  ) {
    this.face = new hb.Face(blob, info.index);
    this.upem = this.face.upem;
    this.features = new Set([...this.face.getTableFeatureTags("GSUB"), ...this.face.getTableFeatureTags("GPOS")]);
  }

  /** The instance's coordinates with `variations` over them. */
  private coords(variations?: Readonly<Record<string, number>>): Record<string, number> {
    return { ...this.info.coords, ...variations };
  }

  private font(variations?: Readonly<Record<string, number>>): { font: hb.Font; key: string } {
    const coords = this.coords(variations);
    const key = Object.entries(coords)
      .filter(([t]) => this.info.axes.some((a) => a.tag === t))
      .map(([t, v]) => `${t}=${v}`)
      .sort()
      .join(",");
    let font = this.fonts.get(key);
    if (!font) {
      font = new hb.Font(this.face);
      font.setScale(this.upem * SUBUNITS, this.upem * SUBUNITS);
      if (key) font.setVariations(Object.entries(coords).filter(([t]) => this.info.axes.some((a) => a.tag === t)).map(([t, v]) => new hb.Variation(t, v)));
      this.fonts.set(key, font);
    }
    return { font, key };
  }

  metrics(variations?: Readonly<Record<string, number>>): FontMetrics {
    const { font, key } = this.font(variations);
    let m = this.metricsCache.get(key);
    if (!m) {
      const k = 1 / (this.upem * SUBUNITS);
      const e = font.hExtents();
      const at = (t: number) => font.getMetricPositionWithFallback(t) * k;
      m = {
        ascender: e.ascender * k,
        descender: e.descender * k,
        lineGap: e.lineGap * k,
        capHeight: at(hb.MetricsTag.CAP_HEIGHT),
        xHeight: at(hb.MetricsTag.X_HEIGHT),
        underlinePosition: at(hb.MetricsTag.UNDERLINE_OFFSET),
        underlineThickness: at(hb.MetricsTag.UNDERLINE_SIZE) || 0.05,
        strikeoutPosition: at(hb.MetricsTag.STRIKEOUT_OFFSET) || at(hb.MetricsTag.X_HEIGHT) / 2,
        strikeoutThickness: at(hb.MetricsTag.STRIKEOUT_SIZE) || 0.05,
      };
      this.metricsCache.set(key, m);
    }
    return m;
  }

  hasChar(code: number): boolean {
    let has = this.coverage.get(code);
    if (has === undefined) this.coverage.set(code, (has = this.font().font.nominalGlyph(code) !== undefined));
    return has;
  }

  /** Shapes `text[start, end)` (the whole of `text` gives context for joining scripts). */
  shape(text: string, start: number, end: number, o: ShapeOptions): Shaped {
    const { font } = this.font(o.variations);
    const buffer = new hb.Buffer();
    buffer.addText(text, start, end - start);
    buffer.setDirection(o.direction === "rtl" ? hb.Direction.RTL : o.direction === "ttb" ? hb.Direction.TTB : hb.Direction.LTR);
    if (o.language) buffer.setLanguage(o.language);
    buffer.guessSegmentProperties();
    buffer.setClusterLevel(hb.ClusterLevel.MONOTONE_CHARACTERS);
    hb.shape(font, buffer, o.features.map((f) => hb.Feature.fromString(f)).filter((f): f is hb.Feature => !!f));
    const infos = buffer.getGlyphInfos(), pos = buffer.getGlyphPositions();
    const n = infos.length, k = 1 / (this.upem * SUBUNITS);
    const out: Shaped = {
      glyphs: new Uint32Array(n),
      clusters: new Uint32Array(n),
      xAdvance: new Float64Array(n),
      yAdvance: new Float64Array(n),
      xOffset: new Float64Array(n),
      yOffset: new Float64Array(n),
    };
    for (let i = 0; i < n; i++) {
      out.glyphs[i] = infos[i].codepoint;
      out.clusters[i] = infos[i].cluster;
      out.xAdvance[i] = pos[i].xAdvance * k;
      out.yAdvance[i] = pos[i].yAdvance * k;
      out.xOffset[i] = pos[i].xOffset * k;
      out.yOffset[i] = pos[i].yOffset * k;
    }
    return out;
  }

  /** A glyph's outline in em units, y up (cached). */
  outline(gid: number, variations?: Readonly<Record<string, number>>): GlyphOutline {
    const { font, key } = this.font(variations);
    const id = `${key}|${gid}`;
    let o = this.outlines.get(id);
    if (!o) this.outlines.set(id, (o = toKnots(font.glyphToJson(gid), 1 / (this.upem * SUBUNITS))));
    return o;
  }

  /** The horizontal advance of one glyph, in em units. */
  advance(gid: number, variations?: Readonly<Record<string, number>>): number {
    return this.font(variations).font.glyphHAdvance(gid) / (this.upem * SUBUNITS);
  }

  glyphFor(code: number): number | undefined {
    return this.font().font.nominalGlyph(code);
  }

  /** Every character the font maps. */
  characters(): Uint32Array {
    return this.face.collectUnicodes();
  }
}

/** SVG-style path commands (M, L, Q, C, Z) as closed cubic contours. */
export function toKnots(commands: readonly { type: string; values: number[] }[], k: number): Knot[][] {
  const contours: Knot[][] = [];
  let cur: Knot[] = [];
  let last = { x: 0, y: 0 };
  const close = () => {
    if (cur.length) {
      // Drop a closing point that repeats the first.
      const a = cur[0], b = cur[cur.length - 1];
      if (cur.length > 1 && Math.abs(a.anchor.x - b.anchor.x) < 1e-9 && Math.abs(a.anchor.y - b.anchor.y) < 1e-9) {
        cur[0] = { ...a, in: b.in };
        cur.pop();
      }
      if (cur.length >= 2) contours.push(cur);
    }
    cur = [];
  };
  const point = (x: number, y: number) => ({ x: x * k, y: y * k });
  const to = (p: { x: number; y: number }, c1: { x: number; y: number }, c2: { x: number; y: number }) => {
    const prev = cur[cur.length - 1];
    cur[cur.length - 1] = { ...prev, out: c1 };
    cur.push({ anchor: p, in: c2, out: p });
    last = p;
  };
  for (const c of commands) {
    const v = c.values;
    switch (c.type) {
      case "M":
        close();
        last = point(v[0], v[1]);
        cur.push({ anchor: last, in: last, out: last });
        break;
      case "L": {
        const p = point(v[0], v[1]);
        to(p, last, p);
        break;
      }
      case "Q": {
        const q = point(v[0], v[1]), p = point(v[2], v[3]);
        // Degree elevation: the quadratic's control point, two thirds of the way from each end.
        to(p, { x: last.x + (2 / 3) * (q.x - last.x), y: last.y + (2 / 3) * (q.y - last.y) }, { x: p.x + (2 / 3) * (q.x - p.x), y: p.y + (2 / 3) * (q.y - p.y) });
        break;
      }
      case "C":
        to(point(v[4], v[5]), point(v[0], v[1]), point(v[2], v[3]));
        break;
      case "Z":
        close();
        break;
    }
  }
  close();
  return contours;
}

// --- The library ---------------------------------------------------------------

/**
 * The fonts available to type: files are added (bundled ones, uploads,
 * local fonts) and fonts are found by reference, by PostScript name first
 * and then by family and style.
 */
export class FontLibrary {
  private readonly files = new Map<string, { file: FontFile; blob: hb.Blob }>();
  private readonly infos: FontInfo[] = [];
  private readonly loaded = new Map<string, LoadedFace>();
  private listeners: (() => void)[] = [];
  /** Bumped whenever fonts are added or removed. */
  version = 0;

  add(file: FontFile): FontInfo[] {
    this.remove(file.id);
    const fonts = fontsIn(file);
    this.files.set(file.id, { file, blob: new hb.Blob(file.bytes) });
    this.infos.push(...fonts);
    this.changed();
    return fonts;
  }

  remove(fileId: string) {
    if (!this.files.delete(fileId)) return;
    for (let i = this.infos.length - 1; i >= 0; i--) if (this.infos[i].fileId === fileId) this.infos.splice(i, 1);
    for (const k of [...this.loaded.keys()]) if (this.loaded.get(k)!.info.fileId === fileId) this.loaded.delete(k);
    this.changed();
  }

  private changed() {
    this.version++;
    for (const l of this.listeners) l();
  }

  onChange(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => (this.listeners = this.listeners.filter((l) => l !== fn));
  }

  list(): readonly FontInfo[] {
    return this.infos;
  }

  file(id: string): FontFile | undefined {
    return this.files.get(id)?.file;
  }

  /** Families, alphabetically, each with its styles (static faces before instances, by weight). */
  families(): { family: string; fonts: FontInfo[] }[] {
    const by = new Map<string, FontInfo[]>();
    for (const f of this.infos) {
      const list = by.get(f.ref.family) ?? [];
      if (!list.some((g) => g.ref.style === f.ref.style)) list.push(f);
      by.set(f.ref.family, list);
    }
    return [...by]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([family, fonts]) => ({ family, fonts: fonts.sort((a, b) => +a.italic - +b.italic || a.weight - b.weight) }));
  }

  /** The font a reference names, if it's available. */
  find(ref: FontRef): FontInfo | undefined {
    return (
      this.infos.find((f) => f.ref.postScriptName === ref.postScriptName) ??
      this.infos.find((f) => f.aliases.includes(ref.postScriptName)) ??
      this.infos.find((f) => f.ref.family === ref.family && f.ref.style === ref.style)
    );
  }

  face(info: FontInfo): LoadedFace {
    const key = `${info.fileId}|${info.ref.postScriptName}`;
    let face = this.loaded.get(key);
    if (!face) {
      const f = this.files.get(info.fileId);
      if (!f) throw new Error(`Font file ${info.fileId} is gone`);
      this.loaded.set(key, (face = new LoadedFace(info, f.blob)));
    }
    return face;
  }

  /** A reference's face, or null if it's missing. */
  resolve(ref: FontRef): LoadedFace | null {
    const info = this.find(ref);
    return info ? this.face(info) : null;
  }
}
