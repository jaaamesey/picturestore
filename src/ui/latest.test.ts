import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLatest } from "./latest";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it("runs the first request at once, then only the latest, at most every interval, never overlapping", async () => {
  const runs: number[] = [];
  const delivered: number[] = [];
  let active = 0, maxActive = 0;
  const l = createLatest(
    async (n: number) => {
      active++;
      maxActive = Math.max(maxActive, active);
      runs.push(n);
      await new Promise((r) => setTimeout(r, 50));
      active--;
      return n;
    },
    (n) => delivered.push(n),
    200,
  );
  l.request(1);
  for (let n = 2; n <= 10; n++) {
    await vi.advanceTimersByTimeAsync(20);
    l.request(n);
  }
  await vi.advanceTimersByTimeAsync(1000);
  expect(runs).toEqual([1, 10]);
  expect(delivered).toEqual([1, 10]);
  expect(maxActive).toBe(1);
});

it("delivers in order and ends on the latest, and nothing after disposal", async () => {
  const delivered: number[] = [];
  const l = createLatest(async (n: number) => {
    await new Promise((r) => setTimeout(r, 100));
    return n;
  }, (n) => delivered.push(n), 0);
  l.request(1);
  await vi.advanceTimersByTimeAsync(10);
  l.request(2);
  await vi.advanceTimersByTimeAsync(500);
  expect(delivered).toEqual([1, 2]);
  l.request(3);
  l.dispose();
  await vi.advanceTimersByTimeAsync(500);
  expect(delivered).toEqual([1, 2]);
});
