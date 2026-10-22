import { For, Show, createSignal, onSettled, untrack } from "solid-js";
import type { TextWarp, WarpStyle } from "../../text/model";
import { WARP_STYLES } from "../../text/warp";
import { Slider } from "../AdjustmentControls";
import { Button } from "../controls";
import { dismissable } from "../Popover";

/** A style picked from None starts as Photoshop's does: 50% bend, no distortion. */
const fresh = (style: WarpStyle, orientation: TextWarp["orientation"] = "horizontal"): TextWarp => ({ style, orientation, bend: 0.5, horizontalDistortion: 0, verticalDistortion: 0 });

/**
 * Type ▸ Warp Text: a style (or None), its orientation, bend and
 * distortions, previewed on the canvas as they change. Type stays type:
 * the warp is part of the layer and stays editable.
 */
export function WarpTextDialog(props: { initial: TextWarp | null; onPreview: (w: TextWarp | null) => void; onAnswer: (w: TextWarp | null | undefined) => void }) {
  const [warp, setWarp] = createSignal<TextWarp | null>(untrack(() => props.initial));
  const set = (w: TextWarp | null) => {
    setWarp(w);
    props.onPreview(w);
  };
  const patch = (p: Partial<TextWarp>) => warp() && set({ ...warp()!, ...p });
  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      props.onAnswer(warp());
    };
    window.addEventListener("keydown", onKey, { capture: true });
    const remove = dismissable(() => props.onAnswer(undefined));
    return () => {
      remove();
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  });
  const pct = (v: number) => Math.round(v * 100);
  return (
    <div class="fixed inset-0 z-50 grid place-items-center bg-black/30">
      <div class="flex w-[26rem] gap-4 rounded-sm border border-line bg-panel p-4 shadow-2xl" role="dialog" aria-label="Warp Text" data-testid="warp-text">
        <div class="flex-1 space-y-3">
          <label class="flex items-center gap-2">
            <span class="w-12 text-dim">Style:</span>
            <select
              class="flex-1"
              data-testid="warp-style"
              value={warp()?.style ?? "none"}
              onChange={(e) => {
                const v = e.currentTarget.value;
                set(v === "none" ? null : warp() ? { ...warp()!, style: v as WarpStyle } : fresh(v as WarpStyle));
              }}
            >
              <option value="none">None</option>
              <For each={WARP_STYLES}>{(s) => <option value={s.id}>{s.label}</option>}</For>
            </select>
          </label>
          <Show when={warp()}>
            {(w) => (
              <>
                <div class="flex gap-4" role="radiogroup">
                  <For each={["horizontal", "vertical"] as const}>
                    {(o) => (
                      <label class="flex items-center gap-1">
                        <input type="radio" name="warp-orientation" data-testid={`warp-${o}`} checked={w().orientation === o} onChange={() => patch({ orientation: o })} />
                        <span class="capitalize">{o}</span>
                      </label>
                    )}
                  </For>
                </div>
                <Slider label="Bend" value={pct(w().bend)} min={-100} max={100} suffix="%" onChange={(v) => patch({ bend: v / 100 })} />
                <Slider label="Horizontal Distortion" value={pct(w().horizontalDistortion)} min={-100} max={100} suffix="%" onChange={(v) => patch({ horizontalDistortion: v / 100 })} />
                <Slider label="Vertical Distortion" value={pct(w().verticalDistortion)} min={-100} max={100} suffix="%" onChange={(v) => patch({ verticalDistortion: v / 100 })} />
              </>
            )}
          </Show>
        </div>
        <div class="flex flex-col gap-2">
          <Button primary testId="warp-ok" onClick={() => props.onAnswer(warp())}>
            OK
          </Button>
          <Button testId="warp-cancel" onClick={() => props.onAnswer(undefined)}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
