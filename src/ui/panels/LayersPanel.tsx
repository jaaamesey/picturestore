import { For, Show, createEffect, createSignal, onSettled, useContext } from "solid-js";
import { BLEND_MODES, type LayerBlendMode } from "../../core/blend";
import { activeLayer, type Layer } from "../../core/document";
import { hasPixels, isClipped, isGroup } from "../../core/layers";
import { previewImage, type Pixels } from "../../core/pixels";
import type { SelectionMode } from "../../core/selection";
import { isEnabled } from "../../editor/commands";
import { AppContext } from "../context";
import { ADJUSTMENT_LAYER_MENU, LAYER_MENU } from "../MenuBar";
import { IconButton, NumberField } from "../controls";
import { Icon } from "../icons";
import { createSortable } from "../sortable";

const THUMB = 36;

/**
 * Thumbnail at the screen's resolution, from the layer at the finest
 * power-of-two reduction that still covers it (cached per tile, so only
 * what changed is filtered again), scaled the rest of the way with the
 * browser's high-quality filter, so thin strokes don't vanish.
 */
function Thumbnail(props: { pixels: Pixels; width: number; height: number; background?: number }) {
  let canvas!: HTMLCanvasElement;
  createEffect(
    () => ({ pixels: props.pixels, dw: props.width, dh: props.height, bg: props.background }),
    ({ pixels, dw, dh, bg }) => {
      const dpr = window.devicePixelRatio || 1;
      const s = THUMB / Math.max(dw, dh);
      const w = Math.max(1, Math.round(dw * s)), h = Math.max(1, Math.round(dh * s));
      const level = Math.max(0, Math.min(8, Math.floor(Math.log2(1 / (s * dpr)))));
      const img = previewImage(pixels, dw, dh, level);
      const source = new OffscreenCanvas(img.width, img.height);
      source.getContext("2d")!.putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d")!;
      // A mask shows over its background grey.
      if (bg !== undefined) {
        ctx.fillStyle = `rgb(${bg} ${bg} ${bg})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    },
  );
  return (
    <div class="grid shrink-0 place-items-center" style={{ width: `${THUMB}px`, height: `${THUMB}px` }}>
      <canvas ref={canvas} class={["max-h-full max-w-full border border-line", { checkerboard: props.background === undefined }]} />
    </div>
  );
}

/** One row of the Layers panel: a layer, how deep in groups it is, and its part in a clipping group. */
interface Row {
  readonly layer: Layer;
  readonly depth: number;
  readonly clipped: boolean;
  /** The base of a clipping group (its name is underlined, as in Photoshop). */
  readonly base: boolean;
}

/** The tree as rows, top first; a collapsed group's contents aren't listed. */
function rowsOf(layers: readonly Layer[], depth = 0): Row[] {
  const out: Row[] = [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    const clipped = isClipped(layers, i);
    out.push({ layer, depth, clipped, base: !clipped && !!layers[i + 1]?.clipped });
    if (isGroup(layer) && layer.content.open) out.push(...rowsOf(layer.content.layers, depth + 1));
  }
  return out;
}

/** Ctrl-click: replace the selection; with Shift add to it, with Alt subtract, with both intersect. */
const loadMode = (e: MouseEvent): SelectionMode => (e.shiftKey && e.altKey ? "intersect" : e.shiftKey ? "add" : e.altKey ? "subtract" : "replace");

/** A frame around whichever of a layer's thumbnails edits go to. */
const targetRing = (on: boolean) => (on ? "rounded-xs outline-2 outline-offset-1 outline-white" : "");

function LayerRow(props: {
  row: Row;
  active: boolean;
  maskTargeted: boolean;
  width: number;
  height: number;
}) {
  const { editor, openMenu } = useContext(AppContext);
  const [editing, setEditing] = createSignal(false);
  const layer = () => props.row.layer;
  return (
    <div
      role="option"
      aria-selected={props.active ? "true" : "false"}
      data-testid="layer-row"
      data-layer-name={props.row.layer.name}
      data-kind={props.row.layer.content.kind}
      data-layer-id={props.row.layer.id}
      data-depth={props.row.depth}
      data-open={isGroup(props.row.layer) && props.row.layer.content.open ? "" : undefined}
      data-clipped={props.row.clipped ? "" : undefined}
      data-editing={editing() ? "" : undefined}
      class={[
        "relative flex h-11 items-center gap-1.5 border-b border-line px-1.5",
        props.active ? "bg-accent-soft" : "hover:bg-raised",
        // Lifted while dragged (see ui/sortable.ts).
        "data-dragging:z-10 data-dragging:cursor-grabbing data-dragging:bg-raised data-dragging:shadow-[0_6px_16px_rgba(0,0,0,0.45)]",
        // Where a drag would drop, as Photoshop marks it: a line above or below, or the group outlined.
        "data-[drop=above]:shadow-[inset_0_2px_0_var(--color-accent)] data-[drop=below]:shadow-[inset_0_-2px_0_var(--color-accent)] data-[drop=inside]:shadow-[inset_0_-2px_0_var(--color-accent)]",
        "data-[drop=inside-bottom]:outline-2 data-[drop=inside-bottom]:-outline-offset-2 data-[drop=inside-bottom]:outline-accent",
      ]}
      style={{ "padding-left": `${6 + props.row.depth * 16}px` }}
      onClick={(e) => {
        // Alt-click between layers in Photoshop: clips this layer to the one below (or releases it).
        if (e.altKey) editor.toggleClippingMask(layer().id);
        else editor.selectLayer(layer().id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        editor.selectLayer(layer().id);
        openMenu(e.clientX, e.clientY, LAYER_MENU);
      }}
    >
      <button
        type="button"
        title={layer().visible ? "Hide layer" : "Show layer"}
        data-testid="layer-visibility"
        class={["grid size-6 shrink-0 place-items-center", layer().visible ? "text-fg" : "text-dim/40"]}
        onClick={(e) => {
          e.stopPropagation();
          editor.setLayerProps(layer().id, { visible: !layer().visible });
        }}
      >
        <Icon name="eye" size={15} />
      </button>
      <Show when={props.row.clipped}>
        <span class="shrink-0 text-dim" title="Clipped to the layer below" data-testid="clip-indicator">
          <Icon name="clip" size={14} />
        </span>
      </Show>
      <Show
        when={layer().content.kind === "group" && layer().content}
        fallback={
          <div class={["relative", targetRing(props.active && !props.maskTargeted && !!layer().mask && hasPixels(layer()))]}>
            <Show
              when={layer().content.kind === "adjustment"}
              fallback={
                <div
                  data-testid="layer-thumbnail"
                  title="Ctrl-click to load as a selection"
                  onClick={(e) => {
                    if (!(e.ctrlKey || e.metaKey)) return;
                    e.stopPropagation();
                    editor.loadSelection(layer().id, "layer", loadMode(e));
                  }}
                >
                  <Thumbnail pixels={layer().pixels} width={props.width} height={props.height} />
                </div>
              }
            >
              <div class="grid shrink-0 place-items-center rounded-xs bg-raised text-fg" style={{ width: `${THUMB}px`, height: `${THUMB}px` }} title="Adjustment layer">
                <Icon name="adjust" size={20} />
              </div>
            </Show>
            <Show when={layer().content.kind === "smart" || layer().content.kind === "shape"}>
              {/* Photoshop's badges: smart objects and shapes aren't directly editable pixels. */}
              <span
                class="absolute -right-1 -bottom-1 grid size-3.5 place-items-center rounded-xs bg-panel text-fg"
                title={layer().content.kind === "smart" ? "Smart Object" : "Shape layer"}
                data-testid="layer-badge"
              >
                <Icon name={layer().content.kind === "smart" ? "smart" : "polygon"} size={11} />
              </span>
            </Show>
          </div>
        }
      >
        {(g) => (
          <>
            <button
              type="button"
              title={(g() as { open: boolean }).open ? "Collapse group" : "Expand group"}
              data-testid="group-toggle"
              class="grid size-4 shrink-0 place-items-center text-dim hover:text-fg"
              onClick={(e) => {
                e.stopPropagation();
                editor.setGroupOpen(layer().id, !(g() as { open: boolean }).open);
              }}
            >
              <Icon name="chevron" size={12} class={(g() as { open: boolean }).open ? "rotate-90" : ""} />
            </button>
            <span class="shrink-0 text-fg" title="Group">
              <Icon name="folder" size={18} />
            </span>
          </>
        )}
      </Show>
      <Show when={layer().mask}>
        {(m) => (
          <>
            <button
              type="button"
              title={m().linked ? "Unlink mask from layer" : "Link mask to layer"}
              data-testid="mask-link"
              class={["shrink-0", m().linked ? "text-fg" : "text-dim/40"]}
              onClick={(e) => {
                e.stopPropagation();
                editor.setMaskProps(layer().id, { linked: !m().linked });
              }}
            >
              <Icon name="link" size={12} />
            </button>
            <div
              class={["relative cursor-pointer", targetRing(props.active && (props.maskTargeted || !hasPixels(layer())))]}
              title="Layer mask (Alt-click to view, Shift-click to disable, Ctrl-click to load as a selection)"
              data-testid="mask-thumbnail"
              data-enabled={m().enabled ? "" : undefined}
              onClick={(e) => {
                e.stopPropagation();
                // As in Photoshop: Ctrl loads it as a selection, Alt shows it alone, Shift disables it.
                if (e.ctrlKey || e.metaKey) editor.loadSelection(layer().id, "mask", loadMode(e));
                else if (e.altKey) editor.toggleMaskView(layer().id);
                else if (e.shiftKey) editor.setMaskProps(layer().id, { enabled: !m().enabled });
                else editor.selectLayer(layer().id, true);
              }}
            >
              <Thumbnail pixels={m().pixels} width={props.width} height={props.height} background={m().background} />
              <Show when={!m().enabled}>
                <span class="absolute inset-0 grid place-items-center text-red-500">
                  <Icon name="x" size={26} />
                </span>
              </Show>
            </div>
          </>
        )}
      </Show>
      <Show
        when={editing()}
        fallback={
          <span class={["flex-1 truncate", { underline: props.row.base }]} onDblClick={() => setEditing(true)}>
            {layer().name}
          </span>
        }
      >
        <input
          class="min-w-0 flex-1"
          value={layer().name}
          ref={(el) => queueMicrotask(() => el.select())}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={(e) => {
            const name = e.currentTarget.value.trim();
            setEditing(false);
            if (name && name !== layer().name) editor.setLayerProps(layer().id, { name });
          }}
        />
      </Show>
    </div>
  );
}

export function LayersPanel() {
  const { editor, shell, openMenu } = useContext(AppContext);
  const canDelete = () => isEnabled("layer.delete", editor);
  const doc = () => editor.active()?.doc();
  const current = () => (doc() ? activeLayer(doc()!) : undefined);
  // Panels list layers top-first; documents store them bottom-first.
  const rows = () => (doc() ? rowsOf(doc()!.layers) : []);
  let list!: HTMLDivElement;

  // Drag to reorder, with layout changes from anywhere (undo, Arrange) animated too.
  onSettled(() => {
    const sortable = createSortable(list, {
      items: "[data-testid=layer-row]",
      key: (el) => el.dataset.layerId ?? null,
      canStart: (e) => !(e.target as Element).closest("button, input, select") && !(e.target as Element).closest("[data-editing]"),
      depth: (el) => Number(el.dataset.depth),
      container: (el) => (el.dataset.kind !== "group" ? null : el.dataset.open !== undefined ? "open" : "closed"),
      onDrop: (id, target, placement) => editor.moveLayer(id, target, placement),
    });
    return () => sortable.dispose();
  });

  return (
    <section class="flex min-h-0 flex-1 flex-col" data-testid="layers-panel">
      <header class="border-b border-line bg-panel-2 px-2 py-1 font-semibold">Layers</header>
      <Show when={current()}>
        {(l) => (
          <div class="flex items-center gap-2 border-b border-line p-1.5">
            <select
              class="min-w-0 flex-1 capitalize"
              data-testid="blend-mode"
              value={l().blendMode}
              onChange={(e) => editor.setLayerProps(l().id, { blendMode: e.currentTarget.value as LayerBlendMode })}
            >
              <Show when={isGroup(l())}>
                <option value="pass through">pass through</option>
              </Show>
              <For each={BLEND_MODES}>{(m) => <option value={m}>{m}</option>}</For>
            </select>
            <NumberField
              label="Opacity"
              testId="layer-opacity"
              value={Math.round(l().opacity * 100)}
              min={0}
              max={100}
              suffix="%"
              width="3rem"
              onChange={(v) => editor.setLayerProps(l().id, { opacity: v / 100 })}
            />
          </div>
        )}
      </Show>
      <div
        ref={list}
        class="relative min-h-0 flex-1 overflow-y-auto"
        role="listbox"
        aria-label="Layers"
      >
        <For each={rows()} keyed={(r) => r.layer.id}>
          {(r) => (
            <LayerRow
              row={r()}
              active={r().layer.id === doc()?.activeLayerId}
              maskTargeted={!!doc()?.maskTargeted}
              width={doc()!.width}
              height={doc()!.height}
            />
          )}
        </For>
      </div>
      <footer class="flex justify-end gap-0.5 border-t border-line p-1">
        <IconButton
          icon="mask"
          title="Add layer mask (Alt: hide)"
          testId="add-mask"
          disabled={!current() || !!current()!.mask}
          onClick={(e) => editor.addMask(e.altKey)}
        />
        <IconButton
          icon="adjust"
          title="New adjustment layer"
          testId="new-adjustment"
          disabled={!doc()}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openMenu(r.left, r.top - 8, ADJUSTMENT_LAYER_MENU, "up");
          }}
        />
        <IconButton icon="folder" title="New group" testId="new-group" disabled={!doc()} onClick={() => editor.newGroup()} />
        <IconButton icon="plus" title="New layer" testId="new-layer" disabled={!doc()} onClick={() => editor.newLayer()} />
        <IconButton icon="copy" title="Duplicate layer" disabled={!doc()} onClick={() => editor.duplicateLayer()} />
        <IconButton icon="merge" title="Merge down" disabled={!doc()} onClick={() => editor.mergeDown()} />
        <IconButton icon="trash" title="Delete layer" testId="delete-layer" disabled={!canDelete()} onClick={() => shell.deleteLayer(true)} />
      </footer>
    </section>
  );
}
