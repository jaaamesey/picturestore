import { beforeAll, describe, expect, it } from "vitest";
import { loadHyphenation } from "./breaks";
import { layoutText, type TextLayout } from "./layout";
import { DEFAULT_CHAR_STYLE, DEFAULT_PARAGRAPH_STYLE, LOREM_IPSUM, setCharStyle, setParagraphStyle, textContent, type CharStyle, type ParagraphStyle, type TextFrame } from "./model";
import { testLibrary } from "./testFonts";

const fonts = testLibrary();
const style = (s: Partial<CharStyle> = {}): CharStyle => ({ ...DEFAULT_CHAR_STYLE, size: 20, ...s });
const para = (p: Partial<ParagraphStyle> = {}): ParagraphStyle => ({ ...DEFAULT_PARAGRAPH_STYLE, ...p });
const lay = (text: string, s: Partial<CharStyle> = {}, p: Partial<ParagraphStyle> = {}, frame: TextFrame = { kind: "point" }) =>
  layoutText(textContent(text, style(s), para(p), frame), { fonts });
const width = (l: TextLayout, line = 0) => l.lines[line].carets[l.lines[line].carets.length - 1] - l.lines[line].carets[0];
/** The widest line's content, trailing spaces excluded. */
const lineText = (text: string, l: TextLayout) => l.lines.filter((x) => x.visible).map((x) => text.slice(x.start, x.end).trimEnd());

beforeAll(() => loadHyphenation("en-US"));

describe("point type", () => {
  it("runs on one line from the origin, kerned by the font's metrics", () => {
    const l = lay("AVA");
    expect(l.lines).toHaveLength(1);
    expect(l.lines[0].block).toBe(0);
    expect(l.glyphs[0].x).toBeCloseTo(0, 5);
    expect(width(l)).toBeLessThan(width(lay("AVA", { kerning: 0 })));
  });

  it("tracks by thousandths of an em, and manual kerning adds between two characters", () => {
    const base = width(lay("abcd"));
    expect(width(lay("abcd", { tracking: 100 }))).toBeCloseTo(base + 4 * 0.1 * 20, 5);
    const c = setCharStyle(textContent("abcd", style(), para()), { start: 2, end: 3 }, { kerning: 200 });
    expect(width(layoutText(c, { fonts }))).toBeCloseTo(base + 0.2 * 20, 5);
  });

  it("aligns about its origin", () => {
    const left = lay("Hello"), center = lay("Hello", {}, { align: "center" }), right = lay("Hello", {}, { align: "right" });
    const w = width(left);
    expect(center.lines[0].carets[0]).toBeCloseTo(-w / 2, 5);
    expect(right.lines[0].carets[0]).toBeCloseTo(-w, 5);
  });

  it("stacks paragraphs by leading: Auto is 120% of the size, else the largest on the line", () => {
    const l = lay("one\ntwo\nthree");
    expect(l.lines.map((x) => x.block)).toEqual([0, 24, 48]);
    expect(lay("one\ntwo", { leading: 30 }).lines[1].block).toBe(30);
    const mixed = setCharStyle(textContent("ab\ncd", style(), para()), { start: 4, end: 5 }, { size: 40 });
    expect(layoutText(mixed, { fonts }).lines[1].block).toBe(48);
  });

  it("scales glyphs horizontally and vertically", () => {
    const l = lay("H", { horizontalScale: 2, verticalScale: 0.5 });
    expect(l.glyphs[0].sx).toBeCloseTo(40);
    expect(l.glyphs[0].sy).toBeCloseTo(10);
    expect(width(l)).toBeCloseTo(2 * width(lay("H")), 5);
  });

  it("All Caps draws capitals; Small Caps uses the font's; superscript is smaller and raised", () => {
    const caps = lay("abc", { caps: "all" }), upper = lay("ABC");
    expect(caps.glyphs.map((g) => g.gid)).toEqual(upper.glyphs.map((g) => g.gid));
    const sc = lay("abc", { caps: "small" });
    expect(sc.glyphs.map((g) => g.gid)).not.toEqual(lay("abc").glyphs.map((g) => g.gid));
    const sup = lay("2", { position: "superscript" });
    expect(sup.glyphs[0].sx).toBeCloseTo(20 * 0.583, 3);
    expect(sup.glyphs[0].y).toBeCloseTo(-20 * 0.333, 3);
    expect(lay("x", { baselineShift: 5 }).glyphs[0].y).toBeCloseTo(-5, 5);
  });

  it("standard ligatures can be turned off; OpenType fractions and ordinals change glyphs", () => {
    expect(lay("office").glyphs).toHaveLength(5);
    expect(lay("office", { ligatures: false }).glyphs).toHaveLength(6);
    expect(lay("1/2", { fractions: true }).glyphs.map((g) => g.gid)).not.toEqual(lay("1/2").glyphs.map((g) => g.gid));
  });

  it("faux styles: italic slants, bold outlines", () => {
    expect(lay("a", { fauxItalic: true }).glyphs[0].skew).toBeGreaterThan(0);
    expect(lay("a", { fauxBold: true }).glyphs[0].bold).toBeGreaterThan(0);
  });

  it("caret stops run through every character", () => {
    const l = lay("hello world");
    const c = [...l.lines[0].carets];
    expect(c).toHaveLength(12);
    for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThan(c[i - 1]);
  });

  it("variable font axes change the outlines' advance", () => {
    expect(width(lay("nnnn", { variations: { wght: 900 } }))).toBeGreaterThan(width(lay("nnnn")));
  });
});

