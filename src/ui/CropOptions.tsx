import type { JSX } from "@solidjs/web";
import { For, Show, createSignal, useContext } from "solid-js";
import { BLACK, type RGB } from "../core/color";
import { CROP_OVERLAYS, CROP_PRESETS, formatLength, parseLength, type CropConstraint, type CropUnit, type Length } from "../core/crop";
import { resolutionOf } from "../core/document";
import type { CropSettings, PerspectiveCropSettings } from "../editor/types";
import { ColorPicker } from "./ColorPicker";
import { AppContext } from "./context";
import { Field, IconButton, NumberField, Separator } from "./controls";
import { Popover } from "./Popover";

/** A text field for a crop length ("4 in", "1200 px", or a plain ratio term); blank means unset. */
function LengthField(props: { label: string; testId: string; value: Length | null; ratio: boolean; onChange: (v: Length | null) => void }) {
  const text = () => (!props.value ? "" : props.ratio ? String(props.value.value) : formatLength(props.value.value, props.value.unit));
  return (
    <Field
      type="text"
      aria-label={props.label}
      placeholder={props.label}
      data-testid={props.testId}
      class="w-20 text-right"
      value={text()}
      onChange={(e) => {
        const raw = e.currentTarget.value.trim();
        const v = raw === "" ? null : parseLength(raw, props.value?.unit ?? "pixels");
        if (raw !== "" && !v) e.currentTarget.value = text();
        else props.onChange(v && (props.ratio ? { value: v.value, unit: "pixels" } : v));
      }}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}

/** A small menu of options, opened from an options-bar button. */
function OptionsMenu(props: { icon: "grid" | "gear"; title: string; testId: string; children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  let button!: HTMLDivElement;
  return (
    <div class="relative" ref={button}>
      <IconButton icon={props.icon} title={props.title} testId={props.testId} active={open()} onClick={() => setOpen((o) => !o)} />
      <Popover open={open()} onClose={() => setOpen(false)} trigger={() => button} class="top-full left-0 mt-1" testId={`${props.testId}-menu`}>
        <div class="flex min-w-60 flex-col gap-1 rounded-sm border border-line bg-panel-2 p-2 shadow-xl">{props.children}</div>
      </Popover>
    </div>
  );
}

function Check(props: { label: string; checked: boolean; testId?: string; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label class="flex items-center gap-1.5 whitespace-nowrap">
      <input type="checkbox" data-testid={props.testId} checked={props.checked} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      <span>{props.label}</span>
      <Show when={props.hint}>
        <span class="ml-auto pl-3 text-dim">{props.hint}</span>
      </Show>
    </label>
  );
}

const sameLength = (a: Length | null, b: Length | null) => a?.value === b?.value && a?.unit === b?.unit;
const sameConstraint = (a: CropConstraint, b: CropConstraint) =>
  a.mode === b.mode && sameLength(a.width, b.width) && sameLength(a.height, b.height) && a.resolution === b.resolution;

/** Pixels per inch or per centimetre, Photoshop's resolution units. */
function ResolutionField(props: { value: number | null; testId: string; onChange: (ppi: number | null) => void }) {
  const [perCm, setPerCm] = createSignal(false);
  const shown = () => (props.value === null ? "" : String(Math.round((perCm() ? props.value / 2.54 : props.value) * 100) / 100));
  return (
    <div class="flex items-center gap-1">
      <Field
        type="text"
        aria-label="Resolution"
        placeholder="Resolution"
        data-testid={props.testId}
        class="w-16 text-right"
        value={shown()}
        onChange={(e) => {
          const raw = e.currentTarget.value.trim();
          const v = Number(raw);
          if (raw === "") props.onChange(null);
          else if (v > 0) props.onChange(perCm() ? v * 2.54 : v);
          else e.currentTarget.value = shown();
        }}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <select value={perCm() ? "cm" : "in"} onChange={(e) => setPerCm(e.currentTarget.value === "cm")}>
        <option value="in">px/in</option>
        <option value="cm">px/cm</option>
      </select>
    </div>
  );
}

/**
 * The Crop tool's options bar, as Photoshop's: the ratio/size menu and
 * fields (⇄ swaps, Clear empties), Straighten, the overlay and settings
 * menus, Delete Cropped Pixels, and cancel/commit.
 */
export function CropOptions() {
  const { editor } = useContext(AppContext);
  const c = () => editor.settings.crop;
  const set = (fn: (x: { -readonly [K in keyof CropSettings]: CropSettings[K] }) => void) => editor.setSettings((s) => fn(s.crop));
  const setConstraint = (constraint: CropConstraint) => set((x) => void (x.constraint = constraint));
  const [presetsOpen, setPresetsOpen] = createSignal(false);
  let presetButton!: HTMLButtonElement;

  const doc = () => editor.active()?.doc();
  const frontImage = (): CropConstraint | null => {
    const d = doc();
    return d ? { mode: "size", width: { value: d.width, unit: "pixels" }, height: { value: d.height, unit: "pixels" }, resolution: resolutionOf(d) } : null;
  };
  const presetLabel = () => {
    const k = c().constraint;
    const p = CROP_PRESETS.find((p) => sameConstraint(p.constraint, k));
    return p ? p.label : k.mode === "ratio" ? "Ratio" : "W x H x Resolution";
  };
  const choose = (constraint: CropConstraint | null) => {
    if (constraint) setConstraint(constraint);
    setPresetsOpen(false);
  };
  const item = (label: string, constraint: () => CropConstraint | null) => (
    <button type="button" role="menuitem" class="px-4 py-1 text-left hover:bg-accent hover:text-white" onClick={() => choose(constraint())}>
      {label}
    </button>
  );
  const ratioPresets = CROP_PRESETS.filter((p) => p.constraint.mode === "ratio");
  const sizePresets = CROP_PRESETS.filter((p) => p.constraint.mode === "size");
  const isRatio = () => c().constraint.mode === "ratio";

  return (
    <>
      <div class="relative">
        <button
          ref={presetButton}
          type="button"
          data-testid="crop-preset"
          class="flex min-w-36 items-center justify-between gap-2 rounded-sm border border-line px-2 py-0.5 hover:bg-raised"
          onClick={() => setPresetsOpen((o) => !o)}
        >
          <span>{presetLabel()}</span>
          <span class="text-dim">▾</span>
        </button>
        <Popover open={presetsOpen()} onClose={() => setPresetsOpen(false)} trigger={() => presetButton} class="top-full left-0 mt-1" testId="crop-preset-menu">
          <div class="flex min-w-56 flex-col rounded-sm border border-line bg-panel-2 py-1 shadow-xl" role="menu">
            {item("Ratio", () => ({ ...c().constraint, mode: "ratio", resolution: null }))}
            {item("W x H x Resolution", () => ({ ...c().constraint, mode: "size" }))}
            {item("Original Ratio", () => {
              const d = doc();
              return d ? { mode: "ratio", width: { value: d.width, unit: "pixels" }, height: { value: d.height, unit: "pixels" }, resolution: null } : null;
            })}
            <div class="my-1 h-px bg-line" />
            <For each={ratioPresets}>{(p) => item(p.label, () => p.constraint)}</For>
            {item("Front Image", frontImage)}
            <div class="my-1 h-px bg-line" />
            <For each={sizePresets}>{(p) => item(p.label, () => p.constraint)}</For>
          </div>
        </Popover>
      </div>
      <LengthField
        label={isRatio() ? "Ratio W" : "Width"}
        testId="crop-width"
        ratio={isRatio()}
        value={c().constraint.width}
        onChange={(width) => setConstraint({ ...c().constraint, width })}
      />
      <IconButton icon="swap" title="Swap height and width (X)" testId="crop-swap" onClick={() => editor.rotateCropBox()} />
      <LengthField
        label={isRatio() ? "Ratio H" : "Height"}
        testId="crop-height"
        ratio={isRatio()}
        value={c().constraint.height}
        onChange={(height) => setConstraint({ ...c().constraint, height })}
      />
      <Show when={!isRatio()}>
        <ResolutionField
          testId="crop-resolution"
          value={c().constraint.resolution}
          onChange={(resolution) => setConstraint({ ...c().constraint, resolution })}
        />
      </Show>
      <button
        type="button"
        data-testid="crop-clear"
        class="rounded-sm border border-line px-2 py-0.5 hover:bg-raised"
        onClick={() => setConstraint({ ...c().constraint, width: null, height: null, resolution: null })}
      >
        Clear
      </button>
      <Separator />
      <IconButton
        icon="straighten"
        title="Straighten: draw a line to straighten the image (hold Ctrl). Double-click to reset."
        testId="crop-straighten"
        active={c().straighten}
        onClick={(e) => (e.detail >= 2 ? editor.cancelTool() : set((x) => void (x.straighten = !x.straighten)))}
      />
      <OptionsMenu icon="grid" title="Set the overlay options for the Crop Tool" testId="crop-overlay">
        <For each={CROP_OVERLAYS}>
          {(o) => (
            <label class="flex items-center gap-1.5">
              <input
                type="radio"
                name="crop-overlay"
                checked={c().overlay === o.id}
                onChange={() => set((x) => void ((x.overlay = o.id), (x.orientation = 0)))}
              />
              <span>{o.label}</span>
            </label>
          )}
        </For>
        <div class="my-1 h-px bg-line" />
        <For
          each={
            [
              ["always", "Always Show Overlay"],
              ["auto", "Auto Show Overlay"],
              ["never", "Never Show Overlay"],
            ] as const
          }
        >
          {([id, label]) => (
            <label class="flex items-center gap-1.5">
              <input type="radio" name="crop-show-overlay" checked={c().showOverlay === id} onChange={() => set((x) => void (x.showOverlay = id))} />
              <span>{label}</span>
            </label>
          )}
        </For>
        <div class="my-1 h-px bg-line" />
        <p class="text-dim">Cycle Overlay: O · Cycle Orientation: Shift+O</p>
      </OptionsMenu>
      <OptionsMenu icon="gear" title="Set additional Crop options" testId="crop-settings">
        <Check label="Use Classic Mode" hint="P" testId="crop-classic" checked={c().classic} onChange={(v) => set((x) => void (x.classic = v))} />
        <Check label="Show Cropped Area" hint="H" testId="crop-show-cropped" checked={c().showCropped} onChange={(v) => set((x) => void (x.showCropped = v))} />
        <Show when={!c().classic}>
          <Check label="Auto Center Preview" testId="crop-auto-center" checked={c().autoCenter} onChange={(v) => set((x) => void (x.autoCenter = v))} />
        </Show>
        <Check label="Enable Crop Shield" testId="crop-shield" checked={c().shield} onChange={(v) => set((x) => void (x.shield = v))} />
        <Show when={c().shield}>
          <ShieldColor color={c().shieldColor} onChange={(shieldColor) => set((x) => void (x.shieldColor = shieldColor))} />
          <NumberField
            label="Opacity"
            testId="crop-shield-opacity"
            value={Math.round(c().shieldOpacity * 100)}
            min={0}
            max={100}
            suffix="%"
            onChange={(v) => set((x) => void (x.shieldOpacity = v / 100))}
          />
          <Check label="Auto Adjust Opacity" checked={c().autoAdjustOpacity} onChange={(v) => set((x) => void (x.autoAdjustOpacity = v))} />
        </Show>
      </OptionsMenu>
      <Separator />
      <Check label="Delete Cropped Pixels" testId="crop-delete-pixels" checked={c().deletePixels} onChange={(v) => set((x) => void (x.deletePixels = v))} />
      <CommitButtons />
    </>
  );
}

/** The shield's colour: the canvas's (workspace) colour, or a custom one. */
function ShieldColor(props: { color: RGB | null; onChange: (c: RGB | null) => void }) {
  const [open, setOpen] = createSignal(false);
  let button!: HTMLButtonElement;
  return (
    <div class="relative flex items-center gap-1.5">
      <span class="text-dim">Color:</span>
      <select value={props.color ? "custom" : "canvas"} onChange={(e) => props.onChange(e.currentTarget.value === "canvas" ? null : (props.color ?? BLACK))}>
        <option value="canvas">Match Canvas</option>
        <option value="custom">Custom</option>
      </select>
      <Show when={props.color}>
        {(c) => (
          <>
            <button
              ref={button}
              type="button"
              title="Shield color"
              class="size-5 rounded-xs border border-white/50"
              style={{ "background-color": `rgb(${c().r} ${c().g} ${c().b})` }}
              onClick={() => setOpen((o) => !o)}
            />
            <Popover open={open()} onClose={() => setOpen(false)} trigger={() => button} class="top-full left-0 mt-1">
              <ColorPicker title="Shield color" initial={c()} onChange={(v) => props.onChange(v)} onClose={() => setOpen(false)} />
            </Popover>
          </>
        )}
      </Show>
    </div>
  );
}

function CommitButtons() {
  const { editor } = useContext(AppContext);
  return (
    <div class="ml-auto flex gap-1">
      <IconButton icon="x" title="Cancel current crop operation (Esc)" testId="crop-cancel" onClick={() => editor.cancelTool()} />
      <IconButton icon="check" title="Commit current crop operation (Enter)" testId="crop-commit" onClick={() => editor.commitTool()} />
    </div>
  );
}

/** The Perspective Crop tool's options: W/H/Resolution (blank: estimated from the perspective), Front Image, Clear, Show Grid. */
export function PerspectiveCropOptions() {
  const { editor } = useContext(AppContext);
  const o = () => editor.settings.perspectiveCrop;
  const set = (patch: Partial<PerspectiveCropSettings>) => editor.setSettings((s) => void Object.assign(s.perspectiveCrop, patch));
  const unit = (): CropUnit => o().width?.unit ?? o().height?.unit ?? "pixels";
  return (
    <>
      <LengthField label="Width" testId="pcrop-width" ratio={false} value={o().width} onChange={(width) => set({ width })} />
      <IconButton icon="swap" title="Swap height and width" onClick={() => set({ width: o().height, height: o().width })} />
      <LengthField label="Height" testId="pcrop-height" ratio={false} value={o().height} onChange={(height) => set({ height })} />
      <ResolutionField testId="pcrop-resolution" value={o().resolution} onChange={(resolution) => set({ resolution })} />
      <button
        type="button"
        class="rounded-sm border border-line px-2 py-0.5 hover:bg-raised"
        data-testid="pcrop-front"
        title={`Use the front image's size and resolution (${unit()})`}
        onClick={() => {
          const d = editor.active()?.doc();
          if (d) set({ width: { value: d.width, unit: "pixels" }, height: { value: d.height, unit: "pixels" }, resolution: resolutionOf(d) });
        }}
      >
        Front Image
      </button>
      <button
        type="button"
        class="rounded-sm border border-line px-2 py-0.5 hover:bg-raised"
        data-testid="pcrop-clear"
        onClick={() => set({ width: null, height: null, resolution: null })}
      >
        Clear
      </button>
      <Separator />
      <Check label="Show Grid" checked={o().showGrid} onChange={(showGrid) => set({ showGrid })} />
      <CommitButtons />
    </>
  );
}
