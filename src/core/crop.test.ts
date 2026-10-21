import { describe, expect, it } from "vitest";
import {
  boxCorners,
  boxToDoc,
  canvasBox,
  cropMatrix,
  cropOutput,
  docToBox,
  drawBox,
  fitInside,
  fitRatio,
  largestBox,
  levelAngle,
  orderQuad,
  overlayLines,
  parseLength,
  perspectiveAspect,
  perspectiveMatrix,
  perspectiveSize,
  resizeBox,
  rotateBox,
  swapOrientation,
  type CropBox,
} from "./crop";
import { asAffine, mapPoint } from "./documentTransform";
import { integerTranslation, vec, type Vec2 } from "./geometry";
import type { Quad } from "./warp";

const close = (a: Vec2, b: Vec2, digits = 6) => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
};
const free = { ratio: null, fromCentre: false };

describe("crop boxes", () => {
  const turned: CropBox = { cx: 50, cy: 40, w: 60, h: 30, angle: 0.4 };

  it("convert between box-local and document coordinates", () => {
    const p = vec(13, 27);
    close(docToBox(turned, boxToDoc(turned, p)), p);
    close(boxCorners(canvasBox(10, 8))[2], vec(10, 8));
  });

  it("resize from a handle, the opposite corner fixed, edges on whole pixels when unrotated", () => {
    const b = resizeBox(canvasBox(100, 80), 1, 1, vec(60.4, 50.6), free);
    expect(b).toEqual({ cx: 30, cy: 25.5, w: 60, h: 51, angle: 0 });
    const r = resizeBox(turned, 1, 1, boxToDoc(turned, vec(80, 50)), free);
    close(boxCorners(r)[0], boxCorners(turned)[0]);
    expect(r.w).toBeCloseTo(80, 9);
    expect(r.h).toBeCloseTo(50, 9);
  });

  it("keep a ratio: corners follow the larger change, edges centre the other side", () => {
    const b = resizeBox(canvasBox(100, 100), 1, 1, vec(50, 20), { ratio: 2, fromCentre: false });
    expect([b.w, b.h]).toEqual([50, 25]);
    const e = resizeBox(canvasBox(100, 100), 1, 0, vec(60, 50), { ratio: 2, fromCentre: false });
    expect(e).toEqual({ cx: 30, cy: 50, w: 60, h: 30, angle: 0 });
  });

  it("resize about the centre with Alt", () => {
    expect(resizeBox(canvasBox(100, 100), 1, 0, vec(70, 0), { ratio: null, fromCentre: true })).toEqual({ cx: 50, cy: 50, w: 40, h: 100, angle: 0 });
  });

  it("never collapse below a pixel or turn inside out", () => {
    const b = resizeBox(canvasBox(100, 100), -1, -1, vec(500, 500), free);
    expect([b.w, b.h]).toEqual([1, 1]);
  });

  it("are drawn by dragging, square with Shift, from the centre with Alt", () => {
    expect(drawBox(vec(10, 10), vec(40, 30), 0, { ratio: null, square: false, fromCentre: false })).toEqual({ cx: 25, cy: 20, w: 30, h: 20, angle: 0 });
    expect(drawBox(vec(10, 10), vec(-20, 30), 0, { ratio: null, square: true, fromCentre: false })).toEqual({ cx: -5, cy: 25, w: 30, h: 30, angle: 0 });
    expect(drawBox(vec(50, 50), vec(60, 55), 0, { ratio: null, square: false, fromCentre: true })).toEqual({ cx: 50, cy: 50, w: 20, h: 10, angle: 0 });
  });

  it("fit a ratio within themselves, and swap orientation", () => {
    expect(fitRatio(canvasBox(300, 200), 1)).toEqual({ cx: 150, cy: 100, w: 200, h: 200, angle: 0 });
    expect(swapOrientation({ cx: 50, cy: 50, w: 40, h: 20, angle: 0 })).toEqual({ cx: 50, cy: 50, w: 20, h: 40, angle: 0 });
  });

  it("shrink to fit within the canvas when straightened, leaving no empty corners", () => {
    const b = fitInside(rotateBox(canvasBox(400, 300), Math.PI / 12), 400, 300);
    expect(b.w / b.h).toBeCloseTo(4 / 3, 9);
    for (const c of boxCorners(b)) {
      expect(c.x).toBeGreaterThanOrEqual(-1e-9);
      expect(c.x).toBeLessThanOrEqual(400 + 1e-9);
      expect(c.y).toBeGreaterThanOrEqual(-1e-9);
      expect(c.y).toBeLessThanOrEqual(300 + 1e-9);
    }
    // As large as it can be: a corner touches an edge.
    expect(Math.min(...boxCorners(b).flatMap((c) => [c.x, c.y, 400 - c.x, 300 - c.y]))).toBeCloseTo(0, 9);
  });

  it("straighten to level or plumb, whichever is nearer", () => {
    expect(levelAngle(vec(0, 0), vec(100, 10))).toBeCloseTo(Math.atan2(10, 100), 12);
    expect(levelAngle(vec(0, 0), vec(-5, 100))).toBeCloseTo(Math.atan2(100, -5) - Math.PI / 2, 12);
    expect(levelAngle(vec(100, 10), vec(0, 0))).toBeCloseTo(Math.atan2(10, 100), 12);
  });
});