describe("paragraph type", () => {
  const box = (w: number, h = 1000): TextFrame => ({ kind: "box", width: w, height: h });

  it("wraps within the box at word boundaries, first baseline at the ascent", () => {
    const l = lay(LOREM_IPSUM, {}, { hyphenate: false }, box(300));
    expect(l.lines.length).toBeGreaterThan(5);
    for (const line of l.lines) expect(width(line === l.lines[0] ? l : l, l.lines.indexOf(line)) - 1e-6).toBeLessThanOrEqual(300 + 30);
    for (const t of lineText(LOREM_IPSUM, l)) expect(t.startsWith(" ")).toBe(false);
    expect(l.lines[0].block).toBeCloseTo(l.lines[0].ascent, 5);
  });

  it("justified lines span the box exactly, except the last; Justify All fills it too", () => {
    const l = lay(LOREM_IPSUM, {}, { align: "justify-left", hyphenate: false }, box(300));
    const content = (i: number) => {
      const line = l.lines[i];
      let end = line.end;
      while (end > line.start && LOREM_IPSUM[end - 1] === " ") end--;
      return line.carets[end - line.start] - line.carets[0];
    };
    for (let i = 0; i < l.lines.length - 1; i++) expect(content(i)).toBeCloseTo(300, 1);
    // The last line may be compressed to fit, never stretched.
    expect(content(l.lines.length - 1)).toBeLessThanOrEqual(300 + 1e-6);
    const end = l.lines[l.lines.length - 1];
    expect(content(l.lines.length - 1)).toBeLessThanOrEqual(width(lay(LOREM_IPSUM.slice(end.start, end.end).trimEnd())) + 1e-6);
    const all = lay("short words here", {}, { align: "justify-all" }, box(400));
    expect(all.lines[0].carets[all.lines[0].carets.length - 1] - all.lines[0].carets[0]).toBeCloseTo(400, 1);
  });

  it("hyphenates by the language's patterns, within the paragraph's limits", () => {
    const text = "internationalization responsibilities extraordinarily incomprehensibilities";
    const l = lay(text, {}, { align: "justify-left" }, box(220));
    expect(l.lines.some((x) => x.hyphenated)).toBe(true);
    const none = lay(text, {}, { align: "justify-left", hyphenate: false }, box(220));
    expect(none.lines.some((x) => x.hyphenated)).toBe(false);
  });

  it("both composers fill the box; the every-line composer evens out the spacing", () => {
    const single = lay(LOREM_IPSUM, {}, { composer: "single", align: "justify-left" }, box(260));
    const every = lay(LOREM_IPSUM, {}, { composer: "every", align: "justify-left" }, box(260));
    for (const l of [single, every]) expect(l.lines.length).toBeGreaterThan(5);
    const spread = (l: TextLayout) => {
      const gaps = l.lines.slice(0, -1).map((line) => (line.carets[line.carets.length - 1] - line.carets[0]) / Math.max(1, LOREM_IPSUM.slice(line.start, line.end).split(" ").length));
      return Math.max(...gaps) - Math.min(...gaps);
    };
    expect(spread(every)).toBeLessThanOrEqual(spread(single) + 1e-6);
  });

  it("indents the first line and the edges, and spaces paragraphs", () => {
    const l = lay("aaa bbb ccc ddd eee fff\nggg", {}, { indentStart: 10, indentFirst: 20, spaceBefore: 7 }, box(120));
    expect(l.lines[0].carets[0]).toBeCloseTo(30, 5);
    expect(l.lines[1].carets[0]).toBeCloseTo(10, 5);
    const lastFirst = l.lines.find((x) => x.paragraph === 1)!;
    const prev = l.lines[l.lines.indexOf(lastFirst) - 1];
    expect(lastFirst.block - prev.block).toBeCloseTo(24 + 7, 5);
  });

  it("centres and right-aligns within the box", () => {
    const c = lay("Hi", {}, { align: "center" }, box(200)), r = lay("Hi", {}, { align: "right" }, box(200));
    const w = width(c);
    expect(c.lines[0].carets[0]).toBeCloseTo((200 - w) / 2, 5);
    expect(r.lines[0].carets[0]).toBeCloseTo(200 - w, 5);
  });

  it("overflows: lines below the box aren't drawn", () => {
    const l = lay(LOREM_IPSUM, {}, {}, box(300, 60));
    expect(l.overflow).toBe(true);
    expect(l.lines.some((x) => !x.visible)).toBe(true);
    const drawn = new Set(l.glyphs.map((g) => g.char));
    const hidden = l.lines.find((x) => !x.visible)!;
    expect(drawn.has(hidden.start)).toBe(false);
  });

  it("hangs punctuation outside the margins when asked", () => {
    const plain = lay("“Quote", {}, {}, box(300)), hung = lay("“Quote", {}, { hangingPunctuation: true }, box(300));
    expect(hung.lines[0].carets[0]).toBeLessThan(plain.lines[0].carets[0]);
  });

  it("a word wider than the box breaks inside it rather than overflowing the line", () => {
    const l = lay("supercalifragilistic", {}, { hyphenate: false }, box(60));
    expect(l.lines.length).toBeGreaterThan(1);
  });
});

