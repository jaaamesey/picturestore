import { beforeAll, describe, expect, it } from "vitest";
import { collapseSide, moveCaret, selectionPolygons } from "./edit";
import { textLayout, useFontLibrary } from "./engine";
import { DEFAULT_CHAR_STYLE, DEFAULT_PARAGRAPH_STYLE, setCharStyle, textContent, type TextContent } from "./model";
import { testLibrary } from "./testFonts";

beforeAll(() => useFontLibrary(testLibrary()));

const text = (s: string, direction: "ltr" | "rtl" = "ltr"): TextContent =>
  textContent(s, { ...DEFAULT_CHAR_STYLE, size: 40 }, { ...DEFAULT_PARAGRAPH_STYLE, direction }, { kind: "point" }, [1, 0, 0, 1, 0, 0]);
const caretX = (c: TextContent, i: number) => textLayout(c).lines[0].carets[i];

describe("right-to-left type", () => {
  it("Arabic is drawn in a font that has it, joined, right to left", () => {
    // Default font: Source Sans has no Arabic, so the characters fall back to Noto Sans Arabic.
    const c = text("سلام");
    const l = textLayout(c);
    expect(l.missing.size).toBe(0);
    expect(l.glyphs.every((g) => g.face.info.ref.family === "Noto Sans Arabic")).toBe(true);
    // Joined: the medial and final forms differ from the letters alone.
    const alone = [..."سلام"].map((ch) => textLayout(text(ch)).glyphs[0].gid);
    const joined = [...l.glyphs].sort((a, b) => a.char - b.char).map((g) => g.gid);
    expect(joined).not.toEqual(alone);
    // Right to left: the first letter is rightmost; caret stops run leftwards.
    const byChar = [...l.glyphs].sort((a, b) => a.char - b.char);
    expect(byChar[0].x).toBeGreaterThan(byChar[3].x);
    expect(caretX(c, 0)).toBeGreaterThan(caretX(c, 4));
  });

  it("mixed text keeps each run's direction; Left and Right move on screen, not in reading order", () => {
    const c = text("abc سلام def");
    const l = textLayout(c);
    // The Arabic word's first letter (index 4) is right of its last (index 7).
    expect(caretX(c, 4)).toBeGreaterThan(caretX(c, 7));
    // From just before the Arabic (after "abc "), Right goes to the right on screen.
    const from = 4;
    const right = moveCaret(l, c.text, from, "right", null).index;
    expect(caretX(c, right)).toBeGreaterThan(caretX(c, from));
    const left = moveCaret(l, c.text, 6, "left", null).index;
    expect(caretX(c, left)).toBeLessThan(caretX(c, 6));
    // Whole runs, end to end: stepping right from the start reaches the end, visiting every stop once.
    let i = 0;
    const seen = new Set<number>([0]);
    for (let n = 0; n < 20 && i !== c.text.length; n++) seen.add((i = moveCaret(l, c.text, i, "right", null).index));
    expect(i).toBe(c.text.length);
    expect(seen.size).toBeGreaterThanOrEqual(c.text.length);
  });

  it("a selection across the change of direction is highlighted in pieces, as it's drawn", () => {
    const c = text("abc سلام def");
    // "c سل": the end of the Latin run and the start of the Arabic one, which isn't next to it on screen.
    const polys = selectionPolygons(textLayout(c), 2, 6);
    expect(polys.length).toBe(2);
    // An underline does the same.
    const u = setCharStyle(c, { start: 2, end: 6 }, { underline: true });
    expect(textLayout(u).decorations.length).toBe(2);
  });

  it("Left or Right with a selection goes to its end on that side of the screen", () => {
    const c = text("سلام");
    // In Arabic, the selection's logical start is on the right.
    expect(collapseSide(textLayout(c), 1, 3, "right")).toBe(1);
    expect(collapseSide(textLayout(c), 1, 3, "left")).toBe(3);
  });

  it("a right-to-left paragraph puts mixed runs in its order: Latin then Arabic reads right to left", () => {
    const ltr = text("abc سلام"), rtl = text("abc سلام", "rtl");
    // Left-to-right: "abc" is left of the Arabic; right-to-left: right of it.
    expect(caretX(ltr, 0)).toBeLessThan(caretX(ltr, 5));
    expect(caretX(rtl, 0)).toBeGreaterThan(caretX(rtl, 5));
  });
});
