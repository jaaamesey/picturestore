import { describe, expect, it } from "vitest";
import { FIT_PRESETS, fitTo, formatSize, fromPixels, initialState, setDimension, previewView, setResample, setResolutionValue, toPixels } from "./imageSize";

const o = { width: 2000, height: 1000, resolution: 300 };

describe("Image Size logic", () => {
  it("converts units through the resolution", () => {
    expect(toPixels(2, "inches", 300, 0)).toBe(600);
    expect(toPixels(2.54, "centimeters", 100, 0)).toBeCloseTo(100);
    expect(toPixels(50, "percent", 300, 2000)).toBe(1000);
    expect(fromPixels(600, "points", 300, 0)).toBeCloseTo(144);
  });

  it("keeps proportions when constrained, from the original aspect", () => {
    const s = setDimension(initialState(o), "width", 50, "percent", o);
    expect([s.width, s.height]).toEqual([1000, 500]);
    const free = setDimension({ ...initialState(o), constrain: false }, "height", 3, "inches", o);
    expect([free.width, free.height]).toEqual([2000, 900]);
  });

  it("with Resample, changing the resolution keeps the physical size", () => {
    const s = setResolutionValue(initialState(o), 150);
    expect([s.width, s.height, s.resolution]).toEqual([1000, 500, 150]);
  });

  it("without Resample, pixels are fixed and physical size sets the resolution", () => {
    const s = setResample(setDimension(initialState(o), "width", 1000, "pixels", o), false, o);
    expect([s.width, s.height, s.resolution]).toEqual([2000, 1000, 300]);
    const bigger = setDimension(s, "width", 10, "inches", o);
    expect([bigger.width, bigger.height, bigger.resolution]).toEqual([2000, 1000, 200]);
    // Pixel units don't apply.
    expect(setDimension(s, "width", 10, "pixels", o)).toBe(s);
  });

  it("fits presets to the image's orientation at their resolution", () => {
    const four = fitTo(initialState(o), FIT_PRESETS[0], o); // 4 × 6 in: turned to 6 × 4 for a landscape image
    expect([four.width, four.height, four.resolution]).toEqual([1800, 900, 300]);
    const px = fitTo(initialState(o), FIT_PRESETS.find((p) => p.label.startsWith("800"))!, o);
    expect([px.width, px.height, px.resolution]).toEqual([800, 400, 72]);
  });

  it("reads out sizes like Photoshop", () => {
    expect(formatSize(1280, 720)).toBe("2.64M");
    expect(formatSize(400, 300)).toBe("351.6K");
  });
});

describe("Image Size preview view", () => {
  it("fits the whole image without stretching, rendering no more pixels than the screen has", () => {
    const v = previewView(4000, 2000, 240, 240, 2, 1, { x: 0.5, y: 0.5 });
    expect(v.window).toEqual({ x: 0, y: 0, w: 4000, h: 2000 });
    expect(v.css).toEqual({ x: 0, y: 60, w: 240, h: 120 });
    expect(v.scale).toBeCloseTo(0.12); // 480 device px across 4000 image px
    expect(v.pannable).toBe(false);
  });

  it("zooms relative to the fit, pans within the image, and stops at the image's own pixels", () => {
    const v = previewView(4000, 2000, 240, 240, 2, 4, { x: 0.9, y: 0.5 });
    expect(v.window.w).toBe(1000);
    expect(v.window.x + v.window.w).toBeLessThanOrEqual(4000);
    expect(v.window.x).toBe(3000); // clamped at the right edge
    expect(v.pannable).toBe(true);
    const close = previewView(200, 100, 240, 240, 2, 8, { x: 0.5, y: 0.5 });
    expect(close.scale).toBe(1);
  });
});
