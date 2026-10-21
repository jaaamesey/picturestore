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
