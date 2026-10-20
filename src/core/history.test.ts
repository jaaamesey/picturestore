import { expect, it } from "vitest";
import { createDocument, updateLayer } from "./document";
import { amend, canRedo, createHistory, currentDoc, jump, push, redo, undo } from "./history";

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
  for (let i = 0; i < 10; i++) h = push(h, `${i}`, named(`${i}`), 3);
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
