import { createSignal, onSettled, untrack } from "solid-js";
import { adjustmentLabel, defaultAdjustment, type Adjustment, type AdjustmentKind } from "../core/adjustments";
import type { Histograms } from "../core/composite";
import { AdjustmentEditor } from "./AdjustmentControls";
import { Button } from "./controls";
import { dismissable } from "./Popover";

/**
 * Image ▸ Adjustments ▸ …: the adjustment's settings with a live Preview
 * (on by default, as in Photoshop), applied to the layer on OK.
 */
export function AdjustmentDialog(props: {
  kind: AdjustmentKind;
  foreground: Parameters<typeof defaultAdjustment>[1];
  background: Parameters<typeof defaultAdjustment>[2];
  histogram: Histograms | null;
  onPreview: (a: Adjustment | null) => void;
  onApply: (a: Adjustment) => void;
  onClose: () => void;
}) {
  const [value, setValue] = createSignal<Adjustment>(untrack(() => defaultAdjustment(props.kind, props.foreground, props.background)));
  const [preview, setPreview] = createSignal(true);
  const show = (a: Adjustment, on = preview()) => props.onPreview(on ? a : null);
  const change = (a: Adjustment) => {
    setValue(a);
    show(a);
  };
  const close = () => {
    props.onPreview(null);
    props.onClose();
  };
  const ok = () => {
    props.onPreview(null);
    props.onApply(value());
    props.onClose();
  };
  onSettled(() => {
    show(untrack(value));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || (e.target as HTMLElement).tagName === "INPUT") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ok();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    const remove = dismissable(close);
    return () => {
      remove();
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  });
  return (
    <div class="pointer-events-none fixed inset-0 z-50 flex items-start justify-end p-12">
      <div
        class="pointer-events-auto flex w-[24rem] gap-4 rounded-sm border border-line bg-panel p-4 shadow-2xl"
        role="dialog"
        aria-label={adjustmentLabel(props.kind)}
        data-testid="adjustment-dialog"
      >
        <div class="min-w-0 flex-1 space-y-2">
          <div class="font-semibold">{adjustmentLabel(props.kind)}</div>
          <AdjustmentEditor value={value()} onChange={change} histogram={props.histogram} />
        </div>
        <div class="flex flex-col gap-2">
          <Button primary testId="adjustment-ok" onClick={ok}>
            OK
          </Button>
          <Button onClick={close}>Cancel</Button>
          <label class="mt-2 flex items-center gap-1.5">
            <input
              type="checkbox"
              data-testid="adjustment-preview"
              checked={preview()}
              onChange={(e) => {
                setPreview(e.currentTarget.checked);
                show(value(), e.currentTarget.checked);
              }}
            />
            Preview
          </label>
        </div>
      </div>
    </div>
  );
}
