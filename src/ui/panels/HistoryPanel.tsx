import { For, useContext } from "solid-js";
import { AppContext } from "../context";

export function HistoryPanel() {
  const { editor } = useContext(AppContext);
  const history = () => editor.active()?.history();
  return (
    <div class="min-h-0 flex-1 overflow-y-auto" role="listbox" aria-label="History">
        <For each={history()?.entries ?? []}>
          {(entry, i) => (
            <button
              type="button"
              role="option"
              data-testid="history-entry"
              aria-selected={i() === history()!.index ? "true" : "false"}
              class={[
                "block w-full px-2 py-1 text-left",
                i() === history()!.index ? "bg-accent-soft" : "hover:bg-raised",
                { "text-dim/60 italic": i() > history()!.index },
              ]}
              onClick={() => editor.jumpHistory(i())}
            >
              {entry.label}
            </button>
          )}
        </For>
    </div>
  );
}
