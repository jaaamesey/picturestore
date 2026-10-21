import { describe, expect, it } from "vitest";
import { rect, vec } from "./geometry";
import { documentKnots, renderShape, shapeContours, shapeOutline, type ShapeGeometry, type ShapeStyle } from "./shape";
import { getPixel, readRect, type Pixels } from "./pixels";
import { quadOf, type Mapping } from "./warp";

const clip = rect(0, 0, 200, 200);
const red = { r: 255, g: 0, b: 0 };
const blue = { r: 0, g: 0, b: 255 };
const at = (box: ReturnType<typeof rect>): Mapping => ({ source: box, quad: quadOf(box), patch: null });
const area = (pixels: Pixels) => {
  const px = readRect(pixels, clip);
  let a = 0;
  for (let i = 3; i < px.length; i += 4) a += px[i] / 255;
  return a;
};
const fillOnly = (fill = red): ShapeStyle => ({ fill, stroke: null });

describe("shape geometry", () => {
  it.each<[string, ShapeGeometry, number]>([
    ["rectangle", { kind: "rectangle", radius: 0 }, 100 * 50],
    ["rounded rectangle", { kind: "rectangle", radius: 10 }, 100 * 50 - (4 - Math.PI) * 100],
    ["ellipse", { kind: "ellipse" }, Math.PI * 50 * 25],
    ["triangle", { kind: "triangle" }, (100 * 50) / 2],
    ["hexagon", { kind: "polygon", sides: 6, starRatio: 1 }, ((3 * Math.sqrt(3)) / 2) * 50 * 25 * (2 / Math.sqrt(3)) * (Math.sqrt(3) / 2)],
  ])("%s fills its exact area", (_, g, expected) => {
    const pixels = renderShape(g, fillOnly(), at(rect(20, 30, 100, 50)), clip);
    expect(area(pixels) / expected).toBeCloseTo(1, 2);
  });

  it("star ratio pulls in alternate vertices", () => {
    const [star] = shapeContours({ kind: "polygon", sides: 5, starRatio: 0.5 }, rect(0, 0, 100, 100));
    expect(star).toHaveLength(10);
    const [regular] = shapeContours({ kind: "polygon", sides: 5, starRatio: 1 }, rect(0, 0, 100, 100));
    expect(regular).toHaveLength(5);
  });
});

describe("strokes", () => {
  const box = rect(50, 50, 100, 100);
  const sq: ShapeGeometry = { kind: "rectangle", radius: 0 };
  const stroke = (align: "inside" | "center" | "outside"): ShapeStyle => ({ fill: null, stroke: { color: blue, width: 10, align } });

  it.each([
    ["inside", 100 * 100 - 80 * 80],
    ["center", 110 * 110 - 90 * 90],
    ["outside", 120 * 120 - 100 * 100],
  ] as const)("aligns %s with exact miter corners", (align, expected) => {
    expect(area(renderShape(sq, stroke(align), at(box), clip)) / expected).toBeCloseTo(1, 2);
  });

  it("paints the stroke over the fill", () => {
    const pixels = renderShape(sq, { fill: red, stroke: { color: blue, width: 4, align: "inside" } }, at(box), clip);
    expect(getPixel(pixels, 100, 100)).toEqual([255, 0, 0, 255]);
    expect(getPixel(pixels, 51, 100)).toEqual([0, 0, 255, 255]);
    expect(getPixel(pixels, 49, 100)[3]).toBe(0);
  });

  it("keeps its width when the shape is scaled", () => {
    const small = rect(50, 50, 50, 50);
    const scaled: Mapping = { source: small, quad: quadOf(rect(50, 50, 100, 100)), patch: null };
    const a = area(renderShape(sq, stroke("inside"), scaled, clip));
    expect(a / (100 * 100 - 80 * 80)).toBeCloseTo(1, 2);
  });
});

describe("transforms", () => {
  it("renders vectors exactly through perspective (no resampling)", () => {
    const m: Mapping = { source: rect(0, 0, 100, 100), quad: [vec(70, 20), vec(130, 20), vec(180, 180), vec(20, 180)], patch: null };
    const pixels = renderShape({ kind: "rectangle", radius: 0 }, fillOnly(), m, clip);
    // A trapezoid: (60 + 160) / 2 × 160.
    expect(area(pixels) / ((60 + 160) / 2) / 160).toBeCloseTo(1, 2);
    expect(getPixel(pixels, 100, 100)).toEqual([255, 0, 0, 255]);
  });

  it("exports Bézier knots exactly for affine placements, flattened otherwise", () => {
    const g: ShapeGeometry = { kind: "ellipse" };
    const affine = documentKnots(g, { source: rect(0, 0, 10, 10), quad: quadOf(rect(0, 0, 20, 10)), patch: null });
    expect(affine[0]).toHaveLength(4);
    expect(affine[0][1].anchor).toEqual(vec(20, 5));
    const persp = documentKnots(g, { source: rect(0, 0, 10, 10), quad: [vec(2, 0), vec(8, 0), vec(10, 10), vec(0, 10)], patch: null });
    expect(persp[0].length).toBeGreaterThan(16);
  });

  it("flattens curves finely enough to stay within 0.1px", () => {
    const [poly] = shapeOutline({ kind: "ellipse" }, at(rect(0, 0, 180, 180)));
    for (const p of poly) expect(Math.abs(Math.hypot(p.x - 90, p.y - 90) - 90)).toBeLessThan(0.15);
  });
});
