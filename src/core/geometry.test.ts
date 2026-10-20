import { describe, expect, it } from "vitest";
import {
  apply, compose, integerTranslation, intersect, invert, multiply, rect, rectFromPoints, rotation, roundOut,
  scaling, transformRect, translation, union, vec, IDENTITY,
} from "./geometry";

const close = (a: readonly number[], b: readonly number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));

describe("rects", () => {
  it("intersects and unions", () => {
    expect(intersect(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toEqual(rect(5, 5, 5, 5));
    expect(intersect(rect(0, 0, 10, 10), rect(20, 20, 1, 1)).w).toBe(0);
    expect(union(rect(0, 0, 1, 1), rect(4, 4, 1, 1))).toEqual(rect(0, 0, 5, 5));
    expect(union(rect(0, 0, 0, 0), rect(4, 4, 1, 1))).toEqual(rect(4, 4, 1, 1));
  });
  it("normalises corner points and rounds outward", () => {
    expect(rectFromPoints(vec(10, 2), vec(4, 8))).toEqual(rect(4, 2, 6, 6));
    expect(roundOut(rect(0.5, 1.2, 2, 2))).toEqual(rect(0, 1, 3, 3));
  });
});

describe("matrices", () => {
  it("composes in application order", () => {
    const m = compose(translation(10, 0), scaling(2));
    expect(apply(m, vec(1, 1))).toEqual(vec(22, 2));
  });
  it("inverts", () => {
    const m = compose(scaling(2, 3), rotation(0.7), translation(5, -4));
    close(multiply(m, invert(m)), IDENTITY);
  });
  it("detects integer translations", () => {
    expect(integerTranslation(translation(3, -2))).toEqual(vec(3, -2));
    expect(integerTranslation(translation(3.5, 0))).toBeNull();
    expect(integerTranslation(rotation(0.1))).toBeNull();
  });
  it("bounds transformed rects", () => {
    const r = transformRect(rotation(Math.PI / 2), rect(0, 0, 10, 4));
    close([r.x, r.y, r.w, r.h], [-4, 0, 4, 10]);
  });
});
