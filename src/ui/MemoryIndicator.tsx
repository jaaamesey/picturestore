import { Show, createSignal, useContext } from "solid-js";
import { AppContext } from "./context";

/**
 * Status-bar warning when memory is constrained: what's been given up, and
 * what the user can do about it. Documents themselves are never discarded.
 */
export function MemoryIndicator() {
  const { editor, shell } = useContext(AppContext);
  const [open, setOpen] = createSignal(false);
  const m = () => editor.memory();
  const constrained = () => m().ram !== "ok" || m().gpuLevel > 0;
  return (
    <Show when={constrained()}>
      {/* Keep clicks from reaching the canvas's tools. */}
      <span class="pointer-events-auto relative" onPointerDown={(e) => e.stopPropagation()}>
        <button
          type="button"
          data-testid="memory-indicator"
          data-ram={m().ram}
          data-gpu-level={m().gpuLevel}
          class="rounded-xs bg-amber-500/20 px-1.5 text-amber-300 hover:bg-amber-500/30"
          onClick={() => setOpen((o) => !o)}
        >
          ⚠ Memory constrained
        </button>
        <Show when={open()}>
          <div class="absolute bottom-full left-0 mb-1 w-80 space-y-2 rounded-sm border border-line bg-panel-2 p-3 text-fg shadow-xl" data-testid="memory-details">
            <Show when={m().gpuLevel > 0}>
              <p>
                GPU memory is low, so the canvas is drawn at 1/{1 << m().gpuLevel} resolution. Your document is unaffected, and
                transforms are still applied at full quality.
              </p>
              <button type="button" class="rounded-sm bg-raised px-2 py-0.5 hover:brightness-125" onClick={() => editor.retryFullQuality()}>
                Retry full quality
              </button>
            </Show>
            <Show when={m().ram === "limited"}>
              <p>The oldest history states were freed to stay within the Memory Usage set in Preferences.</p>
            </Show>
            <Show when={m().ram === "exhausted"}>
              <p>The browser ran out of memory, so undo history was cleared. Save your work, and close documents you don't need.</p>
            </Show>
            <div class="flex justify-end gap-2">
              <button type="button" class="rounded-sm bg-raised px-2 py-0.5 hover:brightness-125" onClick={() => shell.preferences("performance")}>
                Performance Preferences…
              </button>
              <button
                type="button"
                class="rounded-sm bg-raised px-2 py-0.5 hover:brightness-125"
                onClick={() => {
                  editor.acknowledgeMemory();
                  setOpen(false);
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        </Show>
      </span>
    </Show>
  );
}
