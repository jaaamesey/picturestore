import { describe, expect, it } from "vitest";
import { rect, vec } from "./geometry";
import { rasterizeMapping, type Raster } from "./rasterize";
import {
  IDENTITY_PATCH, dragPatchSurface, evalPatch, invert3, invertPatch, isConvex, mapPoint, mappingBounds, mul3, project,
  quadOf, squareToQuad, tessellate, type Quad,
} from "./warp";

const near = (a: { x: number; y: number }, b: { x: number; y: number }, d = 6) => {
  expect(a.x).toBeCloseTo(b.x, d);
  expect(a.y).toBeCloseTo(b.y, d);
};

describe("homographies", () => {
  const trapezoid: Quad = [vec(20, 0), vec(80, 0), vec(100, 50), vec(0, 50)];

  it("maps unit-square corners onto the quad", () => {
    const H = squareToQuad(trapezoid)!;
    near(project(H, 0, 0), trapezoid[0]);
    near(project(H, 1, 0), trapezoid[1]);
    near(project(H, 1, 1), trapezoid[2]);
    near(project(H, 0, 1), trapezoid[3]);
  });

  it("is affine for parallelograms", () => {
    const H = squareToQuad([vec(0, 0), vec(10, 2), vec(12, 12), vec(2, 10)])!;
    expect(H[6]).toBeCloseTo(0, 12);
    expect(H[7]).toBeCloseTo(0, 12);
  });

  it("inverts", () => {
    const H = squareToQuad(trapezoid)!;
    const I = mul3(H, invert3(H)!);
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => expect(I[i] / I[8]).toBeCloseTo(v, 9));
  });

  it("rejects degenerate and non-convex quads", () => {
    expect(squareToQuad([vec(0, 0), vec(1, 0), vec(2, 0), vec(3, 0)])).toBeNull();
    expect(isConvex(trapezoid)).toBe(true);
    expect(isConvex([vec(0, 0), vec(10, 0), vec(2, 2), vec(0, 10)])).toBe(false);
  });
});

describe("warp patches", () => {
  it("the identity patch is the unit square", () => {
    near(evalPatch(IDENTITY_PATCH, 0.3, 0.7), vec(0.3, 0.7), 9);
  });

  it("inverts surface points", () => {
    const p = IDENTITY_PATCH.map((c, k) => (k === 5 ? vec(c.x + 0.2, c.y - 0.1) : c));
    const q = evalPatch(p, 0.4, 0.6);
    const st = invertPatch(p, q)!;
    expect(st.s).toBeCloseTo(0.4, 6);
    expect(st.t).toBeCloseTo(0.6, 6);
    expect(invertPatch(p, vec(2, 2))).toBeNull();
  });

  it("dragging the surface moves the grabbed point exactly", () => {
    const moved = dragPatchSurface(IDENTITY_PATCH, 0.25, 0.5, vec(0.1, -0.05));
    near(evalPatch(moved, 0.25, 0.5), vec(0.35, 0.45), 9);
    near(moved[0], IDENTITY_PATCH[0], 1); // far control points barely move
  });

  it("tessellates and bounds", () => {
    const m = { source: rect(0, 0, 100, 100), quad: quadOf(rect(10, 10, 100, 100)), patch: null };
    expect(tessellate(m).indices.length).toBe(6);
    expect(mappingBounds(m)).toEqual(rect(10, 10, 100, 100));
    const warped = { ...m, patch: IDENTITY_PATCH.map((c, k) => (k === 5 ? vec(c.x, c.y - 0.6) : c)) };
    const b = mappingBounds(warped);
    expect(b.y).toBeLessThan(10);
    near(mapPoint(warped, 1, 1), vec(110, 110));
  });
});

const solid = (w: number, h: number, f: (x: number, y: number) => number[]): Raster => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  return { width: w, height: h, channels: 4, data };
};
const px = (r: Raster, x: number, y: number) => [...r.data.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 4)];

describe("rasterizeMapping", () => {
  const gradient = solid(16, 16, (x, y) => [x * 16, y * 16, 100, 255]);

  it.each(["nearest", "bilinear", "bicubic"] as const)("identity is an exact copy (%s)", (filter) => {
    const m = { source: rect(0, 0, 16, 16), quad: quadOf(rect(0, 0, 16, 16)), patch: null };
    const out = rasterizeMapping(gradient, rect(0, 0, 16, 16), m, rect(0, 0, 16, 16), filter);
    expect([...out.data]).toEqual([...gradient.data]);
  });

  it("translates through an offset destination", () => {
    const m = { source: rect(0, 0, 16, 16), quad: quadOf(rect(5, 7, 16, 16)), patch: null };
    const out = rasterizeMapping(gradient, rect(0, 0, 16, 16), m, rect(5, 7, 16, 16), "bicubic");
    expect(px(out, 3, 4)).toEqual(px(gradient, 3, 4));
  });

  it("is exact under perspective at mapped texel centres", () => {
    const quad: Quad = [vec(40, 0), vec(88, 0), vec(128, 64), vec(0, 64)];
    const m = { source: rect(0, 0, 16, 16), quad, patch: null };
    const out = rasterizeMapping(gradient, rect(0, 0, 16, 16), m, rect(0, 0, 128, 64), "bilinear");
    // The near (bottom) edge is magnified, so its colour comes from the bottom source rows.
    const bottom = px(out, 64, 56);
    expect(bottom[1]).toBeGreaterThan(200);
    expect(bottom[3]).toBe(255);
    expect(px(out, 2, 2)[3]).toBe(0); // outside the trapezoid
  });

  it("prefilters minification instead of aliasing", () => {
    const checker = solid(64, 64, (x, y) => ((x + y) % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const m = { source: rect(0, 0, 64, 64), quad: quadOf(rect(0, 0, 8, 8)), patch: null };
    const out = rasterizeMapping(checker, rect(0, 0, 64, 64), m, rect(0, 0, 8, 8), "bicubic");
    for (let i = 0; i < out.data.length; i += 4) expect(Math.abs(out.data[i] - 128)).toBeLessThan(4);
  });

  it("resamples 1-channel masks", () => {
    const mask: Raster = { width: 4, height: 4, channels: 1, data: new Uint8Array(16).fill(255) };
    const m = { source: rect(0, 0, 4, 4), quad: quadOf(rect(0, 0, 8, 8)), patch: null };
    const out = rasterizeMapping(mask, rect(0, 0, 4, 4), m, rect(0, 0, 8, 8), "bilinear");
    expect(out.data[3 * 8 + 3]).toBe(255);
  });
});
