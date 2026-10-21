import { For, Match, Show, Switch, createSignal, useContext } from "solid-js";
import type { BrushSettings } from "../core/brush";
import { BLACK, toHex, type RGB } from "../core/color";
import { activeLayer } from "../core/document";
import type { StrokeAlign } from "../core/shape";
import { SHAPE_TOOLS } from "../editor/tools";
import type { ShapeOptionsPatch, ShapeSettings, ShapeStroke } from "../editor/types";
import { ColorPicker } from "./ColorPicker";
import { Popover } from "./Popover";
import type { SelectionMode } from "../core/selection";
import type { Filter } from "../core/rasterize";
import { locatorPoint, numeric, withNumeric, type NumericTransform, type TransformMode, type TransformState } from "../core/transform";
import { AppContext } from "./context";
import { IconButton, NumberField, Separator } from "./controls";
import { CropOptions, PerspectiveCropOptions } from "./CropOptions";

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

function ReferenceLocator(props: { state: TransformState }) {
  const { editor } = useContext(AppContext);
  const show = () => editor.settings.transform.showReference;
  return (
    <div class="flex items-center gap-1.5">
      <input
        type="checkbox"
        title="Toggle reference point"
        data-testid="toggle-reference"
        checked={show()}
        onChange={(e) => {
          const v = e.currentTarget.checked;
          editor.setSettings((s) => void (s.transform.showReference = v));
        }}
      />
      <div class={["grid grid-cols-3 gap-px", { "opacity-40": !show() }]} title="Reference point location">
        <For each={[0, 1, 2, 3, 4, 5, 6, 7, 8]}>
          {(i) => (
            <button
              type="button"
              aria-label={`Reference point ${i}`}
              disabled={!show()}
              class="size-2 border border-fg/60 hover:bg-fg"
              onClick={() => editor.setTransform({ ...props.state, reference: locatorPoint(props.state, i % 3, Math.floor(i / 3)) })}
            />
          )}
        </For>
      </div>
    </div>
  );
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function TransformOptions(props: { state: TransformState; mode: TransformMode }) {
  const { editor } = useContext(AppContext);
  const n = () => numeric(props.state);
  const set = (patch: Partial<NumericTransform>) => editor.setTransform(withNumeric(props.state, patch));
  const link = () => editor.settings.transform.link;
  const warp = () => props.mode === "warp";
  return (
    <>
      <Show when={!warp()}>
        <ReferenceLocator state={props.state} />
        <Separator />
        <NumberField label="X" testId="transform-x" value={round1(n().x)} min={-1e5} max={1e5} step={0.1} suffix="px" onChange={(x) => set({ x })} />
        <NumberField label="Y" testId="transform-y" value={round1(n().y)} min={-1e5} max={1e5} step={0.1} suffix="px" onChange={(y) => set({ y })} />
        <Separator />
        <NumberField
          label="W"
          testId="transform-w"
          value={round1(n().w)}
          min={-1e5}
          max={1e5}
          step={0.1}
          suffix="%"
          onChange={(w) => set(link() ? { w, h: (n().h * w) / n().w } : { w })}
        />
        <button
          type="button"
          title="Maintain aspect ratio"
          data-testid="transform-link"
          aria-pressed={link() ? "true" : "false"}
          class={["rounded-sm px-1 text-sm", link() ? "text-accent" : "text-dim"]}
          onClick={() => editor.setSettings((s) => void (s.transform.link = !s.transform.link))}
        >
          ⛓
        </button>
        <NumberField
          label="H"
          testId="transform-h"
          value={round1(n().h)}
          min={-1e5}
          max={1e5}
          step={0.1}
          suffix="%"
          onChange={(h) => set(link() ? { h, w: (n().w * h) / n().h } : { h })}
        />
        <Separator />
        <NumberField label="∠" testId="transform-angle" value={round1(n().angle)} min={-3600} max={3600} step={0.1} suffix="°" onChange={(angle) => set({ angle })} />
        <NumberField label="H" testId="transform-hskew" value={round1(n().hSkew)} min={-89} max={89} step={0.1} suffix="°" onChange={(hSkew) => set({ hSkew })} />
        <NumberField label="V" testId="transform-vskew" value={round1(n().vSkew)} min={-89} max={89} step={0.1} suffix="°" onChange={(vSkew) => set({ vSkew })} />
        <Separator />
      </Show>
      <label class="flex items-center gap-1">
        <span class="text-dim">Interpolation:</span>
        <select
          value={editor.settings.transform.interpolation}
          onChange={(e) => {
            const v = e.currentTarget.value as Filter;
            editor.setSettings((s) => void (s.transform.interpolation = v));
          }}
        >
          <option value="bicubic">Bicubic</option>
          <option value="bilinear">Bilinear</option>
          <option value="nearest">Nearest Neighbor</option>
        </select>
      </label>
      <button
        type="button"
        title="Switch between free transform and warp modes"
        data-testid="transform-warp"
        aria-pressed={warp() ? "true" : "false"}
        class={["rounded-sm border border-line px-2 py-0.5", warp() ? "bg-accent-soft text-white" : "hover:bg-raised"]}
        onClick={() => editor.setTransformMode(warp() ? "free" : "warp")}
      >
        Warp
      </button>
      <div class="ml-auto flex gap-1">
        <IconButton icon="x" title="Cancel transform (Esc)" testId="transform-cancel" onClick={() => editor.cancelTool()} />
        <IconButton icon="check" title="Commit transform (Enter)" testId="transform-commit" onClick={() => editor.commitTool()} />
      </div>
    </>
  );
}

/** A fill/stroke swatch: a colour, or Photoshop's red slash for "none". Opens a picker with a No Color option. */
function Swatch(props: { title: string; testId: string; color: RGB | null; onChange: (c: RGB | null) => void }) {
  const [open, setOpen] = createSignal(false);
  let button!: HTMLButtonElement;
  return (
    <div class="relative flex items-center gap-1">
      <span class="text-dim">{props.title}:</span>
      <button
        ref={button}
        type="button"
        title={props.title}
        data-testid={props.testId}
        data-color={props.color ? toHex(props.color) : "none"}
        aria-expanded={open() ? "true" : "false"}
        class="relative size-5 overflow-hidden rounded-xs border border-white/50"
        style={{ "background-color": props.color ? toHex(props.color) : "white" }}
        onClick={() => setOpen((o) => !o)}
      >
        <Show when={!props.color}>
          <span class="absolute top-1/2 left-1/2 h-px w-7 -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-red-600" />
        </Show>
      </button>
      <Popover open={open()} onClose={() => setOpen(false)} trigger={() => button} class="top-full left-0 mt-1" testId={`${props.testId}-popover`}>
        <ColorPicker
          title={props.title}
          initial={props.color ?? BLACK}
          onChange={(c) => props.onChange(c)}
          onClose={() => setOpen(false)}
          onNone={() => {
            props.onChange(null);
            setOpen(false);
          }}
        />
      </Popover>
    </div>
  );
}

/**
 * Shape tool options. With a shape layer selected they show (and edit) that
 * layer's properties, as Photoshop's options bar does.
 */
function ShapeOptions() {
  const { editor } = useContext(AppContext);
  const o = () => editor.settings.shape;
  const layer = () => {
    const d = editor.active()?.doc();
    const l = d && activeLayer(d);
    return l?.content.kind === "shape" ? l.content : null;
  };
  const fill = (): RGB | null => {
    if (layer()) return layer()!.style.fill;
    const f = o().fill;
    return f === "foreground" ? editor.foreground() : f;
  };
  const radius = () => {
    const g = layer()?.geometry;
    return g?.kind === "rectangle" ? g.radius : o().radius;
  };
  const stroke = () => (layer() ? layer()!.style.stroke : o().stroke);
  const set = (patch: ShapeOptionsPatch) => editor.setShapeOptions(patch);
  // Only the changed property: the editor applies it to the latest stroke (edits may still be in flight).
  const strokeWith = (patch: Partial<ShapeStroke>) => set({ stroke: patch });
  const tool = () => editor.tool();
  return (
    <>
      <select
        data-testid="shape-mode"
        value={o().mode}
        onChange={(e) => {
          const mode = e.currentTarget.value as ShapeSettings["mode"];
          editor.setSettings((s) => void (s.shape.mode = mode));
        }}
      >
        <option value="shape">Shape</option>
        <option value="pixels">Pixels</option>
      </select>
      <Show when={o().mode === "shape"}>
        <Swatch title="Fill" testId="shape-fill" color={fill()} onChange={(fill) => set({ fill })} />
        <Swatch title="Stroke" testId="shape-stroke" color={stroke()?.color ?? null} onChange={(c) => (c ? strokeWith({ color: c }) : set({ stroke: null }))} />
        <NumberField label="Width" testId="shape-stroke-width" value={stroke()?.width ?? 3} min={0} max={1000} step={0.5} suffix="px" onChange={(width) => strokeWith({ width })} />
        <select
          title="Stroke alignment"
          data-testid="shape-stroke-align"
          value={stroke()?.align ?? "inside"}
          onChange={(e) => strokeWith({ align: e.currentTarget.value as StrokeAlign })}
        >
          <option value="inside">Inside</option>
          <option value="center">Center</option>
          <option value="outside">Outside</option>
        </select>
        <Separator />
      </Show>
      <Switch>
        <Match when={tool() === "rectangle"}>
          <NumberField label="Radius" testId="shape-radius" value={radius()} min={0} max={10000} suffix="px" onChange={(radius) => set({ radius })} />
        </Match>
        <Match when={tool() === "polygon"}>
          <NumberField label="Sides" testId="shape-sides" value={o().sides} min={3} max={100} onChange={(sides) => set({ sides })} />
          <NumberField label="Star Ratio" testId="shape-star" value={Math.round(o().starRatio * 100)} min={1} max={100} suffix="%" onChange={(v) => set({ starRatio: v / 100 })} />
        </Match>
        <Match when={tool() === "line"}>
          <NumberField label="Weight" testId="shape-weight" value={o().weight} min={1} max={1000} suffix="px" onChange={(weight) => set({ weight })} />
        </Match>
      </Switch>
    </>
  );
}

function MoveOptions() {
  const { editor } = useContext(AppContext);
  return (
    <label class="flex items-center gap-1.5">
      <input
        type="checkbox"
        data-testid="show-transform-controls"
        checked={editor.settings.transform.showControls}
        onChange={(e) => {
          const v = e.currentTarget.checked;
          editor.setSettings((s) => void (s.transform.showControls = v));
        }}
      />
      <span>Show Transform Controls</span>
    </label>
  );
}

export function OptionsBar() {
  const { editor } = useContext(AppContext);
  const transform = () => {
    const o = editor.active()?.overlay();
    return o?.kind === "transform" ? o : null;
  };
  return (
    <div class="flex h-9 items-center gap-3 border-b border-line bg-panel px-3" data-testid="options-bar">
      <Switch>
        <Match when={transform()}>{(o) => <TransformOptions state={o().state} mode={o().mode} />}</Match>
        <Match when={editor.tool() === "move"}>
          <MoveOptions />
        </Match>
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
        <Match when={SHAPE_TOOLS.includes(editor.tool())}>
          <ShapeOptions />
        </Match>
        <Match when={editor.tool() === "bucket"}>
          <ToleranceOptions />
        </Match>
        <Match when={editor.tool() === "crop"}>
          <CropOptions />
        </Match>
        <Match when={editor.tool() === "perspective-crop"}>
          <PerspectiveCropOptions />
        </Match>
      </Switch>
    </div>
  );
}
