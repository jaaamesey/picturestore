import { describe, expect, it } from "vitest";
import { BLEND_MODES, KERNELS, blendColor } from "./blend";

describe("blend modes", () => {
  it.each([
    ["multiply", 0.5, 0.5, 0.25],
    ["screen", 0.5, 0.5, 0.75],
    ["darken", 0.2, 0.6, 0.2],
    ["lighten", 0.2, 0.6, 0.6],
    ["difference", 0.2, 0.6, 0.4],
    ["exclusion", 0.5, 0.5, 0.5],
    ["linear burn", 0.4, 0.4, 0],
    ["linear dodge", 0.4, 0.4, 0.8],
    ["subtract", 0.6, 0.4, 0.2],
    ["divide", 0.25, 0.5, 0.5],
    ["overlay", 0.25, 1, 0.5],
    ["hard light", 1, 0.25, 0.5],
    ["color dodge", 0.25, 0.5, 0.5],
    ["color burn", 0.75, 0.5, 0.5],
    ["soft light", 0.5, 0.5, 0.5],
  ] as const)("%s(b=%f, s=%f) = %f", (mode, b, s, expected) => {
    expect(blendColor(mode, [b, b, b], [s, s, s])[0]).toBeCloseTo(expected, 6);
  });

  it("luminosity keeps the backdrop's hue but takes the source's luminance", () => {
    const [r, g, b] = blendColor("luminosity", [1, 0, 0], [0.5, 0.5, 0.5]);
    expect(0.3 * r + 0.59 * g + 0.11 * b).toBeCloseTo(0.5, 6);
    expect(r).toBeGreaterThan(g);
  });

  it("every mode reduces to the source over a transparent backdrop", () => {
    for (const mode of BLEND_MODES) {
      const dst = new Float32Array(4);
      KERNELS[mode](dst, 0, new Uint8ClampedArray([51, 102, 153, 255]), 0, 1, 0.5);
      expect([...dst].map((v) => +v.toFixed(6))).toEqual([0.1, 0.2, 0.3, 0.5]);
    }
  });

  it("normal source-over with partial alpha (premultiplied destination)", () => {
    const dst = new Float32Array([1, 1, 1, 1]);
    KERNELS.normal(dst, 0, new Uint8ClampedArray([0, 0, 0, 255]), 0, 1, 0.25);
    expect([...dst]).toEqual([0.75, 0.75, 0.75, 1]);
  });

  it("kernels match blendColor for every mode over an opaque backdrop", () => {
    for (const mode of BLEND_MODES) {
      const dst = new Float32Array([0.2, 0.5, 0.8, 1]);
      KERNELS[mode](dst, 0, new Uint8ClampedArray([204, 102, 51, 255]), 0, 1, 1);
      const expected = blendColor(mode, [0.2, 0.5, 0.8], [0.8, 0.4, 0.2]);
      expected.forEach((v, i) => expect(dst[i]).toBeCloseTo(v, 5));
    }
  });
});
