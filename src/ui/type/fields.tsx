import type { JSX } from "@solidjs/web";
import { For, Show, createMemo, createSignal, useContext } from "solid-js";
import { runCommand } from "../../editor/commands";
import { FONT_PREVIEW_PX } from "../../editor/preferences";
import { cssFont, fontFamilies } from "../../fonts/service";
import type { FontEntry } from "../../text/fonts";
import type { FontRef } from "../../text/model";
import { AppContext } from "../context";
import { Field } from "../controls";
import { Icon } from "../icons";
import { Popover } from "../Popover";

/** A fixed-position list under an element (panels scroll, so a list inside one would be clipped). */
function DropList(props: { open: boolean; anchor: () => HTMLElement; onClose: () => void; testId?: string; children: JSX.Element }) {
  const at = () => {
    const r = props.anchor().getBoundingClientRect();
    return { left: `${r.left}px`, top: `${r.bottom + 2}px`, "min-width": `${r.width}px` };
  };
  return (
    <Popover open={props.open} onClose={props.onClose} trigger={props.anchor} fixed style={at()} testId={props.testId}>
      <div class="max-h-80 overflow-y-auto rounded-sm border border-line bg-panel-2 py-1 shadow-xl" role="listbox">
        {props.children}
      </div>
    </Popover>
  );
}

/**
 * Photoshop's combo fields (size, leading, kerning…): type a value, with or
 * without a unit, or pick a preset from the arrow's list. Blank when the
 * selection's values differ. Dragging the icon scrubs the value.
 */
export function ComboField(props: {
  icon: JSX.Element;
  title: string;
  testId: string;
  value: string;
  presets?: readonly string[];
  width?: string;
  disabled?: boolean;
  onCommit: (text: string) => void;
  scrub?: { readonly value: number | undefined; readonly step: number; readonly set: (v: number) => void };
}) {
  const [open, setOpen] = createSignal(false);
  let box!: HTMLDivElement;
  const scrub = (e: PointerEvent) => {
    const s = props.scrub;
    if (!s || props.disabled || e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, v0 = s.value ?? 0;
    const move = (m: PointerEvent) => s.set(Math.round((v0 + ((m.clientX - x0) / 2) * s.step) / s.step) * s.step);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  return (
    <div class={["flex min-w-0 items-center gap-1", { "opacity-40": !!props.disabled }]} title={props.title}>
      <span class={["grid w-6 shrink-0 place-items-center text-dim", { "cursor-ew-resize": !!props.scrub }]} onPointerDown={scrub}>
        {props.icon}
      </span>
      <div ref={box} class="flex min-w-0 flex-1 items-center rounded-xs border border-line bg-app" style={{ width: props.width }}>
        <Field
          type="text"
          class="min-w-0 flex-1 border-0 bg-transparent px-1 text-xs"
          aria-label={props.title}
          data-testid={props.testId}
          disabled={props.disabled}
          value={props.value}
          onChange={(e) => props.onCommit(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        <Show when={props.presets}>
          <button type="button" class="px-0.5 text-dim hover:text-fg" tabindex={-1} disabled={props.disabled} aria-label={`${props.title} presets`} onClick={() => void setOpen((o) => !o)}>
            <Icon name="chevron" class="rotate-90" size={10} />
          </button>
        </Show>
      </div>
      <DropList open={open()} anchor={() => box} onClose={() => setOpen(false)} testId={`${props.testId}-presets`}>
        <For each={props.presets ?? []}>
          {(p) => (
            <button
              type="button"
              role="option"
              class="block w-full px-3 py-0.5 text-left hover:bg-accent hover:text-white"
              onClick={() => {
                setOpen(false);
                props.onCommit(p);
              }}
            >
              {p}
            </button>
          )}
        </For>
      </DropList>
    </div>
  );
}

/** Families matching what's typed: those starting with it first, then those containing it. */
export function matchFamilies<T extends { family: string }>(families: readonly T[], typed: string): T[] {
  const q = typed.trim().toLowerCase();
  if (!q) return [...families];
  const starts = families.filter((f) => f.family.toLowerCase().startsWith(q));
  return [...starts, ...families.filter((f) => !starts.includes(f) && f.family.toLowerCase().includes(q))];
}

/** The style a family offers closest to `style`: the same name, else Regular, else its first. */
export function closestStyle(fonts: readonly FontEntry[], style: string | undefined): FontEntry {
  return fonts.find((f) => f.ref.style === style) ?? fonts.find((f) => /^(regular|roman|book|normal)$/i.test(f.ref.style)) ?? fonts[0];
}

/**
 * The font family menu: type to find a family (Enter takes the first
 * match), or pick one from the list, each with a sample in its own font at
 * the Font Preview Size. A family that isn't available shows in brackets,
 * as Photoshop marks missing fonts.
 */
export function FontFamilyField(props: { font: FontRef | undefined; missing: boolean; testId: string; onPick: (f: FontEntry) => void }) {
  const { editor, shell } = useContext(AppContext);
  const [query, setQuery] = createSignal<string | null>(null);
  let box!: HTMLDivElement, input!: HTMLInputElement;
  const families = createMemo(() => fontFamilies());
  const shown = createMemo(() => matchFamilies(families(), query() ?? ""));
  const preview = () => FONT_PREVIEW_PX[editor.preferences().fontPreviewSize];
  const pick = (fonts: readonly FontEntry[]) => {
    setQuery(null);
    input.blur();
    props.onPick(closestStyle(fonts, props.font?.style));
  };
  const label = () => (props.font ? (props.missing ? `[${props.font.family}]` : props.font.family) : "");
  return (
    <div ref={box} class="flex min-w-0 flex-1 items-center rounded-xs border border-line bg-app" title="Set the font family">
      <Show when={props.missing}>
        <span class="pl-1 text-amber-400" title="This font is missing" data-testid={`${props.testId}-missing`}>
          <Icon name="warning" size={12} />
        </span>
      </Show>
      <input
        ref={input}
        type="text"
        class="min-w-0 flex-1 border-0 bg-transparent px-1 text-xs"
        aria-label="Font family"
        data-testid={props.testId}
        value={query() ?? label()}
        onFocus={(e) => e.currentTarget.select()}
        onInput={(e) => setQuery(e.currentTarget.value)}
        onBlur={() => setTimeout(() => document.activeElement !== input && setQuery(null), 150)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && shown().length) pick(shown()[0].fonts);
          if (e.key === "Escape") {
            setQuery(null);
            input.blur();
          }
        }}
      />
      <button type="button" class="px-0.5 text-dim hover:text-fg" tabindex={-1} aria-label="Font families" data-testid={`${props.testId}-open`} onClick={() => void setQuery((q) => (q === null ? "" : null))}>
        <Icon name="chevron" class="rotate-90" size={10} />
      </button>
      <DropList open={query() !== null} anchor={() => box} onClose={() => setQuery(null)} testId={`${props.testId}-list`}>
        <For each={shown()}>
          {(f) => (
            <button
              type="button"
              role="option"
              aria-selected={f.family === props.font?.family ? "true" : "false"}
              data-family={f.family}
              class={["flex w-full items-center justify-between gap-6 px-3 py-0.5 text-left hover:bg-accent hover:text-white", { "bg-accent-soft": f.family === props.font?.family }]}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(f.fonts)}
            >
              <span class="whitespace-nowrap">{f.family}</span>
              <Show when={preview()}>
                <span class="whitespace-nowrap" style={{ ...cssFont(closestStyle(f.fonts, "Regular")), "font-size": `${preview()}px` }}>
                  Sample
                </span>
              </Show>
            </button>
          )}
        </For>
        <div class="my-1 h-px bg-line" />
        <button
          type="button"
          class="block w-full px-3 py-0.5 text-left hover:bg-accent hover:text-white"
          data-testid={`${props.testId}-add`}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => {
            setQuery(null);
            runCommand("type.addFonts", editor, shell);
          }}
        >
          Add Fonts…
        </button>
      </DropList>
    </div>
  );
}

