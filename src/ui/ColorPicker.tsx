import { createSignal, untrack } from "solid-js";
import { hsvToRgb, parseHex, rgbToHsv, toHex, type HSV, type RGB } from "../core/color";
import { Button } from "./controls";

/** HSV picker: saturation/value square, hue strip and hex entry. Edits apply live. */
export function ColorPicker(props: { title: string; initial: RGB; onChange: (c: RGB) => void; onClose: () => void }) {
  // Keep HSV as the source of truth so hue survives passing through greys.
  const [hsv, setHsv] = createSignal<HSV>(untrack(() => rgbToHsv(props.initial)));
  const rgb = () => hsvToRgb(hsv());

  const set = (next: HSV) => {
    setHsv(next);
    props.onChange(hsvToRgb(next));
  };

  const drag = (apply: (fx: number, fy: number) => void) => (e: PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const update = (p: PointerEvent) => {
      const r = el.getBoundingClientRect();
      apply(Math.min(1, Math.max(0, (p.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (p.clientY - r.top) / r.height)));
    };
    update(e);
    el.onpointermove = update;
    el.onpointerup = () => (el.onpointermove = null);
  };

  return (
    <div
      class="absolute z-50 w-64 rounded-sm border border-line bg-panel-2 p-3 shadow-2xl"
      data-testid="color-picker"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div class="mb-2 font-semibold">{props.title}</div>
      <div class="flex gap-2">
        <div
          class="relative h-44 flex-1 cursor-crosshair rounded-sm"
          style={{
            "background-color": toHex(hsvToRgb({ h: hsv().h, s: 1, v: 1 })),
            "background-image": "linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)",
          }}
          onPointerDown={drag((fx, fy) => set({ ...hsv(), s: fx, v: 1 - fy }))}
        >
          <div
            class="pointer-events-none absolute size-3 -translate-1/2 rounded-full border-2 border-white shadow"
            style={{ left: `${hsv().s * 100}%`, top: `${(1 - hsv().v) * 100}%` }}
          />
        </div>
        <div
          class="relative w-4 cursor-ns-resize rounded-sm"
          style={{ "background-image": "linear-gradient(to bottom, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" }}
          onPointerDown={drag((_, fy) => set({ ...hsv(), h: Math.min(359.9, fy * 360) }))}
        >
          <div class="pointer-events-none absolute -inset-x-0.5 h-1 border border-white" style={{ top: `${(hsv().h / 360) * 100}%` }} />
        </div>
      </div>
      <div class="mt-3 flex items-center gap-2">
        <div class="size-7 rounded-sm border border-line" style={{ "background-color": toHex(rgb()) }} />
        <label class="flex items-center gap-1">
          <span class="text-dim">#</span>
          <input
            class="w-20 font-mono"
            data-testid="hex-input"
            value={toHex(rgb()).slice(1)}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              const c = parseHex(e.currentTarget.value);
              if (c) set(rgbToHsv(c));
            }}
          />
        </label>
        <div class="ml-auto">
          <Button primary onClick={props.onClose} testId="color-ok">
            OK
          </Button>
        </div>
      </div>
    </div>
  );
}
