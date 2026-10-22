import { describe, expect, it } from "vitest";
import { DEFAULT_CHAR_STYLE, DEFAULT_PARAGRAPH_STYLE, setCharStyle, textContent } from "./model";
import { findAll, findFrom, replaceAll, wordsIn } from "./search";

const O = { caseSensitive: false, wholeWord: false, ignoreAccents: false };

describe("finding and replacing text", () => {
  it("finds with Photoshop's options: case, whole words, accents", () => {
    expect(findAll("Cat cat cattle", "cat", O)).toHaveLength(3);
    expect(findAll("Cat cat cattle", "cat", { ...O, caseSensitive: true })).toEqual([{ start: 4, end: 7 }, { start: 8, end: 11 }]);
    expect(findAll("Cat cat cattle", "cat", { ...O, wholeWord: true })).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }]);
    expect(findAll("café cafe", "cafe", O)).toEqual([{ start: 5, end: 9 }]);
    expect(findAll("café cafe", "cafe", { ...O, ignoreAccents: true })).toHaveLength(2);
  });

  it("finds onwards from the selection, or back, wrapping when asked", () => {
    const t = "a x b x c x";
    expect(findFrom(t, "x", { start: 0, end: 0 }, O)).toEqual({ start: 2, end: 3 });
    expect(findFrom(t, "x", { start: 2, end: 3 }, O)).toEqual({ start: 6, end: 7 });
    expect(findFrom(t, "x", { start: 10, end: 11 }, O)).toBeNull();
    expect(findFrom(t, "x", { start: 10, end: 11 }, O, true)).toEqual({ start: 2, end: 3 });
    expect(findFrom(t, "x", { start: 6, end: 7 }, { ...O, backward: true })).toEqual({ start: 2, end: 3 });
  });

  it("replaces every match, each keeping the style of what it replaced", () => {
    let c = textContent("red and red", DEFAULT_CHAR_STYLE, DEFAULT_PARAGRAPH_STYLE, { kind: "point" }, [1, 0, 0, 1, 0, 0]);
    c = setCharStyle(c, { start: 8, end: 11 }, { fauxBold: true });
    const { content, count } = replaceAll(c, "red", "blue", O);
    expect(count).toBe(2);
    expect(content.text).toBe("blue and blue");
    expect(content.runs.map((r) => [r.length, r.style.fauxBold])).toEqual([[9, false], [4, true]]);
  });

  it("splits text into words for spelling, apostrophes kept inside", () => {
    expect(wordsIn("It's 'quoted' 42 naïve—done").map((w) => w.word)).toEqual(["It's", "quoted", "naïve", "done"]);
    const w = wordsIn("'quoted'")[0];
    expect([w.start, w.end]).toEqual([1, 7]);
  });
});