describe("crop transforms", () => {
  it("are whole-pixel translations for unrotated boxes", () => {
    const m = cropMatrix({ cx: 35, cy: 20.5, w: 50, h: 21, angle: 0 }, 50, 21);
    expect(integerTranslation(asAffine(m)!)).toEqual(vec(-10, -10));
  });

  it("map a turned box onto the new canvas, scaled to a fixed size", () => {
    const b: CropBox = { cx: 50, cy: 40, w: 60, h: 30, angle: -0.3 };
    const m = cropMatrix(b, 120, 60);
    const target = [vec(0, 0), vec(120, 0), vec(120, 60), vec(0, 60)];
    boxCorners(b).forEach((c, i) => close(mapPoint(m, c), target[i]));
  });

  it("straighten a quad onto a rectangle (perspective)", () => {
    const q: Quad = [vec(10, 20), vec(200, 5), vec(220, 180), vec(0, 150)];
    const m = perspectiveMatrix(q, 300, 200)!;
    const target = [vec(0, 0), vec(300, 0), vec(300, 200), vec(0, 200)];
    q.forEach((c, i) => close(mapPoint(m, c), target[i], 6));
  });

  it("recover a photographed rectangle's true proportions", () => {
    // A 3 : 2 rectangle, tilted in 3D and seen by a pinhole camera.
    const f = 900, centre = vec(640, 480);
    const rx = 0.5, ry = -0.35;
    const project = (x: number, y: number) => {
      // Rotate about x then y, push away from the camera.
      const y1 = y * Math.cos(rx), z1 = y * Math.sin(rx);
      const x2 = x * Math.cos(ry) + z1 * Math.sin(ry), z2 = -x * Math.sin(ry) + z1 * Math.cos(ry) + 1000;
      return vec(centre.x + (f * x2) / z2, centre.y + (f * y1) / z2);
    };
    const q: Quad = [project(-300, -200), project(300, -200), project(300, 200), project(-300, 200)];
    expect(perspectiveAspect(q, centre)).toBeCloseTo(1.5, 6);
    const s = perspectiveSize(q, centre);
    expect(s.width / s.height).toBeCloseTo(1.5, 2);
  });

  it("fall back to the sides' proportions without perspective", () => {
    const q: Quad = [vec(0, 0), vec(200, 20), vec(200, 120), vec(0, 100)];
    expect(perspectiveSize(q, vec(100, 60))).toEqual({ width: 201, height: 100 });
  });
});

describe("crop options", () => {
  it("parse typed lengths with units", () => {
    expect(parseLength("4 in", "pixels")).toEqual({ value: 4, unit: "inches" });
    expect(parseLength("1200", "pixels")).toEqual({ value: 1200, unit: "pixels" });
    expect(parseLength("2.5cm", "pixels")).toEqual({ value: 2.5, unit: "centimeters" });
    expect(parseLength("abc", "pixels")).toBeNull();
    expect(parseLength("0", "pixels")).toBeNull();
  });

  it("size the result: the box itself, or resampled to W x H x Resolution", () => {
    const b: CropBox = { cx: 50, cy: 50, w: 200, h: 100, angle: 0.2 };
    expect(cropOutput(b, { mode: "ratio", width: null, height: null, resolution: null }, 72)).toEqual({ width: 200, height: 100, resolution: 72 });
    const inches = { mode: "size", width: { value: 4, unit: "inches" }, height: { value: 2, unit: "inches" }, resolution: 300 } as const;
    expect(cropOutput(b, inches, 72)).toEqual({ width: 1200, height: 600, resolution: 300 });
    expect(cropOutput(b, { ...inches, height: null }, 72)).toEqual({ width: 1200, height: 600, resolution: 300 });
  });

  it("order clicked corners into a quad", () => {
    const q = orderQuad([vec(100, 100), vec(0, 0), vec(0, 100), vec(100, 0)]);
    expect(q).toEqual([vec(0, 0), vec(100, 0), vec(100, 100), vec(0, 100)]);
  });
});

describe("crop overlays", () => {
  it("draw thirds and golden ratio lines", () => {
    overlayLines("thirds", 0, 300, 90, 0).forEach((l, i) => close(l[0], [vec(100, 0), vec(0, 30), vec(200, 0), vec(0, 60)][i], 9));
    expect(overlayLines("golden-ratio", 0, 100, 100, 0)[0][0].x).toBeCloseTo(38.197, 3);
  });

  it("draw a continuous golden spiral within the box, in every orientation", () => {
    for (let o = 0; o < 4; o++) {
      const lines = overlayLines("golden-spiral", o, 320, 200, 0);
      const spiral = lines[lines.length - 1];
      for (const p of spiral) {
        expect(p.x).toBeGreaterThanOrEqual(-1e-9);
        expect(p.x).toBeLessThanOrEqual(320 + 1e-9);
        expect(p.y).toBeGreaterThanOrEqual(-1e-9);
        expect(p.y).toBeLessThanOrEqual(200 + 1e-9);
      }
      for (let i = 1; i < spiral.length; i++) expect(Math.hypot(spiral[i].x - spiral[i - 1].x, spiral[i].y - spiral[i - 1].y)).toBeLessThan(25);
    }
  });

  it("draw the triangle's perpendiculars at right angles to its diagonal", () => {
    const [[a, b], [c, foot]] = overlayLines("triangle", 0, 300, 200, 0);
    expect((b.x - a.x) * (foot.x - c.x) + (b.y - a.y) * (foot.y - c.y)).toBeCloseTo(0, 6);
  });
});

describe("ratio presets", () => {
  it("set the largest box of the ratio on the canvas, upright or turned", () => {
    expect(largestBox(400, 300, 1)).toEqual({ cx: 200, cy: 150, w: 300, h: 300, angle: 0 });
    const turned = largestBox(400, 300, 2, 0.2);
    expect(turned.w / turned.h).toBeCloseTo(2, 9);
    expect(Math.min(...boxCorners(turned).flatMap((c) => [c.x, c.y, 400 - c.x, 300 - c.y]))).toBeCloseTo(0, 9);
  });
});
