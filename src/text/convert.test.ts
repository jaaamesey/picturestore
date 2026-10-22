import { beforeAll, describe, expect, it } from "vitest";
import { CPU_RASTERIZERS, pathShape, renderContent } from "../core/content";
import type { LayerContent } from "../core/document";
import { rect } from "../core/geometry";
import { readRect, type Pixels } from "../core/pixels";
import { overflowLost, textOutlines, toParagraphText, toPointText, usesFauxBold } from "./convert";
import { useFontLibrary } from "./engine";
import { DEFAULT_CHAR_STYLE, DEFAULT_PARAGRAPH_STYLE, setCharStyle, setParagraphStyle, textContent, type TextContent } from "./model";
import { testLibrary } from "./testFonts";

beforeAll(() => useFontLibrary(testLibrary()));

const text = (s: string, frame: TextContent["frame"] = { kind: "point" }): TextContent =>
  textContent(s, { ...DEFAULT_CHAR_STYLE, size: 30 }, DEFAULT_PARAGRAPH_STYLE, frame, [1, 0, 0, 1, 20, 60]);
const AREA = rect(0, 0, 400, 300);
const alpha = (px: Pixels) => readRect(px, AREA).filter((_, i) => i % 4 === 3);
const pixels = async (c: LayerContent) => alpha((await renderContent(c, AREA, CPU_RASTERIZERS))!);
/** The largest coverage difference between two renderings. */
const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
const same = async (a: TextContent, b: TextContent) => diff(await pixels(a), await pixels(b));

describe("converting type", () => {
  it("point type becomes paragraph type that reads exactly the same, whatever the alignment", async () => {
    for (const align of ["left", "center", "right"] as const) {
      const c = setParagraphStyle(text("Hello\nworld again"), { start: 0, end: 17 }, { align });
      const p = toParagraphText(c);
      expect(p.frame.kind).toBe("box");
      expect(p.text).toBe(c.text);
      expect(await same(c, p)).toBeLessThanOrEqual(2);
    }
  });

  it("paragraph type becomes point type with a return where each line wrapped, set the same", async () => {
    const c = text("one two three four five six", { kind: "box", width: 120, height: 200 });
    const p = toPointText(c);
    expect(p.frame).toEqual({ kind: "point" });
    expect(p.text.split("\n").length).toBeGreaterThan(1);
    expect(p.text.replace(/\n/g, " ")).toBe(c.text);
    expect(p.paragraphs.length).toBe(p.text.split("\n").length);
    expect(await same(c, p)).toBeLessThanOrEqual(2);
  });

  it("text overflowing the box is lost on conversion (Photoshop asks first)", () => {
    const c = text("one two three four five six seven", { kind: "box", width: 80, height: 40 });
    expect(overflowLost(c)).toBe(true);
    const p = toPointText(c);
    expect(p.text.length).toBeLessThan(c.text.length);
    expect(overflowLost(text("one", { kind: "box", width: 200, height: 100 }))).toBe(false);
  });

  it("outlines draw the type as it's drawn: a shape from them covers the same pixels", async () => {
    const c = { ...setCharStyle(text("Rag"), { start: 0, end: 3 }, { underline: true }), antiAlias: "smooth" as const };
    const contours = textOutlines(c);
    expect(contours.length).toBeGreaterThan(4);
    const shape = pathShape(contours, { fill: { r: 0, g: 0, b: 0 }, stroke: null })!;
    expect(diff(await pixels(c), await pixels(shape))).toBeLessThanOrEqual(8);
    expect(usesFauxBold(c)).toBe(false);
    expect(usesFauxBold(setCharStyle(c, { start: 0, end: 1 }, { fauxBold: true }))).toBe(true);
  });
});
