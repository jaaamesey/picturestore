import { expect, it } from "vitest";
import { createDocument, updateLayer } from "./document";
import { amend, canRedo, createHistory, currentDoc, dropOne, historyBytes, jump, limitSteps, push, redo, retainedBytes, undo } from "./history";
import { fillTiles } from "./document";
import { rect } from "./geometry";

const d0 = createDocument({ width: 4, height: 4 });
const id = d0.layers[0].id;
const named = (n: string) => updateLayer(d0, id, { name: n });

it("undoes, redoes and truncates the redo branch", () => {
  let h = push(push(createHistory(d0), "a", named("a")), "b", named("b"));
  h = undo(h);
  expect(currentDoc(h).layers[0].name).toBe("a");
  expect(canRedo(h)).toBe(true);
  h = redo(h);
  expect(currentDoc(h).layers[0].name).toBe("b");
  h = push(undo(undo(h)), "c", named("c"));
  expect(h.entries.map((e) => e.label)).toEqual(["Open", "c"]);
  expect(canRedo(h)).toBe(false);
});

it("caps its length", () => {
  let h = createHistory(d0);
  for (let i = 0; i < 10; i++) h = push(h, `${i}`, named(`${i}`), { steps: 3, bytes: Infinity });
  expect(h.entries.map((e) => e.label)).toEqual(["7", "8", "9"]);
  expect(h.index).toBe(2);
});

it("jumps", () => {
  const h = push(createHistory(d0), "a", named("a"));
  expect(jump(h, 0).index).toBe(0);
  expect(jump(h, 7)).toBe(h);
});

it("shares unchanged tiles between snapshots", () => {
  const h = push(createHistory(d0), "rename", named("x"));
  expect(h.entries[1].doc.layers[0].tiles).toBe(h.entries[0].doc.layers[0].tiles);
});

it("amends the current entry, dropping redo", () => {
  const h = amend(push(push(createHistory(d0), "a", named("a")), "b", named("b")), "b2", named("b2"));
  expect(h.entries.map((e) => e.label)).toEqual(["Open", "a", "b2"]);
  expect(amend(undo(h), "a2", named("a2")).entries.map((e) => e.label)).toEqual(["Open", "a2"]);
});

const TILE = 256 * 256 * 4;
const painted = (d: typeof d0, x: number) =>
  updateLayer(d, id, { tiles: fillTiles(d.layers[0].tiles, rect(x, 0, 1, 1), { r: x % 255, g: 0, b: 0 }) });

it("counts only the bytes each step newly retains", () => {
  const big = createDocument({ width: 1024, height: 256 }); // 4 tiles
  expect(retainedBytes(big, null)).toBe(4 * TILE);
  const id0 = big.layers[0].id;
  const one = updateLayer(big, id0, { tiles: fillTiles(big.layers[0].tiles, rect(0, 0, 1, 1), { r: 1, g: 2, b: 3 }) });
  expect(retainedBytes(one, big)).toBe(TILE); // one tile copied, three shared
  expect(retainedBytes(updateLayer(one, id0, { name: "x" }), one)).toBe(0);
});

it("trims the oldest states to stay within a memory budget", () => {
  let h = createHistory(d0);
  let d = d0;
  for (let i = 0; i < 10; i++) {
    d = painted(d, i);
    h = push(h, `paint ${i}`, d, { steps: 50, bytes: 4 * TILE });
  }
  expect(historyBytes(h)).toBeLessThanOrEqual(4 * TILE + TILE);
  expect(h.entries.length).toBeGreaterThanOrEqual(2);
  expect(h.entries[h.entries.length - 1].label).toBe("paint 9");
  expect(currentDoc(h)).toBe(d);
});

it("always keeps at least one undoable step, however large", () => {
  let h = createHistory(d0);
  for (let i = 0; i < 5; i++) h = push(h, `${i}`, painted(currentDoc(h), i), { steps: 50, bytes: 0 });
  expect(h.entries.length).toBe(2);
  expect(h.index).toBe(1);
});

it("frees memory a state at a time without ever dropping the current state", () => {
  let h = push(push(push(createHistory(d0), "a", named("a")), "b", named("b")), "c", named("c"));
  h = undo(undo(h)); // at "a", with "b" and "c" to redo
  h = dropOne(h)!;
  expect(h.entries.map((e) => e.label)).toEqual(["a", "b", "c"]);
  expect(currentDoc(h).layers[0].name).toBe("a");
  // The new oldest state accounts for everything it holds.
  expect(h.entries[0].bytes).toBe(retainedBytes(h.entries[0].doc, null));
  h = dropOne(dropOne(h)!)!;
  expect(h.entries.map((e) => e.label)).toEqual(["a"]);
  expect(dropOne(h)).toBeNull();
});

it("applies a lowered step limit, never past the current state", () => {
  let h = createHistory(d0);
  for (let i = 0; i < 10; i++) h = push(h, `${i}`, named(`${i}`));
  expect(limitSteps(h, 4).entries.map((e) => e.label)).toEqual(["6", "7", "8", "9"]);
  const back = jump(h, 2);
  const limited = limitSteps(back, 4);
  expect(currentDoc(limited)).toBe(currentDoc(back));
});