describe("vertical, path and area type", () => {
  it("vertical type runs down columns, right to left; Roman characters turn", () => {
    const c = textContent("ab\ncd", style(), para());
    const l = layoutText({ ...c, orientation: "vertical" }, { fonts });
    expect(l.vertical).toBe(true);
    const [a, b] = l.glyphs;
    expect(b.y).toBeGreaterThan(a.y);
    expect(Math.abs(b.x - a.x)).toBeLessThan(1e-6);
    expect(a.rotate).toBeCloseTo(Math.PI / 2);
    const cd = l.glyphs[2];
    expect(cd.x).toBeLessThan(a.x);
  });

  it("type on a path follows it", () => {
    const k = (x: number, y: number) => ({ anchor: { x, y }, in: { x, y }, out: { x, y } });
    const frame: TextFrame = { kind: "path", knots: [k(0, 0), k(300, 300)], closed: false, start: 0, flipped: false };
    const l = lay("path", {}, {}, frame);
    for (const g of l.glyphs) {
      expect(g.rotate).toBeCloseTo(Math.PI / 4, 3);
      expect(g.x).toBeCloseTo(g.y, 3);
    }
  });

  it("area type wraps inside a closed shape", () => {
    const k = (x: number, y: number) => ({ anchor: { x, y }, in: { x, y }, out: { x, y } });
    // A triangle: lines get longer further down.
    const frame: TextFrame = { kind: "area", contours: [[k(150, 0), k(300, 300), k(0, 300)]] };
    const l = lay(LOREM_IPSUM, {}, { hyphenate: false }, frame);
    const visible = l.lines.filter((x) => x.visible);
    expect(visible.length).toBeGreaterThan(3);
    const w = (x: (typeof visible)[number]) => x.carets[x.carets.length - 1] - x.carets[0];
    expect(w(visible[visible.length - 2])).toBeGreaterThan(w(visible[0]));
  });
});

describe("styles over ranges", () => {
  it("paragraph attributes follow the paragraphs a range touches", () => {
    let c = textContent("one\ntwo\nthree", style(), para());
    c = setParagraphStyle(c, { start: 5, end: 9 }, { align: "right" });
    expect(c.paragraphs.map((p) => p.style.align)).toEqual(["left", "right", "right"]);
  });

  it("missing fonts are reported and drawn in the default font", () => {
    const l = lay("Hi", { font: { postScriptName: "Nope-Regular", family: "Nope", style: "Regular" } });
    expect([...l.missing]).toEqual(["Nope-Regular"]);
    expect(l.glyphs).toHaveLength(2);
  });
});
