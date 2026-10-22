import { beforeAll, describe, expect, it } from "vitest";
import { CPU_RASTERIZERS, renderContent } from "../core/content";
import { createDocument, createLayer, type Doc } from "../core/document";
import { imageSize } from "../core/documentTransform";
import { rect, vec } from "../core/geometry";
import { contentBounds, readRect } from "../core/pixels";
import { drawText, textLayout, useFontLibrary } from "./engine";
import { DEFAULT_CHAR_STYLE, DEFAULT_PARAGRAPH_STYLE, textContent, type TextContent, type WarpStyle } from "./model";
import { testLibrary } from "./testFonts";
import { WARP_STYLES, warpMap } from "./warp";

beforeAll(() => useFontLibrary(testLibrary()));

const text = (s: string, size = 40, extra: Partial<TextContent> = {}): TextContent => ({
  ...textContent(s, { ...DEFAULT_CHAR_STYLE, size }, DEFAULT_PARAGRAPH_STYLE, { kind: "point" }, [1, 0, 0, 1, 20, 60]),
  ...extra,
});
const render = (c: TextContent, w = 400, h = 200) => renderContent(c, rect(0, 0, w, h), CPU_RASTERIZERS);

describe("rendering type", () => {
  it("draws glyphs from the baseline at the origin, cap height above it", async () => {
    const px = (await render(text("HH")))!;
    const b = contentBounds(px);
    // "H" sits on the baseline (y 60) and rises the cap height (0.66 em).
    expect(b.y).toBeGreaterThanOrEqual(60 - 0.66 * 40 - 2);
    expect(b.y + b.h).toBeLessThanOrEqual(61);
    expect(b.x).toBeGreaterThanOrEqual(20);
  });

  it("is colour by colour: each run its own paint", () => {
    const c = text("ab");
    const two = { ...c, runs: [{ ...c.runs[0], length: 1 }, { ...c.runs[0], length: 1, style: { ...c.runs[0].style, color: { r: 255, g: 0, b: 0 } } }] };
    expect(drawText(two).paints).toHaveLength(2);
    expect(drawText(c).paints).toHaveLength(1);
  });

  it("Anti-aliasing None draws hard edges; Smooth draws partial coverage", async () => {
    const alphas = async (c: TextContent) => {
      const px = (await render(c))!;
      const data = readRect(px, contentBounds(px));
      return new Set([...data.filter((_, i) => i % 4 === 3)]);
    };
    expect([...(await alphas(text("O", 40, { antiAlias: "none" })))].every((a) => a === 0 || a === 255)).toBe(true);
    expect([...(await alphas(text("O", 40, { antiAlias: "smooth" })))].some((a) => a > 0 && a < 255)).toBe(true);
  });

  it("faux bold thickens, underline adds a bar below the baseline", async () => {
    const ink = async (c: TextContent) => {
      const px = (await render(c))!;
      return readRect(px, contentBounds(px)).filter((_, i) => i % 4 === 3).reduce((s, a) => s + a, 0);
    };
    const plain = text("l");
    expect(await ink({ ...plain, runs: [{ ...plain.runs[0], style: { ...plain.runs[0].style, fauxBold: true } }] })).toBeGreaterThan((await ink(plain)) * 1.1);
    const under = { ...plain, runs: [{ ...plain.runs[0], style: { ...plain.runs[0].style, underline: true } }] };
    expect(contentBounds((await render(under))!).y + contentBounds((await render(under))!).h).toBeGreaterThan(62);
  });

  it("warps: every style bends its bounds, none of them at zero; Arc lowers both ends", () => {
    const bounds = rect(0, -40, 200, 50);
    const warp = (style: WarpStyle, bend: number) => warpMap({ style, orientation: "horizontal", bend, horizontalDistortion: 0, verticalDistortion: 0 }, bounds);
    for (const { id } of WARP_STYLES) {
      const flat = warp(id, 0), bent = warp(id, 0.5);
      const probe = [vec(10, -30), vec(100, -15), vec(190, 0), vec(50, 5)];
      for (const p of probe) {
        expect(flat(p).x).toBeCloseTo(p.x, 6);
        expect(flat(p).y).toBeCloseTo(p.y, 6);
      }
      expect(probe.some((p) => Math.hypot(bent(p).x - p.x, bent(p).y - p.y) > 1)).toBe(true);
    }
    const arc = warp("arc", 0.5);
    expect(arc(vec(0, -15)).y).toBeGreaterThan(arc(vec(100, -15)).y + 10);
    expect(arc(vec(200, -15)).y).toBeCloseTo(arc(vec(0, -15)).y, 6);
    // A warped layer's drawing goes through it.
    const c = text("Warped", 40);
    const arcText = { ...c, warp: { style: "arc" as const, orientation: "horizontal" as const, bend: 0.5, horizontalDistortion: 0, verticalDistortion: 0 } };
    expect(drawText(arcText).bounds).not.toEqual(drawText(c).bounds);
  });

  it("Image Size scales type exactly, as vectors, and it stays type", async () => {
    const c = text("Scale", 30);
    let doc: Doc = createDocument({ width: 300, height: 100, background: null });
    const layer = createLayer({ name: "T", content: c, pixels: (await render(c, 300, 100))! });
    doc = { ...doc, layers: [layer], activeLayerId: layer.id };
    const before = contentBounds(layer.pixels);
    const big = await imageSize(doc, { width: 600, height: 200, resolution: 72, filter: "bicubic", scaleStyles: true }, CPU_RASTERIZERS);
    const l = big.layers[0];
    expect(l.content.kind).toBe("text");
    const after = contentBounds(l.pixels);
    expect(after.w).toBeGreaterThanOrEqual(before.w * 2 - 2);
    expect(after.w).toBeLessThanOrEqual(before.w * 2 + 2);
    // The text itself is unchanged: only its transform.
    expect((l.content as TextContent).runs[0].style.size).toBe(30);
    expect(textLayout(l.content as TextContent).lines).toHaveLength(1);
  });
});
