import { For, Match, Show, Switch, useContext } from "solid-js";
import type { BrushSettings } from "../core/brush";
import type { SelectionMode } from "../core/selection";
import type { TransformState } from "../core/transform";
import { AppContext } from "./context";
import { IconButton, NumberField, Separator } from "./controls";

const MODES: readonly { mode: SelectionMode; label: string; glyph: string }[] = [
  { mode: "replace", label: "New selection", glyph: "▢" },
  { mode: "add", label: "Add to selection (Shift)", glyph: "⧉" },
  { mode: "subtract", label: "Subtract from selection (Alt)", glyph: "◪" },
  { mode: "intersect", label: "Intersect with selection (Shift+Alt)", glyph: "◫" },
];

const pct = (v: number) => Math.round(v * 100);

function BrushOptions(props: { which: "brush" | "eraser" }) {
  const { editor } = useContext(AppContext);
  const b = () => editor.settings[props.which];
  const set = (patch: Partial<BrushSettings>) =>
    editor.setSettings((s) => {
      Object.assign(s[props.which], patch);
    });
  return (
    <>
      <NumberField label="Size" testId="brush-size" value={b().size} min={1} max={2500} suffix="px" onChange={(size) => set({ size })} />
      <NumberField label="Hardness" value={pct(b().hardness)} min={0} max={100} suffix="%" onChange={(v) => set({ hardness: v / 100 })} />
      <Separator />
      <NumberField label="Opacity" testId="brush-opacity" value={pct(b().opacity)} min={1} max={100} suffix="%" onChange={(v) => set({ opacity: v / 100 })} />
      <NumberField label="Flow" value={pct(b().flow)} min={1} max={100} suffix="%" onChange={(v) => set({ flow: v / 100 })} />
      <label class="flex items-center gap-1">
        <input type="checkbox" checked={b().pressureSize} onChange={(e) => set({ pressureSize: e.currentTarget.checked })} />
        <span>Pressure → size</span>
      </label>
    </>
  );
}

function SelectionOptions(props: { tolerance: boolean }) {
  const { editor } = useContext(AppContext);
  return (
    <>
      <div class="flex gap-0.5" role="radiogroup" aria-label="Selection mode">
        <For each={MODES}>
          {(m) => (
            <button
              type="button"
              title={m.label}
              aria-pressed={editor.settings.selectionMode === m.mode ? "true" : "false"}
              class={["grid size-6 place-items-center rounded-sm text-sm hover:bg-raised", { "bg-accent-soft": editor.settings.selectionMode === m.mode }]}
              onClick={() => editor.setSettings((s) => void (s.selectionMode = m.mode))}
            >
              {m.glyph}
            </button>
          )}
        </For>
      </div>
      <Show when={props.tolerance}>
        <Separator />
        <ToleranceOptions />
      </Show>
    </>
  );
}

function ToleranceOptions() {
  const { editor } = useContext(AppContext);
  return (
    <>
      <NumberField label="Tolerance" value={editor.settings.tolerance} min={0} max={255} onChange={(v) => editor.setSettings((s) => void (s.tolerance = v))} />
      <label class="flex items-center gap-1">
        <input
          type="checkbox"
          checked={editor.settings.contiguous}
          onChange={(e) => {
            const v = e.currentTarget.checked;
            editor.setSettings((s) => void (s.contiguous = v));
          }}
        />
        <span>Contiguous</span>
      </label>
    </>
  );
}

function TransformOptions(props: { state: TransformState }) {
  const { editor } = useContext(AppContext);
  const set = (patch: Partial<TransformState>) => editor.setTransform({ ...props.state, ...patch });
  return (
    <>
      <NumberField label="X" value={Math.round(props.state.cx)} min={-1e5} max={1e5} suffix="px" onChange={(cx) => set({ cx })} />
      <NumberField label="Y" value={Math.round(props.state.cy)} min={-1e5} max={1e5} suffix="px" onChange={(cy) => set({ cy })} />
      <NumberField label="W" value={pct(props.state.sx)} min={-10000} max={10000} suffix="%" onChange={(v) => set({ sx: v / 100 || 0.01 })} />
      <NumberField label="H" value={pct(props.state.sy)} min={-10000} max={10000} suffix="%" onChange={(v) => set({ sy: v / 100 || 0.01 })} />
      <NumberField
        label="Angle"
        value={Math.round(((props.state.angle * 180) / Math.PI) * 10) / 10}
        min={-360}
        max={360}
        step={0.1}
        suffix="°"
        onChange={(deg) => set({ angle: (deg * Math.PI) / 180 })}
      />
      <Separator />
      <IconButton icon="check" title="Commit transform (Enter)" testId="transform-commit" onClick={() => editor.commitTool()} />
      <IconButton icon="x" title="Cancel transform (Esc)" testId="transform-cancel" onClick={() => editor.cancelTool()} />
    </>
  );
}

export function OptionsBar() {
  const { editor } = useContext(AppContext);
  const transform = () => {
    const o = editor.active()?.overlay();
    return o?.kind === "transform" ? o.state : null;
  };
  return (
    <div class="flex h-9 items-center gap-3 border-b border-line bg-panel px-3" data-testid="options-bar">
      <Switch fallback={<span class="text-dim">{editor.tool() === "move" ? "Drag to move the selection or layer." : ""}</span>}>
        <Match when={editor.tool() === "brush"}>
          <BrushOptions which="brush" />
        </Match>
        <Match when={editor.tool() === "eraser"}>
          <BrushOptions which="eraser" />
        </Match>
        <Match when={["marquee-rect", "marquee-ellipse", "lasso"].includes(editor.tool())}>
          <SelectionOptions tolerance={false} />
        </Match>
        <Match when={editor.tool() === "wand"}>
          <SelectionOptions tolerance={true} />
        </Match>
        <Match when={editor.tool() === "bucket"}>
          <ToleranceOptions />
        </Match>
        <Match when={transform()}>{(s) => <TransformOptions state={s()} />}</Match>
      </Switch>
    </div>
  );
}
