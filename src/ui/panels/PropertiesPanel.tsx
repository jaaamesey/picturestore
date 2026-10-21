import { Show, createMemo, useContext } from "solid-js";
import { adjustmentLabel } from "../../core/adjustments";
import { flatten, layersBelow, sampleHistograms, type Histograms } from "../../core/composite";
import { activeLayer, type Doc, type Layer } from "../../core/document";
import { walk } from "../../core/layers";
import { rect } from "../../core/geometry";
import { AdjustmentEditor } from "../AdjustmentControls";
import { Button } from "../controls";
import { AppContext } from "../context";

/**
 * Properties (Window ▸ Properties): the selected adjustment layer's
 * settings, or the targeted layer mask's options.
 */
export function PropertiesPanel() {
  const { editor } = useContext(AppContext);
  const doc = () => editor.active()?.doc();
  const layer = () => (doc() ? activeLayer(doc()!) : undefined);
  const adjustment = () => {
    const c = layer()?.content;
    return c?.kind === "adjustment" ? c.adjustment : null;
  };
  // The histogram of what the adjustment layer adjusts: everything beneath it. Recomputed only when that changes.
  let cache: { key: readonly unknown[]; h: Histograms } | null = null;
  const histogram = createMemo(() => {
    const d = doc();
    const l = layer();
    if (!d || !l || l.content.kind !== "adjustment") return null;
    const below = layersBelow(d.layers, l.id);
    const key = [d.width, d.height, ...visibleLayers(below)];
    if (!cache || cache.key.length !== key.length || cache.key.some((k, i) => k !== key[i])) {
      const view: Doc = { ...d, layers: below };
      cache = { key, h: sampleHistograms((r) => flatten(view, r), rect(0, 0, d.width, d.height)) };
    }
    return cache.h;
  });
  return (
    <section class="flex max-h-[45%] min-h-0 flex-col border-b border-line" data-testid="properties-panel">
      <header class="border-b border-line bg-panel-2 px-2 py-1 font-semibold">Properties</header>
      <div class="min-h-0 overflow-y-auto p-2">
        <Show
          when={adjustment()}
          fallback={
            <Show when={layer()?.mask && (doc()?.maskTargeted || layer()?.content.kind === "group")} fallback={<p class="text-dim">No properties</p>}>
              <div class="space-y-2" data-testid="mask-properties">
                <div class="font-semibold">Layer Mask</div>
                <div class="flex flex-wrap gap-2">
                  <Button onClick={() => editor.setMaskProps(layer()!.id, { enabled: !layer()!.mask!.enabled })}>{layer()!.mask!.enabled ? "Disable" : "Enable"}</Button>
                  <Show when={layer()!.content.kind === "pixels"}>
                    <Button onClick={() => editor.applyMask()}>Apply</Button>
                  </Show>
                  <Button onClick={() => editor.deleteMask()}>Delete</Button>
                </div>
              </div>
            </Show>
          }
        >
          {(a) => (
            <div class="space-y-2">
              <div class="font-semibold">{adjustmentLabel(a().kind)}</div>
              <AdjustmentEditor value={a()} histogram={histogram()} onChange={(next) => editor.setAdjustment(layer()!.id, next)} />
            </div>
          )}
        </Show>
      </div>
    </section>
  );
}

/** The shown layers with content (identity changes whenever one does; groups on the way are rebuilt by `layersBelow`). */
const visibleLayers = (layers: readonly Layer[]) => [...walk(layers)].filter((l) => l.visible && l.content.kind !== "group");
