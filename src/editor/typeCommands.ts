import { common, LOREM_IPSUM, DEFAULT_CHAR_STYLE, DEFAULT_PARAGRAPH_STYLE, type AntiAlias, type CharStyle, type ParagraphStyle } from "../text/model";
import type { CommandSpec } from "./commands";
import type { Editor } from "./editor";
import type { FontPreviewSize } from "./preferences";

/**
 * The Window menu's panels, the Type menu, and the Character and Paragraph
 * panels' menus, as in Photoshop.
 */

export type PanelName = "history" | "properties" | "layers" | "character" | "paragraph" | "glyphs";

const panel = (label: string, id: PanelName): CommandSpec => ({
  label,
  run: (_, s) => s.togglePanel(id),
  checked: (_, s) => s.panelOpen(id),
});

const typeLayer = (ed: Editor) => !!ed.type.target();
const editing = (ed: Editor) => !!ed.type.session();
const textOf = (ed: Editor) => ed.type.target()?.content;

const antiAlias = (label: string, a: AntiAlias): CommandSpec => ({
  label,
  run: (ed) => ed.type.update("Anti-Alias", (c) => ({ ...c, antiAlias: a })),
  enabled: typeLayer,
  checked: (ed) => textOf(ed)?.antiAlias === a,
});

const orientation = (label: string, o: "horizontal" | "vertical"): CommandSpec => ({
  label,
  run: (ed) => ed.type.update("Change Text Orientation", (c) => ({ ...c, orientation: o })),
  enabled: typeLayer,
  checked: (ed) => textOf(ed)?.orientation === o,
});

const previewSize = (label: string, size: FontPreviewSize): CommandSpec => ({
  label,
  run: (ed) => ed.setPreferences({ ...ed.preferences(), fontPreviewSize: size }),
  checked: (ed) => ed.preferences().fontPreviewSize === size,
});

const char = <K extends keyof CharStyle>(ed: Editor, k: K) => common(ed.type.charStyles(), k);
/** A Character panel menu toggle: `on` when every selected character has it. */
const charToggle = <K extends keyof CharStyle>(label: string, k: K, on: CharStyle[K], off: CharStyle[K], shortcuts?: string[]): CommandSpec => ({
  label,
  shortcuts,
  run: (ed) => ed.type.formatCharacters({ [k]: char(ed, k) === on ? off : on } as Partial<CharStyle>),
  checked: (ed) => char(ed, k) === on,
});
const charChoice = <K extends keyof CharStyle>(label: string, k: K, v: CharStyle[K]): CommandSpec => ({
  label,
  run: (ed) => ed.type.formatCharacters({ [k]: v } as Partial<CharStyle>),
  checked: (ed) => char(ed, k) === v,
});

const para = <K extends keyof ParagraphStyle>(ed: Editor, k: K) => common(ed.type.paragraphStyles(), k);
const paraChoice = <K extends keyof ParagraphStyle>(label: string, k: K, v: ParagraphStyle[K]): CommandSpec => ({
  label,
  run: (ed) => ed.type.formatParagraphs({ [k]: v } as Partial<ParagraphStyle>),
  checked: (ed) => para(ed, k) === v,
});

/** Reset Character keeps the font and its size and colour, as Photoshop does; the rest go back to the defaults. */
const resetCharacter = (s: CharStyle): Partial<CharStyle> => ({ ...DEFAULT_CHAR_STYLE, font: s.font, size: s.size, color: s.color });