/** The font style menu: the styles of the font's family (a missing font's own, in brackets). */
export function FontStyleField(props: { font: FontRef | undefined; missing: boolean; testId: string; onPick: (f: FontEntry) => void }) {
  const fonts = createMemo(() => fontFamilies().find((f) => f.family === props.font?.family)?.fonts ?? []);
  return (
    <select
      class="min-w-0 flex-1 text-xs"
      title="Set the font style"
      aria-label="Font style"
      data-testid={props.testId}
      value={props.font && !props.missing ? props.font.style : ""}
      onChange={(e) => {
        const f = fonts().find((g) => g.ref.style === e.currentTarget.value);
        if (f) props.onPick(f);
      }}
    >
      <Show when={!props.font || props.missing}>
        <option value="">{props.font ? `[${props.font.style}]` : ""}</option>
      </Show>
      <For each={fonts()}>{(f) => <option value={f.ref.style}>{f.ref.style}</option>}</For>
    </select>
  );
}

/** A Character panel toggle (Faux Bold, All Caps, the OpenType buttons): pressed, unpressed, or mixed. */
export function StyleToggle(props: { title: string; testId: string; on: boolean | undefined; disabled?: boolean; style?: JSX.CSSProperties; children: JSX.Element; onToggle: () => void }) {
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      aria-pressed={props.on === undefined ? "mixed" : props.on ? "true" : "false"}
      data-testid={props.testId}
      disabled={props.disabled}
      class={[
        "grid h-6 min-w-6 place-items-center rounded-xs px-0.5 text-xs leading-none disabled:opacity-35",
        props.on ? "bg-accent-soft text-white" : props.on === undefined ? "bg-raised/60" : "hover:bg-raised",
      ]}
      style={props.style}
      onClick={() => props.onToggle()}
    >
      {props.children}
    </button>
  );
}
