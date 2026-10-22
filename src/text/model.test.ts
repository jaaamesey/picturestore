import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAR_STYLE,
  applyCharacterStyle,
  applyParagraphStyle,
  charOverrides,
  insertContent,
  redefineCharacterStyle,
  replaceText,
  setCharStyle,
  setParagraphStyle,
  sliceContent,
  styleAt,
  stylesIn,
  textContent,
  type NamedStyle,
  type CharStyle,
} from "./model";

const sizes = (c: { runs: readonly { length: number; style: CharStyle }[] }) => c.runs.map((r) => [r.length, r.style.size]);

describe("text content", () => {
  it("styles ranges, splitting and merging runs", () => {
    let c = textContent("hello world");
    c = setCharStyle(c, { start: 0, end: 5 }, { size: 30 });
    expect(sizes(c)).toEqual([[5, 30], [6, 12]]);
    c = setCharStyle(c, { start: 5, end: 11 }, { size: 30 });
    expect(sizes(c)).toEqual([[11, 30]]);
  });

  it("typing takes the style before the caret; at the start, the style after", () => {
    let c = setCharStyle(textContent("ab"), { start: 1, end: 2 }, { size: 40 });
    expect(styleAt(c, 0).style.size).toBe(12);
    expect(styleAt(c, 2).style.size).toBe(40);
    c = replaceText(c, { start: 2, end: 2 }, "c");
    expect(sizes(c)).toEqual([[1, 12], [2, 40]]);
    expect(stylesIn(c, { start: 0, end: 3 }).map((r) => r.style.size)).toEqual([12, 40]);
  });

  it("new paragraphs copy the one they split from; deleting a break merges into the first", () => {
    let c = setParagraphStyle(textContent("onetwo"), { start: 0, end: 0 }, { align: "center" });
    c = replaceText(c, { start: 3, end: 3 }, "\n");
    expect(c.paragraphs.map((p) => p.style.align)).toEqual(["center", "center"]);
    c = setParagraphStyle(c, { start: 5, end: 5 }, { align: "right" });
    c = replaceText(c, { start: 3, end: 4 }, "");
    expect(c.text).toBe("onetwo");
    expect(c.paragraphs.map((p) => p.style.align)).toEqual(["center"]);
  });

  it("deleting everything keeps the typing style", () => {
    const c = replaceText(setCharStyle(textContent("abc"), { start: 0, end: 3 }, { size: 50 }), { start: 0, end: 3 }, "");
    expect(c.runs).toHaveLength(1);
    expect(c.runs[0]).toMatchObject({ length: 0, style: { size: 50 } });
    expect(replaceText(c, { start: 0, end: 0 }, "x").runs[0].style.size).toBe(50);
  });

  it("copies and pastes with styles", () => {
    const c = setCharStyle(textContent("abcdef"), { start: 1, end: 3 }, { size: 33 });
    const piece = sliceContent(c, { start: 0, end: 3 });
    const out = insertContent(textContent("XY"), { start: 1, end: 1 }, piece);
    expect(out.text).toBe("XabcY");
    expect(sizes(out)).toEqual([[2, 12], [2, 33], [1, 12]]);
  });
});

describe("named styles", () => {
  const big: NamedStyle<CharStyle> = { id: "big", name: "Big", attributes: { size: 48, fauxBold: true } };
  const styles = { character: [big], paragraph: [] };

  it("applying a character style sets its attributes; local changes are overrides", () => {
    let c = applyCharacterStyle(textContent("hello"), { start: 0, end: 5 }, big);
    expect(c.runs[0]).toMatchObject({ styleId: "big", style: { size: 48, fauxBold: true } });
    expect(charOverrides(c.runs[0], styles)).toEqual({});
    c = setCharStyle(c, { start: 0, end: 5 }, { size: 20 });
    expect(charOverrides(c.runs[0], styles)).toEqual({ size: 20 });
  });

  it("redefining a style updates what isn't overridden", () => {
    let c = applyCharacterStyle(textContent("hello world"), { start: 0, end: 11 }, big);
    c = setCharStyle(c, { start: 6, end: 11 }, { size: 20 });
    c = redefineCharacterStyle(c, "big", big.attributes, { size: 60, fauxBold: false });
    expect(c.runs.map((r) => [r.length, r.style.size, r.style.fauxBold])).toEqual([[6, 60, false], [5, 20, false]]);
  });

  it("paragraph styles carry character attributes over their paragraphs", () => {
    const head = { id: "h", name: "Heading", attributes: { align: "center" as const, character: { size: 36 } } };
    const c = applyParagraphStyle(textContent("Title\nbody"), { start: 0, end: 0 }, head);
    expect(c.paragraphs.map((p) => [p.styleId, p.style.align])).toEqual([["h", "center"], [null, "left"]]);
    expect(sizes(c)).toEqual([[5, 36], [5, DEFAULT_CHAR_STYLE.size]]);
  });
});