export const TYPE_COMMANDS = {
  "window.character": panel("Character", "character"),
  "window.paragraph": panel("Paragraph", "paragraph"),
  "window.glyphs": panel("Glyphs", "glyphs"),
  "window.history": panel("History", "history"),
  "window.layers": panel("Layers", "layers"),
  "window.properties": panel("Properties", "properties"),

  "type.panels.character": panel("Character Panel", "character"),
  "type.panels.paragraph": panel("Paragraph Panel", "paragraph"),
  "type.panels.glyphs": panel("Glyphs Panel", "glyphs"),
  "type.antiAlias.none": antiAlias("None", "none"),
  "type.antiAlias.sharp": antiAlias("Sharp", "sharp"),
  "type.antiAlias.crisp": antiAlias("Crisp", "crisp"),
  "type.antiAlias.strong": antiAlias("Strong", "strong"),
  "type.antiAlias.smooth": antiAlias("Smooth", "smooth"),
  "type.antiAlias.platformLCD": antiAlias("Windows LCD", "platformLCD"),
  "type.antiAlias.platform": antiAlias("Windows", "platform"),
  "type.orientation.horizontal": orientation("Horizontal", "horizontal"),
  "type.orientation.vertical": orientation("Vertical", "vertical"),
  "type.convertToShape": { label: "Convert to Shape", run: (ed) => ed.type.convertToShape(), enabled: typeLayer },
  "type.rasterize": { label: "Rasterize Type Layer", run: (ed) => ed.rasterizeLayer(), enabled: (ed) => typeLayer(ed) && !editing(ed) },
  "type.convertShapeType": {
    label: "Convert to Paragraph Text",
    title: (ed) => (textOf(ed)?.frame.kind === "box" ? "Convert to Point Text" : "Convert to Paragraph Text"),
    run: (ed) => void ed.type.convertShapeType(),
    enabled: (ed) => textOf(ed)?.frame.kind === "box" || textOf(ed)?.frame.kind === "point",
  },
  "type.warp": { label: "Warp Text…", run: (_, s) => s.warpText(), enabled: typeLayer },
  "type.previewSize.none": previewSize("None", "none"),
  "type.previewSize.small": previewSize("Small", "small"),
  "type.previewSize.medium": previewSize("Medium", "medium"),
  "type.previewSize.large": previewSize("Large", "large"),
  "type.previewSize.extraLarge": previewSize("Extra Large", "extra-large"),
  "type.previewSize.huge": previewSize("Huge", "huge"),
  "type.updateAll": { label: "Update All Text Layers", run: (ed) => ed.type.updateAll(), enabled: (ed) => !!ed.active() },
  "type.replaceMissing": { label: "Replace All Missing Fonts", run: (ed) => ed.type.replaceMissingFonts(), enabled: (ed) => !!ed.active() },
  "type.pasteLorem": { label: "Paste Lorem Ipsum", run: (ed) => ed.type.input(LOREM_IPSUM), enabled: editing },

  // The Character panel's menu.
  "char.fauxBold": charToggle("Faux Bold", "fauxBold", true, false),
  "char.fauxItalic": charToggle("Faux Italic", "fauxItalic", true, false),
  "char.allCaps": charToggle("All Caps", "caps", "all", "normal"),
  "char.smallCaps": charToggle("Small Caps", "caps", "small", "normal"),
  "char.superscript": charToggle("Superscript", "position", "superscript", "normal"),
  "char.subscript": charToggle("Subscript", "position", "subscript", "normal"),
  "char.underline": charToggle("Underline", "underline", true, false),
  "char.strikethrough": charToggle("Strikethrough", "strikethrough", true, false),
  "char.oldStyle": charToggle("Oldstyle Figures", "oldStyle", true, false),
  "char.ornaments": charToggle("Ornaments", "ornaments", true, false),
  "char.fractionalWidths": charToggle("Fractional Widths", "fractionalWidths", true, false),
  "char.noBreak": charToggle("No Break", "noBreak", true, false),
  "char.verticalRoman": charToggle("Standard Vertical Roman Alignment", "uprightRoman", false, true),
  "char.tateChuYoko": charToggle("Tate-Chu-Yoko", "tateChuYoko", true, false),
  "char.underlineRight": charChoice("Underline Right", "underlineSide", "right"),
  "char.underlineLeft": charChoice("Underline Left", "underlineSide", "left"),
  "char.digits.default": charChoice("Default Digits", "digits", "default"),
  "char.digits.arabic": charChoice("Arabic Digits", "digits", "arabic"),
  "char.digits.hindi": charChoice("Hindi Digits", "digits", "hindi"),
  "char.digits.farsi": charChoice("Farsi Digits", "digits", "farsi"),
  "char.reset": { label: "Reset Character", run: (ed) => ed.type.formatCharacters(resetCharacter) },

  // The Paragraph panel's menu.
  "para.hangingPunctuation": {
    label: "Roman Hanging Punctuation",
    run: (ed) => ed.type.formatParagraphs({ hangingPunctuation: para(ed, "hangingPunctuation") !== true }),
    checked: (ed) => para(ed, "hangingPunctuation") === true,
  },
  "para.composer.single": paraChoice("Adobe Single-line Composer", "composer", "single"),
  "para.composer.every": paraChoice("Adobe Every-line Composer", "composer", "every"),
  "para.direction.ltr": paraChoice("Left-to-Right Paragraph Direction", "direction", "ltr"),
  "para.direction.rtl": paraChoice("Right-to-Left Paragraph Direction", "direction", "rtl"),
  "para.reset": { label: "Reset Paragraph", run: (ed) => ed.type.formatParagraphs(DEFAULT_PARAGRAPH_STYLE) },
} as const satisfies Record<string, CommandSpec>;
