import type { JSX } from "@solidjs/web";
import { For, Show, createSignal } from "solid-js";
import {
  HUE_RANGES,
  PHOTO_FILTERS,
  SELECTIVE_RANGES,
  parseCube,
  sampleCurve,
  sampleGradient,
  type Adjustment,
  type ChannelSet,
  type CurvePoint,
  type HueSatValues,
  type LevelsChannel,
  type MixerRow,
} from "../core/adjustments";
import { toHex, type RGB } from "../core/color";
import type { Histograms } from "../core/composite";
import { ColorPicker } from "./ColorPicker";
import { Field } from "./controls";
import { Popover } from "./Popover";

/**
 * The settings of each adjustment, laid out as in Photoshop's Properties
 * panel and adjustment dialogs. Every change produces new settings
 * (`onChange`); nothing is kept here but which channel/range is showing.
 */
export function AdjustmentEditor(props: { value: Adjustment; onChange: (a: Adjustment) => void; histogram?: Histograms | null }) {
  const set = <A extends Adjustment>(a: A, patch: Partial<A>) => props.onChange({ ...a, ...patch });
  return (
    <div class="space-y-2" data-testid="adjustment-editor" data-kind={props.value.kind}>
      {(() => {
        const a = props.value;
        switch (a.kind) {
          case "brightness-contrast":
            return (
              <>
                <Slider label="Brightness" value={a.brightness} min={a.legacy ? -100 : -150} max={a.legacy ? 100 : 150} onChange={(v) => set(a, { brightness: v })} />
                <Slider label="Contrast" value={a.contrast} min={a.legacy ? -100 : -50} max={100} onChange={(v) => set(a, { contrast: v })} />
                <Check label="Use Legacy" checked={a.legacy} onChange={(v) => set(a, { legacy: v })} />
              </>
            );
          case "levels":
            return <LevelsEditor value={a} onChange={props.onChange} histogram={props.histogram} />;
          case "curves":
            return <CurvesEditor value={a} onChange={props.onChange} histogram={props.histogram} />;
          case "exposure":
            return (
              <>
                <Slider label="Exposure" value={a.exposure} min={-20} max={20} step={0.01} onChange={(v) => set(a, { exposure: v })} />
                <Slider label="Offset" value={a.offset} min={-0.5} max={0.5} step={0.0001} onChange={(v) => set(a, { offset: v })} />
                <Slider label="Gamma Correction" value={a.gamma} min={0.01} max={9.99} step={0.01} onChange={(v) => set(a, { gamma: v })} />
              </>
            );
          case "vibrance":
            return (
              <>
                <Slider label="Vibrance" value={a.vibrance} min={-100} max={100} onChange={(v) => set(a, { vibrance: v })} />
                <Slider label="Saturation" value={a.saturation} min={-100} max={100} onChange={(v) => set(a, { saturation: v })} />
              </>
            );
          case "hue-saturation":
            return <HueSatEditor value={a} onChange={props.onChange} />;
          case "color-balance":
            return <ColorBalanceEditor value={a} onChange={props.onChange} />;
          case "black-white":
            return (
              <>
                <For keyed={false} each={["reds", "yellows", "greens", "cyans", "blues", "magentas"] as const}>
                  {(k) => <Slider label={title(k())} value={a[k()]} min={-200} max={300} suffix="%" onChange={(v) => set(a, { [k()]: v })} />}
                </For>
                <div class="flex items-center gap-3">
                  <Check label="Tint" checked={a.tint} onChange={(v) => set(a, { tint: v })} />
                  <Swatch title="Tint Color" color={a.tintColor} onChange={(c) => set(a, { tintColor: c })} />
                </div>
              </>
            );
          case "photo-filter":
            return (
              <>
                <label class="flex items-center gap-2">
                  <span class="w-20 text-dim">Filter:</span>
                  <select
                    class="min-w-0 flex-1"
                    data-testid="photo-filter-preset"
                    value={PHOTO_FILTERS.find((f) => sameColor(f.color, a.color))?.name ?? ""}
                    onChange={(e) => {
                      const f = PHOTO_FILTERS.find((x) => x.name === e.currentTarget.value);
                      if (f) set(a, { color: f.color });
                    }}
                  >
                    <option value="" disabled>
                      Custom
                    </option>
                    <For each={PHOTO_FILTERS}>{(f) => <option value={f.name}>{f.name}</option>}</For>
                  </select>
                  <Swatch title="Filter Color" color={a.color} onChange={(c) => set(a, { color: c })} />
                </label>
                <Slider label="Density" value={a.density} min={0} max={100} suffix="%" onChange={(v) => set(a, { density: v })} />
                <Check label="Preserve Luminosity" checked={a.preserveLuminosity} onChange={(v) => set(a, { preserveLuminosity: v })} />
              </>
            );
          case "channel-mixer":
            return <ChannelMixerEditor value={a} onChange={props.onChange} />;
          case "color-lookup":
            return <ColorLookupEditor value={a} onChange={props.onChange} />;
          case "invert":
            return <p class="text-dim">Invert has no settings.</p>;
          case "posterize":
            return <Slider label="Levels" value={a.levels} min={2} max={255} onChange={(v) => set(a, { levels: v })} />;
          case "threshold":
            return (
              <>
                <HistogramView histogram={props.histogram?.luminosity} marks={[a.level]} />
                <Slider label="Threshold Level" value={a.level} min={1} max={255} onChange={(v) => set(a, { level: v })} />
              </>
            );
          case "gradient-map":
            return <GradientMapEditor value={a} onChange={props.onChange} />;
          case "selective-color":
            return <SelectiveColorEditor value={a} onChange={props.onChange} />;
        }
      })()}
    </div>
  );
}


