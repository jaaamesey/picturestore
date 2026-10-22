import type { JSX } from "@solidjs/web";
import { For, Show, createSignal } from "solid-js";
import { BLACK, toHex, type RGB } from "../../core/color";
import { LANGUAGES } from "../../text/breaks";
import type { AntiAlias, CharStyle, Kerning } from "../../text/model";
import { ColorPicker } from "../ColorPicker";
import { Popover } from "../Popover";
import { ComboField, FontFamilyField, FontStyleField, StyleToggle } from "./fields";
import { useTypeState, type TypeState } from "./state";

/** Photoshop's preset lists. */
export const SIZE_PRESETS = [6, 8, 9, 10, 11, 12, 14, 18, 24, 30, 36, 48, 60, 72].map((n) => `${n} pt`);
const LEADING_PRESETS = ["(Auto)", ...SIZE_PRESETS];
const KERNING_PRESETS = ["Metrics", "Optical", "0", "25", "50", "75", "100", "200", "-5", "-10", "-25", "-50", "-75", "-100"];
const TRACKING_PRESETS = ["-100", "-75", "-50", "-25", "-10", "-5", "0", "5", "10", "25", "50", "75", "100", "200"];

export const ANTI_ALIAS_OPTIONS: readonly { readonly id: AntiAlias; readonly label: string }[] = [
  { id: "none", label: "None" },
  { id: "sharp", label: "Sharp" },
  { id: "crisp", label: "Crisp" },
  { id: "strong", label: "Strong" },
  { id: "smooth", label: "Smooth" },
  { id: "platformLCD", label: "Windows LCD" },
  { id: "platform", label: "Windows" },
];

/** Photoshop's limits, in points. */
const MAX_SIZE_PT = 1296;
const MIN_SIZE_PT = 0.01;

