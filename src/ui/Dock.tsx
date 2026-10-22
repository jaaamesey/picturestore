import type { JSX } from "@solidjs/web";
import { For, Show, createSignal, useContext } from "solid-js";
import { AppContext } from "./context";
import type { MenuItem } from "./MenuBar";
import { PANEL_MIN_HEIGHT, PANEL_TITLES, activateTab, dividerPanels, dragDivider, isOpen, loadDock, saveDock, toggleMinimized, togglePanel, togglePanels, withWidth, type DockLayout, type PanelId } from "./dock";

const [layout, setLayout] = createSignal<DockLayout>(loadDock());
const commit = (d: DockLayout) => {
  setLayout(d);
  saveDock(d);
};

/** The dock's panels, for the Window menu and panel buttons. */
export const panels = {
  isOpen: (id: PanelId) => isOpen(layout(), id),
  toggle: (id: PanelId) => commit(togglePanel(layout(), id)),
  toggleGroup: (ids: readonly PanelId[]) => commit(togglePanels(layout(), ids)),
};

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
 * widen it, the divider between two groups to trade height between them,
 * click a tab to bring its panel to the front, and double-click one to
 * minimize or restore its group. The layout is remembered.
 */
export function Dock(props: { panels: Record<PanelId, () => JSX.Element>; menus?: Partial<Record<PanelId, readonly MenuItem[]>> }) {
  const { openMenu } = useContext(AppContext);
  const sections: HTMLElement[] = [];

  const resizeWidth = (e: PointerEvent) => {
    const start = layout();
    track(e, (dx) => setLayout(withWidth(start, start.width - dx)), () => saveDock(layout()));
  };
  const resizePanels = (e: PointerEvent, i: number) => {
    const start = layout();
    const heights = start.groups.map((_, k) => sections[k].getBoundingClientRect().height);
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
      <For each={layout().groups} keyed={(g) => g.id}>
        {(g, i) => (
          <section
            ref={(el) => (sections[i()] = el)}
            class={["relative flex min-h-0 flex-col border-b border-line", { "flex-none": g().minimized }]}
            style={g().minimized ? undefined : { flex: `${g().size} 1 0px`, "min-height": `${PANEL_MIN_HEIGHT}px` }}
            data-testid={`${g().id}-panel`}
            data-minimized={g().minimized ? "" : undefined}
          >
            <header
              class="flex gap-0.5 border-b border-line bg-panel-2 px-1 pt-1 select-none"
              role="tablist"
              aria-expanded={g().minimized ? "false" : "true"}
              onDblClick={() => commit(toggleMinimized(layout(), g().id))}
            >
              <For each={g().tabs}>
                {(t) => (
                  <button
                    type="button"
                    role="tab"
                    data-testid={`panel-tab-${t}`}
                    aria-selected={g().active === t ? "true" : "false"}
                    class={["rounded-t-sm px-2 py-0.5 font-semibold", g().active === t ? "bg-panel text-fg" : "text-dim hover:text-fg"]}
                    onClick={() => commit(activateTab(layout(), t))}
                  >
                    {PANEL_TITLES[t]}
                  </button>
                )}
              </For>
              <Show when={props.menus?.[g().active]}>
                {(items) => (
                  <button
                    type="button"
                    class="ml-auto px-1.5 text-dim hover:text-fg"
                    title="Panel menu"
                    data-testid={`panel-menu-${g().active}`}
                    onDblClick={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      openMenu(r.left, r.bottom, items());
                    }}
                  >
                    ≡
                  </button>
                )}
              </Show>
            </header>
            {/* Every tab kept mounted (and while minimized), so each keeps its state. */}
            <For each={g().tabs}>
              {(t) => (
                <div class={["min-h-0 flex-1 flex-col", !g().minimized && g().active === t ? "flex" : "hidden"]} data-panel={t}>
                  {props.panels[t]()}
                </div>
              )}
            </For>
            <Show when={dividerPanels(layout(), i())}>
              <div class="absolute inset-x-0 -bottom-1 z-10 h-2 cursor-ns-resize" data-testid="dock-divider" onPointerDown={(e) => resizePanels(e, i())} />
            </Show>
          </section>
        )}
      </For>
    </aside>
  );
}