const title = (s: string) => s[0].toUpperCase() + s.slice(1);
const sameColor = (a: RGB, b: RGB) => a.r === b.r && a.g === b.g && a.b === b.b;
const CHANNELS = ["rgb", "red", "green", "blue"] as const;
type Channel = (typeof CHANNELS)[number];
const CHANNEL_LABELS: Record<Channel, string> = { rgb: "RGB", red: "Red", green: "Green", blue: "Blue" };

/** A labelled slider with a number field, as in Photoshop's adjustment panels. */
export function Slider(props: { label: string; value: number; min: number; max: number; step?: number; suffix?: string; onChange: (v: number) => void }) {
  const commit = (v: number) => Number.isFinite(v) && props.onChange(Math.min(props.max, Math.max(props.min, v)));
  const id = `slider-${props.label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return (
    <div class="space-y-0.5" data-testid={id}>
      <div class="flex items-center justify-between gap-2">
        <span>{props.label}:</span>
        <span class="flex items-center gap-1">
          <Field
            type="number"
            class="w-16 text-right"
            value={props.value}
            min={props.min}
            max={props.max}
            step={props.step ?? 1}
            onChange={(e) => commit(e.currentTarget.valueAsNumber)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          {props.suffix && <span class="text-dim">{props.suffix}</span>}
        </span>
      </div>
      <input
        type="range"
        class="w-full"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onInput={(e) => commit(e.currentTarget.valueAsNumber)}
      />
    </div>
  );
}

function Check(props: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label class="flex items-center gap-2">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      <span>{props.label}</span>
    </label>
  );
}

function Select<T extends string>(props: { label: string; value: T; options: readonly T[]; names?: Partial<Record<T, string>>; onChange: (v: T) => void; testId?: string }) {
  return (
    <label class="flex items-center gap-2">
      <span class="text-dim">{props.label}:</span>
      <select class="min-w-0 flex-1" data-testid={props.testId} value={props.value} onChange={(e) => props.onChange(e.currentTarget.value as T)}>
        <For each={props.options}>{(o) => <option value={o}>{props.names?.[o] ?? title(o)}</option>}</For>
      </select>
    </label>
  );
}

function Swatch(props: { title: string; color: RGB; onChange: (c: RGB) => void }) {
  const [open, setOpen] = createSignal(false);
  let button!: HTMLButtonElement;
  return (
    <span class="relative">
      <button
        ref={button}
        type="button"
        title={props.title}
        class="block size-5 rounded-xs border border-white/50"
        style={{ "background-color": toHex(props.color) }}
        onClick={() => setOpen((o) => !o)}
      />
      <Popover open={open()} onClose={() => setOpen(false)} trigger={() => button} class="top-full right-0 mt-1">
        <ColorPicker title={props.title} initial={props.color} onChange={props.onChange} onClose={() => setOpen(false)} />
      </Popover>
    </span>
  );
}

/** A histogram as a bar graph (0–255 left to right), with optional value marks. */
function HistogramView(props: { histogram?: Float64Array | null; marks?: readonly number[]; children?: JSX.Element }) {
  const path = () => {
    const h = props.histogram;
    if (!h) return "";
    // Scaled so one tall spike doesn't flatten the rest (as Photoshop does).
    const sorted = [...h].sort((a, b) => a - b);
    const top = Math.max(1, sorted[Math.floor(sorted.length * 0.98)] * 1.2);
    let d = "M0 100";
    for (let i = 0; i < 256; i++) d += `L${i} ${100 - Math.min(100, (h[i] / top) * 100)}L${i + 1} ${100 - Math.min(100, (h[i] / top) * 100)}`;
    return `${d}L256 100Z`;
  };
  return (
    <svg viewBox="0 0 256 100" preserveAspectRatio="none" class="h-20 w-full border border-line bg-app" data-testid="histogram">
      <path d={path()} fill="currentColor" class="text-dim" />
      <For each={props.marks ?? []}>{(m) => <line x1={m} x2={m} y1={0} y2={100} stroke="white" stroke-width="1" />}</For>
      {props.children}
    </svg>
  );
}

function LevelsEditor(props: { value: Extract<Adjustment, { kind: "levels" }>; onChange: (a: Adjustment) => void; histogram?: Histograms | null }) {
  const [channel, setChannel] = createSignal<Channel>("rgb");
  const c = () => props.value.channels[channel()];
  const set = (patch: Partial<LevelsChannel>) =>
    props.onChange({ ...props.value, channels: { ...props.value.channels, [channel()]: { ...c(), ...patch } } as ChannelSet<LevelsChannel> });
  // The gamma's slider sits where it maps mid-grey, between the black and white points.
  const midtone = () => c().inBlack + (c().inWhite - c().inBlack) * Math.pow(0.5, c().gamma);
  return (
    <>
      <Select label="Channel" value={channel()} options={CHANNELS} names={CHANNEL_LABELS} onChange={setChannel} testId="levels-channel" />
      <HistogramView histogram={props.histogram?.[channel()]} marks={[c().inBlack, midtone(), c().inWhite]} />
      <div class="flex justify-between gap-1">
        <NumberBox label="Input black" value={c().inBlack} min={0} max={c().inWhite - 2} onChange={(v) => set({ inBlack: v })} />
        <NumberBox label="Gamma" value={c().gamma} min={0.01} max={9.99} step={0.01} onChange={(v) => set({ gamma: v })} />
        <NumberBox label="Input white" value={c().inWhite} min={c().inBlack + 2} max={255} onChange={(v) => set({ inWhite: v })} />
      </div>
      <div class="text-dim">Output Levels:</div>
      <div class="flex justify-between gap-1">
        <NumberBox label="Output black" value={c().outBlack} min={0} max={255} onChange={(v) => set({ outBlack: v })} />
        <NumberBox label="Output white" value={c().outWhite} min={0} max={255} onChange={(v) => set({ outWhite: v })} />
      </div>
    </>
  );
}

function NumberBox(props: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <Field
      type="number"
      title={props.label}
      aria-label={props.label}
      data-testid={`levels-${props.label.toLowerCase().replace(" ", "-")}`}
      class="w-16 text-right"
      value={props.value}
      min={props.min}
      max={props.max}
      step={props.step ?? 1}
      onChange={(e) => {
        const v = e.currentTarget.valueAsNumber;
        if (Number.isFinite(v)) props.onChange(Math.min(props.max, Math.max(props.min, v)));
      }}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}

/**
 * Curves: click to add a point, drag points, drag a point off the graph to
 * remove it (the end points stay). Alt-click toggles a corner point.
 */
function CurvesEditor(props: { value: Extract<Adjustment, { kind: "curves" }>; onChange: (a: Adjustment) => void; histogram?: Histograms | null }) {
  const [channel, setChannel] = createSignal<Channel>("rgb");
  const points = () => props.value.channels[channel()];
  const setPoints = (p: readonly CurvePoint[]) => props.onChange({ ...props.value, channels: { ...props.value.channels, [channel()]: p } as ChannelSet<readonly CurvePoint[]> });
  const curve = () => {
    const c = sampleCurve(points(), 257);
    let d = "";
    for (let i = 0; i < c.length; i++) d += `${i ? "L" : "M"}${(i * 255) / 256} ${255 - c[i] * 255}`;
    return d;
  };
  let svg!: SVGSVGElement;
  const toCurve = (e: PointerEvent) => {
    const r = svg.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 255, y: 255 - ((e.clientY - r.top) / r.height) * 255 };
  };
  const clamp = (v: number) => Math.round(Math.min(255, Math.max(0, v)));
  const drag = (index: number, e: PointerEvent) => {
    svg.setPointerCapture(e.pointerId);
    let i = index;
    const move = (m: PointerEvent) => {
      const p = toCurve(m);
      const pts = [...points()];
      const ends = i === 0 || i === pts.length - 1;
      // Off the graph: removed (only interior points).
      if (!ends && (p.y < -20 || p.y > 275 || p.x < -20 || p.x > 275)) {
        if (pts.length > 2 && i >= 0) {
          pts.splice(i, 1);
          i = -1;
          setPoints(pts);
        }
        return;
      }
      if (i < 0) return;
      const lo = i > 0 ? pts[i - 1].x + 1 : 0, hi = i < pts.length - 1 ? pts[i + 1].x - 1 : 255;
      pts[i] = { ...pts[i], x: Math.min(hi, Math.max(lo, clamp(p.x))), y: clamp(p.y) };
      setPoints(pts);
    };
    const up = () => {
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerup", up);
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", up);
  };
  const down = (e: PointerEvent) => {
    const p = toCurve(e);
    const pts = points();
    const near = pts.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < 8);
    if (near >= 0) {
      if (e.altKey) return setPoints(pts.map((q, i) => (i === near ? { ...q, corner: !q.corner } : q)));
      return drag(near, e);
    }
    const x = clamp(p.x);
    if (pts.some((q) => q.x === x)) return;
    const added = [...pts, { x, y: clamp(p.y) }].sort((a, b) => a.x - b.x);
    setPoints(added);
    drag(added.findIndex((q) => q.x === x), e);
  };
  return (
    <>
      <Select label="Channel" value={channel()} options={CHANNELS} names={CHANNEL_LABELS} onChange={setChannel} testId="curves-channel" />
      <svg ref={svg} viewBox="0 0 255 255" class="aspect-square w-full cursor-crosshair touch-none border border-line bg-app" data-testid="curves-graph" onPointerDown={down}>
        <HistogramPath histogram={props.histogram?.[channel()]} />
        <For each={[64, 128, 192]}>
          {(v) => (
            <>
              <line x1={v} x2={v} y1={0} y2={255} stroke="currentColor" class="text-line" />
              <line y1={v} y2={v} x1={0} x2={255} stroke="currentColor" class="text-line" />
            </>
          )}
        </For>
        <line x1={0} y1={255} x2={255} y2={0} stroke="currentColor" class="text-line" />
        <path d={curve()} fill="none" stroke="white" stroke-width="1.5" />
        <For each={points()}>
          {(p) => <rect x={p.x - 3} y={255 - p.y - 3} width={6} height={6} fill={p.corner ? "white" : "none"} stroke="white" data-testid="curve-point" />}
        </For>
      </svg>
    </>
  );
}

function HistogramPath(props: { histogram?: Float64Array | null }) {
  const d = () => {
    const h = props.histogram;
    if (!h) return "";
    const sorted = [...h].sort((a, b) => a - b);
    const top = Math.max(1, sorted[Math.floor(sorted.length * 0.98)] * 1.2);
    let s = "M0 255";
    for (let i = 0; i < 256; i++) s += `L${i} ${255 - Math.min(255, (h[i] / top) * 255)}`;
    return `${s}L255 255Z`;
  };
  return <path d={d()} fill="currentColor" class="text-white/10" />;
}

function HueSatEditor(props: { value: Extract<Adjustment, { kind: "hue-saturation" }>; onChange: (a: Adjustment) => void }) {
  const [range, setRange] = createSignal<"master" | (typeof HUE_RANGES)[number]>("master");
  const a = () => props.value;
  const v = (): HueSatValues => (range() === "master" || a().colorize ? a().master : a().ranges[range() as (typeof HUE_RANGES)[number]]);
  const set = (patch: Partial<HueSatValues>) => {
    const r = range();
    if (r === "master" || a().colorize) props.onChange({ ...a(), master: { ...a().master, ...patch } });
    else props.onChange({ ...a(), ranges: { ...a().ranges, [r]: { ...a().ranges[r], ...patch } } });
  };
  return (
    <>
      <Show when={!a().colorize}>
        <Select label="Range" value={range()} options={["master", ...HUE_RANGES] as const} onChange={setRange} testId="hue-range" />
      </Show>
      <Slider label="Hue" value={v().hue} min={a().colorize ? 0 : -180} max={a().colorize ? 360 : 180} onChange={(x) => set({ hue: x })} />
      <Slider label="Saturation" value={v().saturation} min={a().colorize ? 0 : -100} max={100} onChange={(x) => set({ saturation: x })} />
      <Slider label="Lightness" value={v().lightness} min={-100} max={100} onChange={(x) => set({ lightness: x })} />
      <Check
        label="Colorize"
        checked={a().colorize}
        onChange={(on) => {
          setRange("master");
          // As in Photoshop, turning Colorize on starts from a red at 25% saturation.
          props.onChange({ ...a(), colorize: on, master: on ? { hue: 0, saturation: 25, lightness: 0 } : { hue: 0, saturation: 0, lightness: 0 } });
        }}
      />
    </>
  );
}

function ColorBalanceEditor(props: { value: Extract<Adjustment, { kind: "color-balance" }>; onChange: (a: Adjustment) => void }) {
  const [tone, setTone] = createSignal<"shadows" | "midtones" | "highlights">("midtones");
  const v = () => props.value[tone()];
  const set = (i: number, x: number) => props.onChange({ ...props.value, [tone()]: v().map((y, j) => (j === i ? x : y)) as [number, number, number] });
  return (
    <>
      <Select label="Tone" value={tone()} options={["shadows", "midtones", "highlights"] as const} onChange={setTone} testId="balance-tone" />
      <For keyed={false} each={["Cyan / Red", "Magenta / Green", "Yellow / Blue"]}>
        {(label, i) => <Slider label={label()} value={v()[i]} min={-100} max={100} onChange={(x) => set(i, x)} />}
      </For>
      <Check label="Preserve Luminosity" checked={props.value.preserveLuminosity} onChange={(on) => props.onChange({ ...props.value, preserveLuminosity: on })} />
    </>
  );
}

function ChannelMixerEditor(props: { value: Extract<Adjustment, { kind: "channel-mixer" }>; onChange: (a: Adjustment) => void }) {
  const [out, setOut] = createSignal<"red" | "green" | "blue">("red");
  const row = (): MixerRow => (props.value.monochrome ? props.value.gray : props.value[out()]);
  const set = (patch: Partial<MixerRow>) => props.onChange({ ...props.value, [props.value.monochrome ? "gray" : out()]: { ...row(), ...patch } });
  return (
    <>
      <Show when={!props.value.monochrome}>
        <Select label="Output Channel" value={out()} options={["red", "green", "blue"] as const} onChange={setOut} testId="mixer-output" />
      </Show>
      <For keyed={false} each={["red", "green", "blue"] as const}>
        {(k) => <Slider label={title(k())} value={row()[k()]} min={-200} max={200} suffix="%" onChange={(v) => set({ [k()]: v })} />}
      </For>
      <div class="text-dim">Total: {row().red + row().green + row().blue}%</div>
      <Slider label="Constant" value={row().constant} min={-200} max={200} suffix="%" onChange={(v) => set({ constant: v })} />
      <Check label="Monochrome" checked={props.value.monochrome} onChange={(on) => props.onChange({ ...props.value, monochrome: on })} />
    </>
  );
}

function ColorLookupEditor(props: { value: Extract<Adjustment, { kind: "color-lookup" }>; onChange: (a: Adjustment) => void }) {
  const [error, setError] = createSignal("");
  const load = async (file: File) => {
    try {
      setError("");
      props.onChange({ ...props.value, lut: parseCube(await file.text(), file.name.replace(/\.[^.]+$/, "")) });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <>
      <div>3DLUT File: {props.value.lut ? props.value.lut.name : <span class="text-dim">None</span>}</div>
      <label class="inline-block cursor-pointer rounded-sm bg-raised px-3 py-1 hover:brightness-125">
        Load 3D LUT…
        <input type="file" accept=".cube" class="hidden" data-testid="lut-file" onChange={(e) => e.currentTarget.files?.[0] && void load(e.currentTarget.files[0])} />
      </label>
      <Show when={error()}>
        <p class="text-red-400">{error()}</p>
      </Show>
    </>
  );
}

function GradientMapEditor(props: { value: Extract<Adjustment, { kind: "gradient-map" }>; onChange: (a: Adjustment) => void }) {
  const stops = () => props.value.gradient.stops;
  const setStops = (s: Extract<Adjustment, { kind: "gradient-map" }>["gradient"]["stops"]) =>
    props.onChange({ ...props.value, gradient: { stops: [...s].sort((a, b) => a.location - b.location) } });
  const preview = () => {
    const g = sampleGradient(props.value.gradient, 64, props.value.reverse);
    const css = Array.from({ length: 64 }, (_, i) => `rgb(${g.r[i] * 255} ${g.g[i] * 255} ${g.b[i] * 255}) ${(i / 63) * 100}%`);
    return `linear-gradient(to right, ${css.join(", ")})`;
  };
  return (
    <>
      <div class="h-6 rounded-xs border border-line" style={{ "background-image": preview() }} data-testid="gradient-preview" />
      <For each={stops()}>
        {(s, i) => (
          <div class="flex items-center gap-2">
            <Swatch title="Stop Color" color={s.color} onChange={(c) => setStops(stops().map((x, j) => (j === i() ? { ...x, color: c } : x)))} />
            <span class="text-dim">Location:</span>
            <Field
              type="number"
              class="w-14 text-right"
              value={Math.round(s.location * 100)}
              min={0}
              max={100}
              onChange={(e) => setStops(stops().map((x, j) => (j === i() ? { ...x, location: Math.min(1, Math.max(0, e.currentTarget.valueAsNumber / 100)) } : x)))}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <span class="text-dim">%</span>
            <button type="button" class="ml-auto text-dim hover:text-fg disabled:opacity-30" disabled={stops().length <= 2} onClick={() => setStops(stops().filter((_, j) => j !== i()))}>
              Delete
            </button>
          </div>
        )}
      </For>
      <button
        type="button"
        class="text-accent hover:underline"
        onClick={() => {
          const g = sampleGradient(props.value.gradient, 3);
          setStops([...stops(), { location: 0.5, midpoint: 0.5, color: { r: Math.round(g.r[1] * 255), g: Math.round(g.g[1] * 255), b: Math.round(g.b[1] * 255) } }]);
        }}
      >
        Add Stop
      </button>
      <Check label="Dither" checked={props.value.dither} onChange={(on) => props.onChange({ ...props.value, dither: on })} />
      <Check label="Reverse" checked={props.value.reverse} onChange={(on) => props.onChange({ ...props.value, reverse: on })} />
    </>
  );
}

function SelectiveColorEditor(props: { value: Extract<Adjustment, { kind: "selective-color" }>; onChange: (a: Adjustment) => void }) {
  const [range, setRange] = createSignal<(typeof SELECTIVE_RANGES)[number]>("reds");
  const v = () => props.value.colors[range()];
  return (
    <>
      <Select label="Colors" value={range()} options={SELECTIVE_RANGES} onChange={setRange} testId="selective-range" />
      <For keyed={false} each={["cyan", "magenta", "yellow", "black"] as const}>
        {(k) => (
          <Slider
            label={title(k())}
            value={v()[k()]}
            min={-100}
            max={100}
            suffix="%"
            onChange={(x) => props.onChange({ ...props.value, colors: { ...props.value.colors, [range()]: { ...v(), [k()]: x } } })}
          />
        )}
      </For>
      <div class="flex gap-4">
        <label class="flex items-center gap-1">
          <input type="radio" checked={!props.value.absolute} onChange={() => props.onChange({ ...props.value, absolute: false })} /> Relative
        </label>
        <label class="flex items-center gap-1">
          <input type="radio" checked={props.value.absolute} onChange={() => props.onChange({ ...props.value, absolute: true })} /> Absolute
        </label>
      </div>
    </>
  );
}
