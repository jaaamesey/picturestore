import { useContext } from "solid-js";
import type { RGB } from "../../core/color";
import { resolutionOf } from "../../core/document";
import { IDENTITY } from "../../core/geometry";
import { fontLibrary } from "../../text/engine";
import { common, type AntiAlias, type CharStyle, type ParagraphStyle } from "../../text/model";
import { formatTypeLength, fromTypeUnit, parseTypeLength, toTypeUnit, typeScale } from "../../text/units";
import { fontFamilies } from "../../fonts/service";
import { AppContext } from "../context";

/**
 * What the type panels and the Type tools' options bar show and change:
 * the selected text while editing, else the active type layer, else what
 * new type will be (see Editor.type). Lengths are shown in the type unit
 * at the document's resolution, as drawn (after the layer's transform).
 */
export function useTypeState() {
  const { editor } = useContext(AppContext);
  const target = () => editor.type.target();
  const chars = () => editor.type.charStyles();
  const paras = () => editor.type.paragraphStyles();
  const scale = () => typeScale(target()?.content.transform ?? IDENTITY);
  const unit = () => editor.preferences().typeUnits;
  const ppi = () => resolutionOf(editor.active()?.doc() ?? {});

  return {
    editor,
    target,
    char: <K extends keyof CharStyle>(k: K) => common(chars(), k),
    para: <K extends keyof ParagraphStyle>(k: K) => common(paras(), k),
    setChar: (patch: Partial<CharStyle> | ((s: CharStyle) => Partial<CharStyle>), key?: string) => editor.type.formatCharacters(patch, key),
    setPara: (patch: Partial<ParagraphStyle>, key?: string) => editor.type.formatParagraphs(patch, key),
    /** A text-space length as shown ("" when it varies), vertical or horizontal. */
    show: (px: number | undefined, axis: "x" | "y" = "y") => (px === undefined ? "" : formatTypeLength(px * scale()[axis], unit(), ppi())),
    /** A typed length in text space, or null. */
    parse: (text: string, axis: "x" | "y" = "y", negative = false) => {
      const v = parseTypeLength(text, unit(), ppi(), negative);
      return v === null ? null : v / scale()[axis];
    },
    /** A length in the type unit → text space (for presets and scrubbing). */
    toText: (v: number, axis: "x" | "y" = "y") => fromTypeUnit(v, unit(), ppi()) / scale()[axis],
    fromText: (px: number, axis: "x" | "y" = "y") => toTypeUnit(px * scale()[axis], unit(), ppi()),
    unit,
    /** Type colour: the text's, else the foreground (new type takes it). */
    color: (): RGB | undefined => (target() ? common(chars(), "color") : editor.foreground()),
    setColor: (c: RGB) => (target() ? editor.type.formatCharacters({ color: c }, "color") : editor.setForeground(c)),
    antiAlias: (): AntiAlias => target()?.content.antiAlias ?? editor.settings.type.antiAlias,
    setAntiAlias: (a: AntiAlias) => (target() ? editor.type.update("Anti-Alias", (c) => ({ ...c, antiAlias: a })) : editor.setSettings((s) => void (s.type.antiAlias = a))),
    orientation: () => target()?.content.orientation ?? (editor.tool() === "type-vertical" || editor.tool() === "type-mask-vertical" ? "vertical" : "horizontal"),
    /** Whether the font is unavailable (shown in brackets, with a warning). */
    missing: (f: CharStyle["font"] | undefined) => (fontFamilies(), !!f && !fontLibrary().knows(f)),
    /** Whether any of the selection's fonts has an OpenType feature (the panel's OpenType buttons grey out otherwise). */
    hasFeature: (tags: readonly string[]) => {
      fontFamilies();
      return chars().some((s) => {
        const face = fontLibrary().resolve(s.font);
        return !!face && tags.some((t) => face.features.has(t));
      });
    },
  };
}

export type TypeState = ReturnType<typeof useTypeState>;
