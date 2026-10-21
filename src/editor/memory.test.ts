import { expect, it } from "vitest";
import { isOutOfMemory } from "./editor";

it("recognises engines' allocation failures, and nothing else", () => {
  expect(isOutOfMemory(new RangeError("Array buffer allocation failed"))).toBe(true);
  expect(isOutOfMemory(new RangeError("Invalid typed array length: 4294967296"))).toBe(true);
  expect(isOutOfMemory(new RangeError("Maximum call stack size exceeded"))).toBe(false);
  expect(isOutOfMemory(new Error("Array buffer allocation failed"))).toBe(false);
});
