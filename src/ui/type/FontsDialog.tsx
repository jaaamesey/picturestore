import { For, Show, createSignal, onSettled } from "solid-js";
import { cssFont, localFontsSupported, removeFont, uploadedFonts } from "../../fonts/service";
import { Button } from "../controls";
import { dismissable } from "../Popover";

/**
 * Type ▸ Manage Fonts: the fonts added to this browser (kept between
 * sessions), each file's faces shown in themselves; add more, remove one,
 * or use the fonts installed on this device where the browser allows it.
 */
export function FontsDialog(props: { onAdd: () => void; onUseInstalled: () => void; onClose: () => void }) {
  const [removing, setRemoving] = createSignal<string | null>(null);
  onSettled(() => dismissable(props.onClose));
  return (
    <div class="fixed inset-0 z-50 grid place-items-center bg-black/50">
      <div class="flex max-h-[80vh] w-[32rem] flex-col gap-3 rounded-sm border border-line bg-panel p-4 shadow-2xl" role="dialog" aria-label="Manage Fonts" data-testid="fonts-dialog">
        <h2 class="font-semibold">Added Fonts</h2>
        <div class="min-h-24 flex-1 overflow-y-auto rounded-xs border border-line bg-app">
          <Show when={uploadedFonts().length} fallback={<p class="p-3 text-dim">No fonts added yet. TrueType, OpenType and WOFF files can be added; they stay in this browser.</p>}>
            <For each={uploadedFonts()}>
              {(f) => (
                <div class="flex items-center gap-3 border-b border-line px-3 py-2" data-testid="added-font" data-font-file={f.name}>
                  <div class="min-w-0 flex-1">
                    <div class="truncate">{f.name}</div>
                    <div class="flex flex-wrap gap-x-3 text-dim">
                      <For each={f.fonts}>{(i) => <span style={{ ...cssFont(i), "font-size": "14px" }}>{`${i.ref.family} ${i.ref.style}`}</span>}</For>
                    </div>
                  </div>
                  <button
                    type="button"
                    class="rounded-sm px-2 py-0.5 text-dim hover:bg-raised hover:text-fg disabled:opacity-40"
                    data-testid="remove-font"
                    disabled={removing() === f.id}
                    onClick={() => {
                      setRemoving(f.id);
                      void removeFont(f.id).finally(() => setRemoving(null));
                    }}
                  >
                    Remove
                  </button>
                </div>
              )}
            </For>
          </Show>
        </div>
        <p class="text-dim">Type set in a removed font shows in brackets in the Character panel, as a missing font, until it's added again or replaced.</p>
        <div class="flex justify-between gap-2">
          <div class="flex gap-2">
            <Button testId="add-fonts" onClick={props.onAdd}>
              Add Fonts…
            </Button>
            <Show when={localFontsSupported()}>
              <Button testId="use-installed-fonts" onClick={props.onUseInstalled}>
                Use Installed Fonts
              </Button>
            </Show>
          </div>
          <Button primary testId="fonts-done" onClick={props.onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
