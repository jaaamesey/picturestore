import type { VectorDrawing } from "../core/shape";
import { FontLibrary } from "./fonts";
import { layoutText, type TextLayout } from "./layout";
import type { TextContent } from "./model";
import { textDrawing } from "./render";

/**
 * The fonts type is set in, and type laid out and drawn from them. Layouts
 * and drawings are cached per (immutable) content and refreshed when fonts
 * or hyphenation patterns change.
 */

let library = new FontLibrary();
let version = 0;
let glyphProtection = true;
const listeners = new Set<() => void>();
library.onChange(() => invalidateText());

export const fontLibrary = () => library;

/** Replaces the library (tests: one with the bundled fonts from disk). */
export function useFontLibrary(lib: FontLibrary) {
  library = lib;
  invalidateText();
  lib.onChange(() => invalidateText());
}

/** Fonts or patterns changed: every layout may differ. */
export function invalidateText() {
  version++;
  for (const l of listeners) l();
}

export function onTextInvalidated(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const textVersion = () => version;

/** Preferences ▸ Type ▸ Enable Missing Glyph Protection. */
export function setGlyphProtection(on: boolean) {
  if (on === glyphProtection) return;
  glyphProtection = on;
  invalidateText();
}

const layouts = new WeakMap<TextContent, { version: number; layout: TextLayout; drawing?: VectorDrawing }>();

function entry(c: TextContent) {
  let e = layouts.get(c);
  if (!e || e.version !== version) layouts.set(c, (e = { version, layout: layoutText(c, { fonts: library, glyphProtection }) }));
  return e;
}

export const textLayout = (c: TextContent): TextLayout => entry(c).layout;

export function drawText(c: TextContent): VectorDrawing {
  const e = entry(c);
  return (e.drawing ??= textDrawing(c, e.layout));
}
