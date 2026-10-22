import { readPsd, writePsd } from "ag-psd";
import { beforeAll, describe, expect, it } from "vitest";
import { addLayer, createDocument, createGroup, createLayer, docRect, type Doc } from "../core/document";
import { renderDrawing } from "../core/shape";
import { walk } from "../core/layers";
import { drawText, useFontLibrary } from "../text/engine";
import { DEFAULT_CHAR_STYLE, DEFAULT_PARAGRAPH_STYLE, setCharStyle, setParagraphStyle, textContent, type TextContent } from "../text/model";
import { testLibrary } from "../text/testFonts";
import { readPsdDocument, writePsdDocument } from "./psd";
import { fontFromName } from "./psdText";

beforeAll(() => useFontLibrary(testLibrary()));

/** A document with type: point type with styled runs, and warped paragraph type in a group. */
function typeDoc(): { doc: Doc; point: TextContent; box: TextContent } {
  let point = textContent("Hello\nworld", { ...DEFAULT_CHAR_STYLE, size: 30 }, DEFAULT_PARAGRAPH_STYLE, { kind: "point" }, [1, 0, 0, 1, 20, 60]);
  point = setCharStyle(point, { start: 0, end: 5 }, { fauxBold: true, color: { r: 200, g: 10, b: 30 }, kerning: "optical", ordinals: true, variations: { wght: 640 } });
  point = setParagraphStyle(point, { start: 6, end: 11 }, { align: "center", indentFirst: 12 });
  let box = textContent("سلام and words that wrap", { ...DEFAULT_CHAR_STYLE, size: 18 }, { ...DEFAULT_PARAGRAPH_STYLE, direction: "rtl", align: "justify-left" }, { kind: "box", width: 160, height: 90 }, [0.9, 0.2, -0.2, 0.9, 120, 40]);
  box = { ...box, warp: { style: "flag", orientation: "horizontal", bend: 0.3, horizontalDistortion: -0.1, verticalDistortion: 0.05 }, antiAlias: "crisp" };
  let doc = createDocument({ width: 300, height: 200, background: { r: 255, g: 255, b: 255 } });
  const layer = (name: string, content: TextContent) => createLayer({ name, content, pixels: renderDrawing(drawText(content), docRect(doc)) });
  doc = addLayer(doc, layer("Hello", point));
  doc = addLayer(doc, createGroup("Group", [layer("Arabic", box)]));
  return { doc, point, box };
}

const texts = (d: Doc) => [...walk(d.layers)].flatMap((l) => (l.content.kind === "text" ? [l.content] : []));

describe("type in PSD", () => {
  it("round-trips exactly through our own files, every attribute kept", async () => {
    const { doc, point, box } = typeDoc();
    const back = texts(await readPsdDocument(writePsdDocument(doc)));
    expect(back).toEqual([
      { ...point, stale: false },
      { ...box, stale: false },
    ]);
  });

  it("writes Photoshop's type data: text, runs, paragraphs, frame, warp, transform", () => {
    const { doc } = typeDoc();
    const psd = readPsd(writePsdDocument(doc), { useImageData: true, skipThumbnail: true });
    const hello = psd.children![1].text!;
    expect(hello.text).toBe("Hello\nworld");
    expect(hello.shapeType).toBe("point");
    expect(hello.transform).toEqual([1, 0, 0, 1, 20, 60]);
    // (Values every run shares are kept once, as the default style.)
    expect(hello.styleRuns![0].length).toBe(5);
    expect({ ...hello.style, ...hello.styleRuns![0].style }).toMatchObject({ fontSize: 30, fauxBold: true, font: { name: "SourceSans3-Regular" } });
    expect(hello.paragraphStyleRuns!.map((r) => r.style.justification)).toEqual(["left", "center"]);
    const arabic = psd.children![2].children![0].text!;
    expect(arabic.shapeType).toBe("box");
    expect(arabic.boxBounds).toEqual([0, 0, 160, 90]);
    expect(arabic.warp).toMatchObject({ style: "flag", value: 30, rotate: "horizontal" });
    expect(arabic.antiAlias).toBe("crisp");
  });

  it("type edited elsewhere is read from Photoshop's data, and shown as Photoshop drew it until it's edited", async () => {
    const { doc, box } = typeDoc();
    const psd = readPsd(writePsdDocument(doc), { useImageData: true, skipThumbnail: true });
    // As if edited in Photoshop: the text changed, so what we wrote no longer applies.
    const t = psd.children![2].children![0].text!;
    t.text = "Changed text";
    t.style = { ...t.style, fontSize: 24, underline: true };
    delete t.styleRuns;
    const back = texts(await readPsdDocument(writePsd(psd, { noBackground: true })));
    expect(back[0].stale).toBe(false);
    const changed = back[1];
    expect(changed).toMatchObject({ text: "Changed text", stale: true, frame: { kind: "box", width: 160, height: 90 }, antiAlias: "crisp", warp: box.warp });
    expect(changed.runs).toHaveLength(1);
    expect(changed.runs[0].style).toMatchObject({ size: 24, underline: true });
    changed.transform.forEach((v, i) => expect(v).toBeCloseTo(box.transform[i], 5));
    expect(changed.paragraphs[0].style.align).toBe("justify-left");
  });

  it("keeps type on a path and inside a shape exactly; Photoshop sees them as point and paragraph type", async () => {
    const circle = [
      { anchor: { x: 150, y: 40 }, in: { x: 105, y: 40 }, out: { x: 195, y: 40 } },
      { anchor: { x: 230, y: 100 }, in: { x: 230, y: 65 }, out: { x: 230, y: 135 } },
      { anchor: { x: 150, y: 160 }, in: { x: 195, y: 160 }, out: { x: 105, y: 160 } },
      { anchor: { x: 70, y: 100 }, in: { x: 70, y: 135 }, out: { x: 70, y: 65 } },
    ];
    const style = { ...DEFAULT_CHAR_STYLE, size: 14 };
    const along = textContent("Along", style, DEFAULT_PARAGRAPH_STYLE, { kind: "path", knots: circle, closed: true, start: 60, flipped: false }, [1, 0, 0, 1, 0, 0]);
    const inside = textContent("Inside the circle", style, DEFAULT_PARAGRAPH_STYLE, { kind: "area", contours: [circle] }, [1, 0, 0, 1, 0, 0]);
    let doc = createDocument({ width: 300, height: 200, background: { r: 255, g: 255, b: 255 } });
    for (const c of [along, inside]) doc = addLayer(doc, createLayer({ name: c.text, content: c, pixels: renderDrawing(drawText(c), docRect(doc)) }));
    const bytes = writePsdDocument(doc);
    expect(texts(await readPsdDocument(bytes))).toEqual([
      { ...along, stale: false },
      { ...inside, stale: false },
    ]);
    const psd = readPsd(bytes, { useImageData: true, skipThumbnail: true });
    expect(psd.children![1].text!.shapeType).toBe("point");
    expect(psd.children![2].text).toMatchObject({ shapeType: "box", boxBounds: [70, 40, 230, 160] });
  });

  it("guesses a font's family and style from its PostScript name", () => {
    expect(fontFromName("MyriadPro-BoldIt")).toEqual({ postScriptName: "MyriadPro-BoldIt", family: "Myriad Pro", style: "Bold Italic" });
    expect(fontFromName("Arial")).toEqual({ postScriptName: "Arial", family: "Arial", style: "Regular" });
  });
});
