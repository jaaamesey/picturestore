import { readFileSync } from "node:fs";
import { BUNDLED_FONTS } from "./bundled";
import { FontLibrary, loadHarfBuzz } from "./fonts";

await loadHarfBuzz();

/** A library with the bundled fonts, read from node_modules (unit tests). */
export function testLibrary(): FontLibrary {
  const lib = new FontLibrary();
  for (const b of BUNDLED_FONTS) lib.add({ id: b.id, bytes: new Uint8Array(readFileSync(new URL(import.meta.resolve(b.path)))), origin: "bundled", family: b.family, psPrefix: b.psPrefix });
  return lib;
}
