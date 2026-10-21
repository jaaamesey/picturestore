import { expect, it } from "vitest";
import { addLayer, createDocument, createLayer, fillTiles, flatten } from "../core/document";
import { smartSource } from "../core/content";
import { rect } from "../core/geometry";
import { EMPTY_TILES, type Tile } from "../core/tiles";
import { quadOf } from "../core/warp";
import { fromWire, toWire } from "./wire";

it("round-trips documents with each tile sent once, by id", () => {
  const base = createDocument({ width: 300, height: 200 });
  const tiles = fillTiles(EMPTY_TILES, rect(0, 0, 300, 200), { r: 9, g: 8, b: 7 });
  const src = smartSource("s", 300, 200, tiles);
  const placement = { source: rect(0, 0, 300, 200), quad: quadOf(rect(0, 0, 300, 200)), angle: 0, patch: null };
  // The smart object shares its tiles with the pixel layer: they're sent once.
  const doc = addLayer(addLayer(base, createLayer({ name: "px", tiles })), createLayer({ name: "so", tiles, content: { kind: "smart", source: src, placement } }));
  const ids = new Map<Tile, number>();
  const wire = toWire(doc, (t) => (ids.has(t) ? ids.get(t)! : (ids.set(t, ids.size), ids.size - 1)));
  expect(ids.size).toBe(new Set([...base.layers[0].tiles.values(), ...tiles.values()]).size);
  const byId = new Map([...ids].map(([t, id]) => [id, t]));
  const back = fromWire(structuredClone(wire), (id) => byId.get(id)!);
  expect(flatten(back)).toEqual(flatten(doc));
  expect(back.layers[2].content.kind).toBe("smart");
});
