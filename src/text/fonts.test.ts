import { describe, expect, it } from "vitest";
import { fontFormat, sfntOf } from "./fonts";
import { DEFAULT_FONT } from "./model";
import { testLibrary } from "./testFonts";

describe("fonts", () => {
  const lib = testLibrary();

  it("lists the bundled families with Adobe's style and PostScript names", () => {
    const fams = lib.families().map((f) => f.family);
    expect(fams).toEqual(["Noto Sans Arabic", "Source Code Pro", "Source Sans 3", "Source Serif 4"]);
    expect(lib.families().find((f) => f.family === "Noto Sans Arabic")!.fonts.map((f) => f.ref.postScriptName)).toEqual(["NotoSansArabic-Regular", "NotoSansArabic-Bold"]);
    const sans = lib.families().find((f) => f.family === "Source Sans 3")!.fonts.map((f) => f.ref.style);
    expect(sans).toContain("Regular");
    expect(sans).toContain("Bold Italic");
    expect(lib.find({ postScriptName: "SourceSans3-BoldIt", family: "", style: "" })?.ref.style).toBe("Bold Italic");
    expect(lib.find({ postScriptName: "SourceSans3-It", family: "", style: "" })?.ref.style).toBe("Italic");
    // The variable font's own names find the same instances.
    expect(lib.find({ postScriptName: "SourceSans3VF-Semibold", family: "", style: "" })?.ref.postScriptName).toBe("SourceSans3-Semibold");
    expect(lib.resolve(DEFAULT_FONT)).not.toBeNull();
  });

  it("shapes with kerning and ligatures, and gives metrics and outlines in ems", () => {
    const face = lib.resolve(DEFAULT_FONT)!;
    const kerned = face.shape("AV", 0, 2, { features: [], direction: "ltr" });
    const plain = face.shape("AV", 0, 2, { features: ["kern=0"], direction: "ltr" });
    expect(kerned.xAdvance[0]).toBeLessThan(plain.xAdvance[0]);
    const lig = face.shape("office", 0, 6, { features: [], direction: "ltr" });
    expect(lig.glyphs.length).toBe(5); // "ffi" is one glyph
    expect(face.shape("office", 0, 6, { features: ["liga=0"], direction: "ltr" }).glyphs.length).toBe(6);
    const m = face.metrics();
    expect(m.capHeight).toBeCloseTo(0.66, 2);
    const o = face.outline(face.glyphFor(0x4f)!); // "O": two contours
    expect(o.length).toBe(2);
    // The weight axis widens glyphs.
    expect(face.advance(face.glyphFor(0x6e)!, { wght: 900 })).toBeGreaterThan(face.advance(face.glyphFor(0x6e)!));
  });

  it("reads WOFF", async () => {
    const { readFileSync } = await import("node:fs");
    const woff = new Uint8Array(readFileSync(new URL(import.meta.resolve("source-sans/WOFF/TTF/SourceSans3-Regular.ttf.woff"))));
    expect(fontFormat(woff)).toBe("woff");
    const sfnt = await sfntOf(woff);
    expect(fontFormat(sfnt)).toBe("ttf");
    const lib2 = testLibrary();
    const [info] = lib2.add({ id: "w", bytes: sfnt, origin: "uploaded" });
    expect(info.ref.postScriptName).toBe("SourceSans3-Regular");
    expect(lib2.face(info).shape("Hi", 0, 2, { features: [], direction: "ltr" }).glyphs.length).toBe(2);
  });
});
