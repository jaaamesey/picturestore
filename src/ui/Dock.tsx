import type { JSX } from "@solidjs/web";
import { For, Show, createSignal } from "solid-js";
import { PANEL_MIN_HEIGHT, PANEL_TITLES, dividerPanels, dragDivider, loadDock, saveDock, toggleMinimized, withWidth, type DockLayout, type PanelId } from "./dock";

/**
 * Follows a press on a handle until it's released, with the pointer
 * captured so the drag carries on outside it; `move` gets the travel.
 */
function track(e: PointerEvent, move: (dx: number, dy: number) => void, done: () => void) {
  if (e.button !== 0) return;
  e.preventDefault();
  const handle = e.currentTarget as HTMLElement;
  handle.setPointerCapture(e.pointerId);
  const x0 = e.clientX, y0 = e.clientY;
  const onMove = (m: PointerEvent) => move(m.clientX - x0, m.clientY - y0);
  const onUp = () => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
    done();
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
}

/**
 * The panel dock beside the canvas (see ./dock.ts): drag its left edge to
 * widen it, the divider between two panels to trade height between them,
 * and double-click a panel's tab to minimize or restore it. The layout is
 * remembered.
 */
export function Dock(props: { panels: Record<PanelId, () => JSX.Element> }) {
  const [layout, setLayout] = createSignal<DockLayout>(loadDock());
  const commit = (d: DockLayout) => {
    setLayout(d);
    saveDock(d);
  };
  const sections: HTMLElement[] = [];

  const resizeWidth = (e: PointerEvent) => {
    const start = layout();
    track(e, (dx) => setLayout(withWidth(start, start.width - dx)), () => saveDock(layout()));
  };
  const resizePanels = (e: PointerEvent, i: number) => {
    const start = layout();
    const heights = start.panels.map((_, k) => sections[k].getBoundingClientRect().height);
    track(e, (_, dy) => setLayout(dragDivider(start, heights, i, dy)), () => saveDock(layout()));
  };

  return (
    <aside class="relative flex shrink-0 flex-col border-l border-line bg-panel" style={{ width: `${layout().width}px` }} data-testid="dock">
      <div
        class="absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize"
        data-testid="dock-edge"
        title="Drag to resize the panels"
        onPointerDown={resizeWidth}
      />
      <For each={layout().panels} keyed={false}>
        {(p, i) => (
          <section
            ref={(el) => (sections[i] = el)}
            class={["relative flex min-h-0 flex-col border-b border-line", { "flex-none": p().minimized }]}
            style={p().minimized ? undefined : { flex: `${p().size} 1 0px`, "min-height": `${PANEL_MIN_HEIGHT}px` }}
            data-testid={`${p().id}-panel`}
            data-minimized={p().minimized ? "" : undefined}
          >
            <header
              class="border-b border-line bg-panel-2 px-2 py-1 font-semibold select-none"
              aria-expanded={p().minimized ? "false" : "true"}
              onDblClick={() => commit(toggleMinimized(layout(), p().id))}
            >
              {PANEL_TITLES[p().id]}
            </header>
            {/* Kept mounted while minimized, so it keeps its state. */}
            <div class={["min-h-0 flex-1 flex-col", p().minimized ? "hidden" : "flex"]}>{props.panels[p().id]()}</div>
            <Show when={dividerPanels(layout(), i)}>
              <div class="absolute inset-x-0 -bottom-1 z-10 h-2 cursor-ns-resize" data-testid="dock-divider" onPointerDown={(e) => resizePanels(e, i)} />
            </Show>
          </section>
        )}
      </For>
    </aside>
  );
}
