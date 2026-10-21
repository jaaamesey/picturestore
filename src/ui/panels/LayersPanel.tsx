import { For, Show, createEffect, createSignal, onSettled, useContext } from "solid-js";
import { BLEND_MODES, type BlendMode } from "../../core/blend";
import { activeLayer, type Layer } from "../../core/document";
import { PREVIEW_FACTOR, TILE_SIZE, keyX, keyY, tilePreview, type TileMap } from "../../core/tiles";
import { AppContext } from "../context";
import { LAYER_MENU } from "../MenuBar";
import { IconButton, NumberField } from "../controls";
import { Icon } from "../icons";
import { createSortable } from "../sortable";

const THUMB = 36;

/**
 * Thumbnail assembled from each tile's cached, area-averaged 1/16 preview, then
 * scaled with the browser's high-quality filter. Only tiles that changed since
 * the last update are re-filtered, and thin strokes don't vanish.
 */
function Thumbnail(props: { tiles: TileMap; width: number; height: number }) {
  let canvas!: HTMLCanvasElement;
  createEffect(
    () => ({ tiles: props.tiles, dw: props.width, dh: props.height }),
    ({ tiles, dw, dh }) => {
      const s = THUMB / Math.max(dw, dh);
      const w = Math.max(1, Math.round(dw * s));
      const h = Math.max(1, Math.round(dh * s));
      const pw = Math.ceil(dw / PREVIEW_FACTOR);
      const ph = Math.ceil(dh / PREVIEW_FACTOR);
      const img = new ImageData(pw, ph);
      const n = TILE_SIZE / PREVIEW_FACTOR;
      for (const [key, tile] of tiles) {
        const ox = keyX(key) * n, oy = keyY(key) * n;
        if (ox >= pw || oy >= ph || ox + n <= 0 || oy + n <= 0) continue;
        const preview = tilePreview(tile);
        for (let y = Math.max(0, -oy); y < n && oy + y < ph; y++) {
          const x0 = Math.max(0, -ox);
          const x1 = Math.min(n, pw - ox);
          img.data.set(preview.subarray((y * n + x0) * 4, (y * n + x1) * 4), ((oy + y) * pw + ox + x0) * 4);
        }
      }
      const source = new OffscreenCanvas(pw, ph);
      source.getContext("2d")!.putImageData(img, 0, 0);
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(source, 0, 0, w, h);
    },
  );
  return (
    <div class="grid shrink-0 place-items-center" style={{ width: `${THUMB}px`, height: `${THUMB}px` }}>
      <canvas ref={canvas} class="checkerboard max-h-full max-w-full border border-line" />
    </div>
  );
}

function LayerRow(props: {
  layer: Layer;
  active: boolean;
  width: number;
  height: number;
}) {
  const { editor, openMenu } = useContext(AppContext);
  const [editing, setEditing] = createSignal(false);
  return (
    <div
      role="option"
      aria-selected={props.active ? "true" : "false"}
      data-testid="layer-row"
      data-layer-name={props.layer.name}
      data-kind={props.layer.content.kind}
      data-layer-id={props.layer.id}
      data-editing={editing() ? "" : undefined}
      class={[
        "relative flex h-11 items-center gap-1.5 border-b border-line px-1.5",
        props.active ? "bg-accent-soft" : "hover:bg-raised",
        // Lifted while dragged (see ui/sortable.ts).
        "data-dragging:z-10 data-dragging:cursor-grabbing data-dragging:bg-raised data-dragging:shadow-[0_6px_16px_rgba(0,0,0,0.45)]",
      ]}
      onClick={() => editor.selectLayer(props.layer.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        editor.selectLayer(props.layer.id);
        openMenu(e.clientX, e.clientY, LAYER_MENU);
      }}
    >
      <button
        type="button"
        title={props.layer.visible ? "Hide layer" : "Show layer"}
        data-testid="layer-visibility"
        class={["grid size-6 place-items-center", props.layer.visible ? "text-fg" : "text-dim/40"]}
        onClick={(e) => {
          e.stopPropagation();
          editor.setLayerProps(props.layer.id, { visible: !props.layer.visible });
        }}
      >
        <Icon name="eye" size={15} />
      </button>
      <div class="relative">
        <Thumbnail tiles={props.layer.tiles} width={props.width} height={props.height} />
        <Show when={props.layer.content.kind !== "pixels"}>
          {/* Photoshop's badges: smart objects and shapes aren't directly editable pixels. */}
          <span
            class="absolute -right-1 -bottom-1 grid size-3.5 place-items-center rounded-xs bg-panel text-fg"
            title={props.layer.content.kind === "smart" ? "Smart Object" : "Shape layer"}
            data-testid="layer-badge"
          >
            <Icon name={props.layer.content.kind === "smart" ? "smart" : "polygon"} size={11} />
          </span>
        </Show>
      </div>
      <Show
        when={editing()}
        fallback={
          <span class="flex-1 truncate" onDblClick={() => setEditing(true)}>
            {props.layer.name}
          </span>
        }
      >
        <input
          class="min-w-0 flex-1"
          value={props.layer.name}
          ref={(el) => queueMicrotask(() => el.select())}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") setEditing(false);
          }}
          onBlur={(e) => {
            const name = e.currentTarget.value.trim();
            setEditing(false);
            if (name && name !== props.layer.name) editor.setLayerProps(props.layer.id, { name });
          }}
        />
      </Show>
    </div>
  );
}

export function LayersPanel() {
  const { editor } = useContext(AppContext);
  const doc = () => editor.active()?.doc();
  const current = () => (doc() ? activeLayer(doc()!) : undefined);
  // Panels list layers top-first; documents store them bottom-first.
  const rows = () => (doc() ? doc()!.layers.map((layer, index) => ({ layer, index })).reverse() : []);
  let list!: HTMLDivElement;

  // Drag to reorder, with layout changes from anywhere (undo, Arrange) animated too.
  onSettled(() => {
    const sortable = createSortable(list, {
      items: "[data-testid=layer-row]",
      key: (el) => el.dataset.layerId ?? null,
      canStart: (e) => !(e.target as Element).closest("button, input, select") && !(e.target as Element).closest("[data-editing]"),
      onSort(id, from, to) {
        // Rows are listed top-first; dropping past a row puts it below that row, and vice versa.
        const target = rows()[to]?.layer.id;
        if (target) editor.moveLayer(id, target, to > from ? "below" : "above");
      },
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
              onChange={(e) => editor.setLayerProps(l().id, { blendMode: e.currentTarget.value as BlendMode })}
            >
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
              layer={r().layer}
              active={r().layer.id === doc()?.activeLayerId}
              width={doc()!.width}
              height={doc()!.height}
            />
          )}
        </For>
      </div>
      <footer class="flex justify-end gap-0.5 border-t border-line p-1">
        <IconButton icon="plus" title="New layer" testId="new-layer" disabled={!doc()} onClick={() => editor.newLayer()} />
        <IconButton icon="copy" title="Duplicate layer" disabled={!doc()} onClick={() => editor.duplicateLayer()} />
        <IconButton icon="merge" title="Merge down" disabled={!doc()} onClick={() => editor.mergeDown()} />
        <IconButton
          icon="trash"
          title="Delete layer"
          testId="delete-layer"
          disabled={(doc()?.layers.length ?? 0) < 2}
          onClick={() => editor.deleteLayer()}
        />
      </footer>
    </section>
  );
}
