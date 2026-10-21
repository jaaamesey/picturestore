import { For, Show, createSignal, onSettled, untrack } from "solid-js";
import type { Filter } from "../core/rasterize";
import {
  FIT_PRESETS,
  LENGTH_UNITS,
  RESAMPLE_METHODS,
  display,
  fitTo,
  formatSize,
  fromPixels,
  initialState,
  isPhysical,
  ppiFrom,
  ppiTo,
  resampleFilter,
  setDimension,
  setResample,
  setResolutionValue,
  type LengthUnit,
  type Original,
  type ResolutionUnit,
  type SizeState,
} from "../editor/imageSize";
import { Button } from "./controls";

export interface ImageSizeResult {
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
  readonly resample: boolean;
  readonly filter: Filter;
  readonly scaleStyles: boolean;
}

const PREVIEW = 220;

type MethodId = (typeof RESAMPLE_METHODS)[number]["id"];

/**
 * Image ▸ Image Size (Alt+Ctrl+I), laid out as Photoshop's: a preview, the
 * size readout with Scale Styles under the gear, Dimensions, Fit To,
 * linked Width/Height in any unit, Resolution, and Resample with its method.
 */
export function ImageSizeDialog(props: {
  original: Original;
  preview: Promise<ImageData | null>;
  onApply: (r: ImageSizeResult) => void;
  onClose: () => void;
}) {
  const o = untrack(() => props.original);
  const [state, setStateSignal] = createSignal<SizeState>(initialState(o));
  // Read synchronously on OK (signal reads lag writes until Solid flushes).
  let current = untrack(state);
  const set = (s: SizeState) => {
    current = s;
    setStateSignal(s);
    setPreset("custom");
  };
  const [widthUnit, setWidthUnit] = createSignal<LengthUnit>("pixels");
  const [heightUnit, setHeightUnit] = createSignal<LengthUnit>("pixels");
  const [dimUnit, setDimUnit] = createSignal<LengthUnit>("pixels");
  const [resUnit, setResUnit] = createSignal<ResolutionUnit>("ppi");
  const [method, setMethod] = createSignal<MethodId>("automatic");
  const [scaleStyles, setScaleStyles] = createSignal(true);
  const [gear, setGear] = createSignal(false);
  const [preset, setPreset] = createSignal<string>("original");
  let canvas!: HTMLCanvasElement;

  const value = (axis: "width" | "height", unit: LengthUnit) => display(fromPixels(state()[axis], unit, state().resolution, o[axis]), unit);
  const disabledUnit = (u: LengthUnit) => !state().resample && !isPhysical(u);

  const ok = () => {
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    props.onApply({
      width: current.width,
      height: current.height,
      resolution: current.resolution,
      resample: current.resample,
      filter: resampleFilter(method()),
      // As in Photoshop, styles only scale with proportions kept.
      scaleStyles: scaleStyles() && current.constrain,
    });
    props.onClose();
  };

  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
      else if (e.key === "Enter" && !(e.target instanceof HTMLSelectElement)) ok();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    void props.preview.then((img) => {
      if (!img || !canvas) return;
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext("2d")!.putImageData(img, 0, 0);
    });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });

  const unitSelect = (unit: () => LengthUnit, onUnit: (u: LengthUnit) => void, testId: string) => (
    <select data-testid={testId} value={unit()} onChange={(e) => onUnit(e.currentTarget.value as LengthUnit)}>
      <For each={LENGTH_UNITS}>
        {(u) => (
          <option value={u.id} disabled={disabledUnit(u.id)}>
            {u.label}
          </option>
        )}
      </For>
    </select>
  );

  const field = (axis: "width" | "height", unit: () => LengthUnit, testId: string) => (
    <input
      type="number"
      class="w-24 text-right"
      data-testid={testId}
      step="any"
      min="0"
      value={value(axis, unit())}
      disabled={disabledUnit(unit())}
      onChange={(e) => set(setDimension(current, axis, e.currentTarget.valueAsNumber, unit(), o))}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );

  return (
    <div class="fixed inset-0 z-50 grid place-items-center bg-black/50">
      <div class="flex gap-4 rounded-sm border border-line bg-panel p-4 shadow-2xl" role="dialog" aria-label="Image Size" data-testid="image-size">
        <div class="checkerboard grid shrink-0 place-items-center border border-line" style={{ width: `${PREVIEW}px`, height: `${PREVIEW}px` }}>
          <canvas ref={canvas} class="max-h-full max-w-full" style={{ "image-rendering": "auto" }} />
        </div>
        <div class="flex w-80 flex-col gap-2.5">
          <div class="relative flex items-center justify-between">
            <span>
              <span class="text-dim">Image Size: </span>
              <span data-testid="image-size-readout">
                {formatSize(state().width, state().height)}
                <Show when={state().width !== o.width || state().height !== o.height}> (was {formatSize(o.width, o.height)})</Show>
              </span>
            </span>
            <button type="button" title="Settings" data-testid="image-size-gear" class="rounded-sm px-1.5 hover:bg-raised" onClick={() => setGear((g) => !g)}>
              ⚙
            </button>
            <Show when={gear()}>
              <div class="absolute top-full right-0 z-10 mt-1 rounded-sm border border-line bg-panel-2 px-3 py-2 shadow-xl">
                <label class={["flex items-center gap-2", { "opacity-50": !state().constrain }]} title={state().constrain ? undefined : "Styles scale only when proportions are constrained"}>
                  <input
                    type="checkbox"
                    data-testid="image-size-scale-styles"
                    checked={scaleStyles() && state().constrain}
                    disabled={!state().constrain}
                    onChange={(e) => setScaleStyles(e.currentTarget.checked)}
                  />
                  Scale Styles
                </label>
              </div>
            </Show>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-dim">Dimensions:</span>
            <select value={dimUnit()} onChange={(e) => setDimUnit(e.currentTarget.value as LengthUnit)}>
              <For each={LENGTH_UNITS}>{(u) => <option value={u.id}>{u.label}</option>}</For>
            </select>
            <span data-testid="image-size-dimensions">
              {value("width", dimUnit())} × {value("height", dimUnit())} {dimUnit() === "percent" ? "%" : dimUnit() === "pixels" ? "px" : dimUnit()}
            </span>
          </div>
          <label class="flex items-center gap-2">
            <span class="w-20 text-dim">Fit To:</span>
            <select
              class="min-w-0 flex-1"
              data-testid="image-size-fit"
              value={preset()}
              onChange={(e) => {
                const v = e.currentTarget.value;
                const p = FIT_PRESETS.find((x) => x.label === v);
                const next = v === "original" ? initialState(o) : p ? fitTo(current, p, o) : current;
                current = next;
                setStateSignal(next);
                setPreset(v);
              }}
            >
              <option value="original">Original Size</option>
              <option value="custom" disabled hidden>
                Custom
              </option>
              <For each={FIT_PRESETS}>{(p) => <option value={p.label}>{p.label}</option>}</For>
            </select>
          </label>
          <div class="flex items-stretch gap-1">
            <div class="flex flex-1 flex-col gap-2">
              <div class="flex items-center gap-2">
                <span class="w-20 text-dim">Width:</span>
                {field("width", widthUnit, "image-size-width")}
                {unitSelect(widthUnit, setWidthUnit, "image-size-width-unit")}
              </div>
              <div class="flex items-center gap-2">
                <span class="w-20 text-dim">Height:</span>
                {field("height", heightUnit, "image-size-height")}
                {unitSelect(heightUnit, setHeightUnit, "image-size-height-unit")}
              </div>
            </div>
            <button
              type="button"
              title="Constrain aspect ratio"
              data-testid="image-size-link"
              aria-pressed={state().constrain ? "true" : "false"}
              disabled={!state().resample}
              class={["w-6 rounded-sm text-sm", state().constrain ? "text-accent" : "text-dim"]}
              onClick={() => set({ ...current, constrain: !current.constrain })}
            >
              ⛓
            </button>
          </div>
          <div class="flex items-center gap-2">
            <span class="w-20 text-dim">Resolution:</span>
            <input
              type="number"
              class="w-24 text-right"
              data-testid="image-size-resolution"
              step="any"
              min="0"
              value={Math.round(ppiTo(state().resolution, resUnit()) * 100) / 100}
              onChange={(e) => set(setResolutionValue(current, ppiFrom(e.currentTarget.valueAsNumber, resUnit())))}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <select value={resUnit()} onChange={(e) => setResUnit(e.currentTarget.value as ResolutionUnit)}>
              <option value="ppi">Pixels/Inch</option>
              <option value="ppcm">Pixels/Centimeter</option>
            </select>
          </div>
          <div class="flex items-center gap-2">
            <label class="flex w-20 items-center gap-1">
              <input type="checkbox" data-testid="image-size-resample" checked={state().resample} onChange={(e) => set(setResample(current, e.currentTarget.checked, o))} />
              <span>Resample:</span>
            </label>
            <select class="min-w-0 flex-1" data-testid="image-size-method" value={method()} disabled={!state().resample} onChange={(e) => setMethod(e.currentTarget.value as MethodId)}>
              <For each={RESAMPLE_METHODS}>{(m) => <option value={m.id}>{m.label}</option>}</For>
            </select>
          </div>
          <div class="mt-2 flex justify-end gap-2">
            <Button onClick={() => props.onClose()}>Cancel</Button>
            <Button primary testId="image-size-ok" onClick={ok}>
              OK
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
