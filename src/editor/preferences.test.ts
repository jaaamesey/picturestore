import { expect, it } from "vitest";
import { defaultPreferences, memoryUsageRange, normalizePreferences } from "./preferences";

it("falls back to defaults for missing or malformed values", () => {
  expect(normalizePreferences(null)).toEqual(defaultPreferences());
  expect(normalizePreferences({ historyStates: "lots", recoveryMinutes: 7 })).toEqual(defaultPreferences());
});

it("clamps to Photoshop's ranges", () => {
  const p = normalizePreferences({ historyStates: 5000, memoryUsageMB: 1, recoveryMinutes: 0 });
  expect(p.historyStates).toBe(1000);
  expect(p.memoryUsageMB).toBe(memoryUsageRange().min);
  expect(p.recoveryMinutes).toBe(0);
  expect(normalizePreferences({ historyStates: 0 }).historyStates).toBe(1);
  expect(normalizePreferences({ historyStates: 12.4 }).historyStates).toBe(12);
});

it("validates guide and grid settings, and sizes the grid in pixels", async () => {
  const { gridSpacing } = await import("./preferences");
  const p = normalizePreferences({ guideColor: "#ABCDEF", gridColor: "red", gridUnit: "furlongs", gridSubdivisions: 0 });
  expect(p.guideColor).toBe("#abcdef");
  expect(p.gridColor).toBe(defaultPreferences().gridColor);
  expect(p.gridUnit).toBe("millimeters");
  expect(p.gridSubdivisions).toBe(1);
  // 25 mm at 254 ppi is 250 px; four subdivisions.
  expect(gridSpacing(defaultPreferences(), 1000, 800, 254)).toEqual({ major: { x: 250, y: 250 }, minor: { x: 62.5, y: 62.5 } });
  expect(gridSpacing({ gridEvery: 10, gridUnit: "percent", gridSubdivisions: 2 }, 1000, 800, 72).minor).toEqual({ x: 50, y: 40 });
});