const num = (text: string) => {
  const v = Number.parseFloat(text);
  return Number.isFinite(v) ? v : null;
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const pct = (v: number | undefined) => (v === undefined ? "" : `${Math.round(v * 1000) / 10}%`);
const round2 = (v: number) => Math.round(v * 100) / 100;

const glyph = (s: string, style?: JSX.CSSProperties) => (
  <span class="font-serif text-[11px] leading-none" style={style}>
    {s}
  </span>
);

/** A colour swatch that opens the picker: blank and grey when the selection's colours differ. */
export function ColorSwatch(props: { title: string; testId: string; color: RGB | undefined; onChange: (c: RGB) => void }) {
  const [open, setOpen] = createSignal(false);
  let button!: HTMLButtonElement;
  const at = () => {
    const r = button.getBoundingClientRect();
    return { left: `${r.left}px`, top: `${r.bottom + 4}px` };
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        title={props.title}
        aria-label={props.title}
        data-testid={props.testId}
        data-color={props.color ? toHex(props.color) : "mixed"}
        class="h-5 w-10 rounded-xs border border-white/50"
        style={{ background: props.color ? toHex(props.color) : "repeating-linear-gradient(45deg, #777 0 3px, #555 3px 6px)" }}
        onClick={() => setOpen((o) => !o)}
      />
      <Popover open={open()} onClose={() => setOpen(false)} trigger={() => button} fixed style={at()} testId={`${props.testId}-popover`}>
        <ColorPicker title={props.title} initial={props.color ?? BLACK} onChange={props.onChange} onClose={() => setOpen(false)} />
      </Popover>
    </>
  );
}

/** Font family and style, shared by the Character panel and the options bar. */
export function FontFields(props: { t: TypeState; testId: string }) {
  const font = () => props.t.char("font");
  const pick = (f: { ref: CharStyle["font"] }) => props.t.setChar({ font: f.ref, variations: {} }, "font");
  return (
    <>
      <FontFamilyField font={font()} missing={props.t.missing(font())} testId={`${props.testId}-family`} onPick={pick} />
      <FontStyleField font={font()} missing={props.t.missing(font())} testId={`${props.testId}-style`} onPick={pick} />
    </>
  );
}

/** The font size field (also on the options bar). */
export function SizeField(props: { t: TypeState; testId: string }) {
  const t = props.t;
  const set = (px: number | null) => {
    if (px === null) return;
    t.setChar({ size: clamp(px, t.toText(MIN_SIZE_PT), t.toText(MAX_SIZE_PT)) }, "size");
  };
  return (
    <ComboField
      icon={glyph("tT")}
      title="Set the font size"
      testId={props.testId}
      value={t.show(t.char("size"))}
      presets={SIZE_PRESETS}
      onCommit={(text) => set(t.parse(text))}
      scrub={{ value: t.char("size") === undefined ? undefined : round2(t.fromText(t.char("size")!)), step: 1, set: (v) => set(t.toText(Math.max(v, MIN_SIZE_PT))) }}
    />
  );
}

/** Window ▸ Character: Photoshop's Character panel. */
export function CharacterPanel() {
  const t = useTypeState();
  const toggle = <K extends keyof CharStyle>(k: K, on: CharStyle[K], off: CharStyle[K]) => t.setChar({ [k]: t.char(k) === on ? off : on } as Partial<CharStyle>);
  const flag = (k: keyof CharStyle) => t.char(k) as boolean | undefined;
  const kerningText = (k: Kerning | undefined) => (k === undefined ? "" : k === "metrics" ? "Metrics" : k === "optical" ? "Optical" : String(k));
  const parseKerning = (text: string): Kerning | null => {
    if (/^m/i.test(text.trim())) return "metrics";
    if (/^o/i.test(text.trim())) return "optical";
    const v = num(text);
    return v === null ? null : clamp(Math.round(v), -1000, 10000);
  };
  const setScale = (k: "verticalScale" | "horizontalScale", text: string) => {
    const v = num(text);
    if (v !== null) t.setChar({ [k]: clamp(v, 0, 1000) / 100 }, k);
  };
  return (
    <div class="flex flex-col gap-1.5 overflow-y-auto p-2" data-testid="character">
      <div class="flex gap-1">
        <FontFields t={t} testId="char-font" />
      </div>
      <div class="grid grid-cols-2 gap-x-2 gap-y-1.5">
        <SizeField t={t} testId="char-size" />
        <ComboField
          icon={glyph("A⇕")}
          title="Set the leading"
          testId="char-leading"
          value={t.char("leading") === null ? "(Auto)" : t.show(t.char("leading") as number | undefined)}
          presets={LEADING_PRESETS}
          onCommit={(text) => {
            if (/auto/i.test(text) || !text.trim()) return t.setChar({ leading: null }, "leading");
            const px = t.parse(text);
            if (px !== null) t.setChar({ leading: Math.min(px, t.toText(5000)) }, "leading");
          }}
        />
        <ComboField
          icon={glyph("V|A")}
          title="Set the kerning between two characters"
          testId="char-kerning"
          value={kerningText(t.char("kerning"))}
          presets={KERNING_PRESETS}
          onCommit={(text) => {
            const k = parseKerning(text);
            if (k !== null) t.setChar({ kerning: k }, "kerning");
          }}
        />
        <ComboField
          icon={glyph("VA↔")}
          title="Set the tracking for the selected characters"
          testId="char-tracking"
          value={t.char("tracking") === undefined ? "" : String(t.char("tracking"))}
          presets={TRACKING_PRESETS}
          onCommit={(text) => {
            const v = num(text);
            if (v !== null) t.setChar({ tracking: clamp(Math.round(v), -1000, 10000) }, "tracking");
          }}
          scrub={{ value: t.char("tracking"), step: 5, set: (v) => t.setChar({ tracking: clamp(v, -1000, 10000) }, "tracking") }}
        />
        <ComboField icon={glyph("IT")} title="Vertically scale" testId="char-vscale" value={pct(t.char("verticalScale"))} onCommit={(text) => setScale("verticalScale", text)} />
        <ComboField icon={glyph("T↔")} title="Horizontally scale" testId="char-hscale" value={pct(t.char("horizontalScale"))} onCommit={(text) => setScale("horizontalScale", text)} />
        <ComboField
          icon={glyph("Aª")}
          title="Set the baseline shift"
          testId="char-baseline"
          value={t.show(t.char("baselineShift"))}
          onCommit={(text) => {
            const px = t.parse(text, "y", true);
            if (px !== null) t.setChar({ baselineShift: px }, "baselineShift");
          }}
        />
        <div class="flex items-center gap-1">
          <span class="pl-1 text-dim">Color:</span>
          <ColorSwatch title="Set the text color" testId="char-color" color={t.color()} onChange={t.setColor} />
        </div>
      </div>
      <div class="flex flex-wrap gap-0.5" role="group" aria-label="Character styles">
        <StyleToggle title="Faux Bold" testId="char-faux-bold" on={flag("fauxBold")} onToggle={() => toggle("fauxBold", true, false)}>
          {glyph("T", { "font-weight": 900 })}
        </StyleToggle>
        <StyleToggle title="Faux Italic" testId="char-faux-italic" on={flag("fauxItalic")} onToggle={() => toggle("fauxItalic", true, false)}>
          {glyph("T", { "font-style": "italic" })}
        </StyleToggle>
        <StyleToggle title="All Caps" testId="char-all-caps" on={t.char("caps") === undefined ? undefined : t.char("caps") === "all"} onToggle={() => toggle("caps", "all", "normal")}>
          {glyph("TT")}
        </StyleToggle>
        <StyleToggle title="Small Caps" testId="char-small-caps" on={t.char("caps") === undefined ? undefined : t.char("caps") === "small"} onToggle={() => toggle("caps", "small", "normal")}>
          {glyph("Tᴛ")}
        </StyleToggle>
        <StyleToggle title="Superscript" testId="char-superscript" on={t.char("position") === undefined ? undefined : t.char("position") === "superscript"} onToggle={() => toggle("position", "superscript", "normal")}>
          {glyph("T¹")}
        </StyleToggle>
        <StyleToggle title="Subscript" testId="char-subscript" on={t.char("position") === undefined ? undefined : t.char("position") === "subscript"} onToggle={() => toggle("position", "subscript", "normal")}>
          {glyph("T₁")}
        </StyleToggle>
        <StyleToggle title="Underline" testId="char-underline" on={flag("underline")} onToggle={() => toggle("underline", true, false)}>
          {glyph("T", { "text-decoration": "underline" })}
        </StyleToggle>
        <StyleToggle title="Strikethrough" testId="char-strikethrough" on={flag("strikethrough")} onToggle={() => toggle("strikethrough", true, false)}>
          {glyph("T", { "text-decoration": "line-through" })}
        </StyleToggle>
      </div>
      <div class="flex flex-wrap gap-0.5" role="group" aria-label="OpenType features">
        <For each={OPENTYPE_BUTTONS}>
          {(b) => (
            <StyleToggle title={b.title} testId={`char-ot-${b.key}`} on={flag(b.key)} disabled={!t.hasFeature(b.tags)} onToggle={() => toggle(b.key, true, false)}>
              {glyph(b.glyph, b.style)}
            </StyleToggle>
          )}
        </For>
      </div>
      <div class="flex gap-1">
        <select
          class="min-w-0 flex-1"
          title="Set the language on selected characters for hyphenation and spelling"
          data-testid="char-language"
          value={t.char("language") ?? ""}
          onChange={(e) => t.setChar({ language: e.currentTarget.value })}
        >
          <Show when={t.char("language") === undefined}>
            <option value="" />
          </Show>
          <For each={LANGUAGES}>{(l) => <option value={l.tag}>{l.name}</option>}</For>
        </select>
        <AntiAliasSelect t={t} testId="char-anti-alias" />
      </div>
    </div>
  );
}

/** The OpenType buttons, in Photoshop's order (greyed out where the font lacks the feature). */
const OPENTYPE_BUTTONS: readonly { key: keyof CharStyle; tags: readonly string[]; title: string; glyph: string; style?: JSX.CSSProperties }[] = [
  { key: "ligatures", tags: ["liga", "clig"], title: "Standard Ligatures", glyph: "fi" },
  { key: "contextualAlternates", tags: ["calt"], title: "Contextual Alternates", glyph: "ℴ" },
  { key: "discretionaryLigatures", tags: ["dlig"], title: "Discretionary Ligatures", glyph: "st" },
  { key: "swash", tags: ["swsh"], title: "Swash", glyph: "A", style: { "font-style": "italic" } },
  { key: "stylisticAlternates", tags: ["salt"], title: "Stylistic Alternates", glyph: "aa" },
  { key: "titlingAlternates", tags: ["titl"], title: "Titling Alternates", glyph: "T" },
  { key: "ordinals", tags: ["ordn"], title: "Ordinals", glyph: "1ˢᵗ" },
  { key: "fractions", tags: ["frac"], title: "Fractions", glyph: "½" },
];

export function AntiAliasSelect(props: { t: TypeState; testId: string }) {
  return (
    <select
      title="Set the anti-aliasing method"
      data-testid={props.testId}
      value={props.t.antiAlias()}
      onChange={(e) => props.t.setAntiAlias(e.currentTarget.value as AntiAlias)}
    >
      <For each={ANTI_ALIAS_OPTIONS}>{(o) => <option value={o.id}>{o.label}</option>}</For>
    </select>
  );
}
