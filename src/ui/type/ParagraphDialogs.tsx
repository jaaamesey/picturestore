import type { JSX } from "@solidjs/web";
import { For, createSignal, onSettled, untrack } from "solid-js";
import type { Hyphenation, ParagraphStyle, Range3 } from "../../text/model";
import { Button, Field } from "../controls";
import { dismissable } from "../Popover";

/** A modal with OK and Cancel (Enter and Escape). */
function Dialog(props: { title: string; testId: string; onOk: () => void; onCancel: () => void; children: JSX.Element }) {
  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      props.onOk();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    const remove = dismissable(props.onCancel);
    return () => {
      remove();
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  });
  return (
    <div class="fixed inset-0 z-50 grid place-items-center bg-black/50">
      <div class="flex gap-4 rounded-sm border border-line bg-panel p-4 shadow-2xl" role="dialog" aria-label={props.title} data-testid={props.testId}>
        <div class="space-y-2">{props.children}</div>
        <div class="flex flex-col gap-2">
          <Button primary testId={`${props.testId}-ok`} onClick={props.onOk}>
            OK
          </Button>
          <Button onClick={props.onCancel}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

const num = (props: { value: number; testId: string; min: number; max: number; onChange: (v: number) => void }) => (
  <Field
    type="number"
    class="w-16 text-right"
    data-testid={props.testId}
    value={props.value}
    min={props.min}
    max={props.max}
    onChange={(e) => Number.isFinite(e.currentTarget.valueAsNumber) && props.onChange(Math.min(props.max, Math.max(props.min, e.currentTarget.valueAsNumber)))}
    onKeyDown={(e) => e.stopPropagation()}
  />
);

const pct = (v: number) => Math.round(v * 1000) / 10;

/**
 * Paragraph panel ▸ Justification: how justified lines are spread — word
 * and letter spacing and glyph scaling as minimum, desired and maximum —
 * and Auto Leading, as percentages (Photoshop's ranges).
 */
export function JustificationDialog(props: { initial: ParagraphStyle; onOk: (p: Partial<ParagraphStyle>) => void; onCancel: () => void }) {
  const init = untrack(() => props.initial);
  const [word, setWord] = createSignal<Range3>(init.wordSpacing);
  const [letter, setLetter] = createSignal<Range3>(init.letterSpacing);
  const [glyph, setGlyph] = createSignal<Range3>(init.glyphScaling);
  const [leading, setLeading] = createSignal(init.autoLeading);
  const rows: { label: string; key: string; get: () => Range3; set: (r: Range3) => void; min: number; max: number }[] = [
    { label: "Word Spacing", key: "word", get: word, set: setWord, min: 0, max: 1000 },
    { label: "Letter Spacing", key: "letter", get: letter, set: setLetter, min: -100, max: 500 },
    { label: "Glyph Scaling", key: "glyph", get: glyph, set: setGlyph, min: 50, max: 200 },
  ];
  // Minimum ≤ desired ≤ maximum, as Photoshop keeps them.
  const setAt = (r: Range3, i: number, v: number): Range3 => {
    const out = [...r] as [number, number, number];
    out[i] = v;
    for (let k = 0; k < 3; k++) if (k < i) out[k] = Math.min(out[k], v);
    else if (k > i) out[k] = Math.max(out[k], v);
    return out;
  };
  return (
    <Dialog
      title="Justification"
      testId="justification"
      onCancel={props.onCancel}
      onOk={() => props.onOk({ wordSpacing: word(), letterSpacing: letter(), glyphScaling: glyph(), autoLeading: leading() })}
    >
      <div class="grid grid-cols-[auto_repeat(3,auto)] items-center gap-x-2 gap-y-1.5">
        <span />
        <span class="text-center text-dim">Minimum</span>
        <span class="text-center text-dim">Desired</span>
        <span class="text-center text-dim">Maximum</span>
        <For each={rows}>
          {(r) => (
            <>
              <span>{r.label}:</span>
              <For each={[0, 1, 2]}>{(i) => num({ value: pct(r.get()[i]), testId: `justify-${r.key}-${i}`, min: r.min, max: r.max, onChange: (v) => r.set(setAt(r.get(), i, v / 100)) })}</For>
            </>
          )}
        </For>
      </div>
      <label class="flex items-center gap-2">
        <span>Auto Leading:</span>
        {num({ value: pct(leading()), testId: "justify-auto-leading", min: 0, max: 500, onChange: (v) => setLeading(v / 100) })}
        <span class="text-dim">%</span>
      </label>
    </Dialog>
  );
}

/** Paragraph panel ▸ Hyphenation: when words are hyphenated (Photoshop's options). */
export function HyphenationDialog(props: { initial: ParagraphStyle; zoneLabel: (px: number) => string; parseZone: (text: string) => number | null; onOk: (p: Partial<ParagraphStyle>) => void; onCancel: () => void }) {
  const init = untrack(() => props.initial);
  const [on, setOn] = createSignal(init.hyphenate);
  const [h, setH] = createSignal<Hyphenation>(init.hyphenation);
  const set = (patch: Partial<Hyphenation>) => setH((x) => ({ ...x, ...patch }));
  const row = (label: string, key: "minWord" | "afterFirst" | "beforeLast" | "limit", unit: string, min: number, max: number) => (
    <label class="flex items-center gap-2">
      <span class="w-32">{label}</span>
      {num({ value: h()[key], testId: `hyphen-${key}`, min, max, onChange: (v) => set({ [key]: Math.round(v) }) })}
      <span class="text-dim">{unit}</span>
    </label>
  );
  return (
    <Dialog title="Hyphenation" testId="hyphenation" onCancel={props.onCancel} onOk={() => props.onOk({ hyphenate: on(), hyphenation: h() })}>
      <label class="flex items-center gap-1.5">
        <input type="checkbox" data-testid="hyphen-on" checked={on()} onChange={(e) => setOn(e.currentTarget.checked)} />
        <span>Hyphenate</span>
      </label>
      <fieldset class="space-y-1.5" disabled={!on()}>
        {row("Words Longer Than:", "minWord", "letters", 2, 25)}
        {row("After First:", "afterFirst", "letters", 1, 15)}
        {row("Before Last:", "beforeLast", "letters", 1, 15)}
        {row("Hyphen Limit:", "limit", "hyphens", 0, 25)}
        <label class="flex items-center gap-2">
          <span class="w-32">Hyphenation Zone:</span>
          <Field
            type="text"
            class="w-20 text-right"
            data-testid="hyphen-zone"
            value={props.zoneLabel(h().zone)}
            onChange={(e) => {
              const v = props.parseZone(e.currentTarget.value);
              if (v !== null) set({ zone: v });
            }}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </label>
        <label class="flex items-center gap-1.5">
          <input type="checkbox" data-testid="hyphen-capitalized" checked={h().capitalized} onChange={(e) => set({ capitalized: e.currentTarget.checked })} />
          <span>Hyphenate Capitalized Words</span>
        </label>
      </fieldset>
    </Dialog>
  );
}
