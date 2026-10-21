import { describe, expect, it } from "vitest";
import { FIT_PRESETS, fitTo, formatSize, fromPixels, initialState, setDimension, setResample, setResolutionValue, toPixels } from "./imageSize";

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
