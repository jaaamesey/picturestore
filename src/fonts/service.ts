import sans from "source-sans/VF/SourceSans3VF-Upright.ttf?url";
import sansItalic from "source-sans/VF/SourceSans3VF-Italic.ttf?url";
import serif from "source-serif/VAR/SourceSerif4Variable-Roman.ttf?url";
import serifItalic from "source-serif/VAR/SourceSerif4Variable-Italic.ttf?url";
import code from "source-code-pro/VF/SourceCodeVF-Upright.ttf?url";
import codeItalic from "source-code-pro/VF/SourceCodeVF-Italic.ttf?url";
import { loadHyphenation } from "../text/breaks";
import { BUNDLED_FONTS } from "../text/bundled";
import { fontLibrary, invalidateText } from "../text/engine";
import { fontFormat, fontsIn, loadHarfBuzz, sfntOf, weightOf, type FontEntry, type FontFile, type FontInfo, type PendingFont } from "../text/fonts";
import { deleteStoredFont, storeFont, storedFonts } from "./store";

/**
 * The app's fonts: the bundled families, fonts the user has added (kept in
 * IndexedDB), and, when allowed, the fonts installed on this device
 * (through the browser's Local Font Access API; each loads when it's first
 * used). Every font is also registered with the browser, so menus can show
 * each name in its own font.
 */

const URLS: Record<string, string> = {
  "bundled:source-sans-3": sans,
  "bundled:source-sans-3-italic": sansItalic,
  "bundled:source-serif-4": serif,
  "bundled:source-serif-4-italic": serifItalic,
  "bundled:source-code-pro": code,
  "bundled:source-code-pro-italic": codeItalic,
};

let ready: Promise<void> | null = null;

/** Loads HarfBuzz, the bundled fonts and the stored ones (once). */
export function initFonts(): Promise<void> {
  return (ready ??= (async () => {
    await loadHarfBuzz();
    const bundled = await Promise.all(
      BUNDLED_FONTS.map(async (b): Promise<FontFile> => ({
        id: b.id,
        bytes: new Uint8Array(await (await fetch(URLS[b.id])).arrayBuffer()),
        origin: "bundled",
        family: b.family,
        psPrefix: b.psPrefix,
      })),
    );
    for (const f of bundled) add(f);
    for (const s of await storedFonts()) {
      try {
        add({ id: s.id, bytes: s.bytes, origin: "uploaded" });
      } catch (err) {
        console.warn(`Stored font ${s.name} couldn't be read:`, err);
      }
    }
    void loadHyphenation("en-US").then(invalidateText);
  })());
}

const cssNames = new Map<string, string>();

function add(file: FontFile): FontInfo[] {
  const fonts = fontLibrary().add(file);
  registerCss(file);
  return fonts;
}

/** Registers a file with the browser for previews (one face per file; instances by their axis values). */
function registerCss(file: FontFile) {
  if (typeof FontFace === "undefined" || typeof document === "undefined") return;
  const name = `ps-font-${cssNames.size}`;
  cssNames.set(file.id, name);
  const face = new FontFace(name, file.bytes as Uint8Array<ArrayBuffer>);
  document.fonts.add(face);
  void face.load().catch(() => {});
}

/** CSS that draws text in a font, for menus and previews. */
export function cssFont(f: FontEntry): Record<string, string> {
  const info = f as Partial<FontInfo>;
  const name = info.fileId && cssNames.get(info.fileId);
  if (!name) return { "font-family": `"${f.ref.family}", sans-serif`, "font-weight": String(f.weight), "font-style": f.italic ? "italic" : "normal" };
  const coords = Object.entries(info.coords ?? {});
  return { "font-family": `"${name}", sans-serif`, ...(coords.length && { "font-variation-settings": coords.map(([t, v]) => `"${t}" ${v}`).join(", ") }) };
}

/** The result of adding fonts: what's in, and what couldn't be read. */
export interface AddedFonts {
  readonly fonts: readonly FontInfo[];
  readonly errors: readonly string[];
}

/** Adds font files (TrueType, OpenType, collections, WOFF) and keeps them for next time. */
export async function uploadFonts(files: readonly File[]): Promise<AddedFonts> {
  await initFonts();
  const fonts: FontInfo[] = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      const raw = new Uint8Array(await f.arrayBuffer());
      if (!fontFormat(raw)) throw new Error("It isn't a TrueType, OpenType or WOFF font.");
      const bytes = await sfntOf(raw);
      const id = `uploaded:${crypto.randomUUID()}`;
      // Read it before keeping it: a broken file never reaches storage.
      if (!fontsIn({ id, bytes, origin: "uploaded" }).length) throw new Error("It has no fonts in it.");
      fonts.push(...add({ id, bytes, origin: "uploaded" }));
      await storeFont({ id, name: f.name, bytes, added: Date.now() });
    } catch (err) {
      errors.push(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { fonts, errors };
}

/** Removes an uploaded font file. */
export async function removeFont(fileId: string): Promise<void> {
  fontLibrary().remove(fileId);
  await deleteStoredFont(fileId);
}

interface LocalFontData {
  readonly postscriptName: string;
  readonly fullName: string;
  readonly family: string;
  readonly style: string;
  blob(): Promise<Blob>;
}

export const localFontsSupported = () => typeof window !== "undefined" && "queryLocalFonts" in window;

/**
 * Lists the fonts installed on this device (the browser asks permission).
 * They're added by name and load when first used. Returns how many.
 */
export async function useLocalFonts(): Promise<number> {
  await initFonts();
  const query = (window as unknown as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts;
  if (!query) throw new Error("This browser can't list installed fonts.");
  const list = await query();
  const pending: PendingFont[] = list.map((d) => ({
    ref: { postScriptName: d.postscriptName, family: d.family, style: d.style },
    origin: "local",
    weight: weightOf(d.style),
    italic: /italic|oblique/i.test(d.style),
    load: async () => {
      const bytes = await sfntOf(new Uint8Array(await (await d.blob()).arrayBuffer()));
      return { id: `local:${d.postscriptName}`, bytes, origin: "local" };
    },
  }));
  fontLibrary().addPending(pending);
  return pending.length;
}
