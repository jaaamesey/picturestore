import type { JSX } from "@solidjs/web";
import { For, Match, Show, Switch, createSignal, onSettled, untrack, useContext } from "solid-js";
import {
  HISTORY_STATES_RANGE,
  PREFERENCES_PANES,
  RECOVERY_INTERVALS,
  availableMemoryMB,
  defaultPreferences,
  memoryUsageRange,
  normalizePreferences,
  type Preferences,
  type PreferencesPane,
} from "../editor/preferences";
import { AppContext } from "./context";
import { Button, NumberField } from "./controls";

const AVAILABLE = PREFERENCES_PANES.filter((p) => p.available);

/** A titled group, like Photoshop's etched panels. */
function Group(props: { title: string; children: JSX.Element }) {
  return (
    <fieldset class="rounded-sm border border-line px-3 pt-1 pb-3">
      <legend class="px-1 text-dim">{props.title}</legend>
      <div class="space-y-2">{props.children}</div>
    </fieldset>
  );
}

/**
 * Edit ▸ Preferences (Ctrl+K). Organised as Photoshop's: panes on the left,
 * OK / Cancel / Prev / Next on the right. Changes apply on OK.
 */
export function PreferencesDialog(props: { pane: PreferencesPane; onClose: () => void }) {
  const { editor } = useContext(AppContext);
  const [pane, setPane] = createSignal<PreferencesPane>(untrack(() => props.pane));
  const [draft, setDraftSignal] = createSignal<Preferences>(untrack(() => editor.preferences()));
  // Read synchronously on OK (signal reads lag writes until Solid flushes).
  let current = untrack(draft);
  const setDraft = (p: Preferences) => {
    current = p;
    setDraftSignal(p);
  };
  const set = (patch: Partial<Preferences>) => setDraft(normalizePreferences({ ...current, ...patch }, current));
  const available = availableMemoryMB();
  const range = memoryUsageRange(available);

  const ok = () => {
    // A field being edited commits on blur, first.
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    editor.setPreferences(current);
    props.onClose();
  };
  const step = (dir: 1 | -1) => {
    const i = AVAILABLE.findIndex((p) => p.id === pane());
    setPane(AVAILABLE[(i + dir + AVAILABLE.length) % AVAILABLE.length].id);
  };

  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
      else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) ok();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  });

  return (
    <div class="fixed inset-0 z-50 grid place-items-center bg-black/50">
      <div class="flex h-[32rem] w-[48rem] rounded-sm border border-line bg-panel shadow-2xl" role="dialog" aria-label="Preferences" data-testid="preferences">
        <nav class="w-48 shrink-0 overflow-y-auto border-r border-line py-1" aria-label="Preferences panes">
          <For each={PREFERENCES_PANES}>
            {(p) => (
              <button
                type="button"
                disabled={!p.available}
                title={p.available ? undefined : "Not available yet"}
                data-testid={`prefs-pane-${p.id}`}
                aria-current={pane() === p.id ? "page" : undefined}
                class={[
                  "block w-full px-3 py-1 text-left disabled:text-dim/50",
                  pane() === p.id ? "bg-accent text-white" : "enabled:hover:bg-raised",
                ]}
                onClick={() => setPane(p.id)}
              >
                {p.label}
              </button>
            )}
          </For>
        </nav>
        <section class="min-w-0 flex-1 space-y-3 overflow-y-auto p-4">
          <Switch>
            <Match when={pane() === "general"}>
              <Group title="Options">
                <p class="text-dim">Preferences are kept in this browser.</p>
                <Button testId="prefs-reset" onClick={() => setDraft(defaultPreferences())}>
                  Reset Preferences to Defaults
                </Button>
              </Group>
            </Match>
            <Match when={pane() === "fileHandling"}>
              <Group title="File Saving Options">
                <label class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    data-testid="prefs-recovery-enabled"
                    checked={draft().recoveryMinutes > 0}
                    onChange={(e) => set({ recoveryMinutes: e.currentTarget.checked ? 10 : 0 })}
                  />
                  <span>Automatically Save Recovery Information Every:</span>
                  <select
                    data-testid="prefs-recovery-minutes"
                    disabled={draft().recoveryMinutes === 0}
                    value={draft().recoveryMinutes || 10}
                    onChange={(e) => set({ recoveryMinutes: Number(e.currentTarget.value) })}
                  >
                    <For each={RECOVERY_INTERVALS.filter((m) => m > 0)}>
                      {(m) => <option value={m}>{m === 1 ? "1 Minute" : `${m} Minutes`}</option>}
                    </For>
                  </select>
                </label>
                <p class="text-dim">
                  Unsaved documents are kept in browser storage so they can be recovered if the tab crashes or runs out of memory.
                </p>
              </Group>
            </Match>
            <Match when={pane() === "performance"}>
              <Group title="Memory Usage">
                <div class="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1">
                  <span class="text-dim">Available RAM:</span>
                  <span>{available} MB</span>
                  <span class="text-dim">Ideal Range:</span>
                  <span>
                    {range.ideal[0]}–{range.ideal[1]} MB
                  </span>
                </div>
                <div class="flex items-center gap-2">
                  <NumberField
                    label="Let Picturestore Use"
                    testId="prefs-memory"
                    value={draft().memoryUsageMB}
                    min={range.min}
                    max={range.max}
                    suffix={`MB (${Math.round((draft().memoryUsageMB / available) * 100)}%)`}
                    width="5rem"
                    onChange={(memoryUsageMB) => set({ memoryUsageMB })}
                  />
                </div>
                <input
                  type="range"
                  class="w-full"
                  aria-label="Memory usage"
                  min={range.min}
                  max={range.max}
                  value={draft().memoryUsageMB}
                  onInput={(e) => set({ memoryUsageMB: e.currentTarget.valueAsNumber })}
                />
                <p class="text-dim">
                  The memory open documents and their undo history may use. Past it, the oldest history states are freed (the
                  documents themselves never are).
                </p>
              </Group>
              <Group title="History & Cache">
                <NumberField
                  label="History States"
                  testId="prefs-history-states"
                  value={draft().historyStates}
                  min={HISTORY_STATES_RANGE.min}
                  max={HISTORY_STATES_RANGE.max}
                  onChange={(historyStates) => set({ historyStates })}
                />
              </Group>
              <Group title="Graphics Processor Settings">
                <div class="flex items-center gap-3">
                  <span class="text-dim">Display quality:</span>
                  <span data-testid="prefs-gpu-quality">
                    {editor.memory().gpuLevel === 0 ? "Full" : `Reduced (1/${1 << editor.memory().gpuLevel} resolution, low GPU memory)`}
                  </span>
                  <Show when={editor.memory().gpuLevel > 0}>
                    <Button onClick={() => editor.retryFullQuality()}>Retry Full Quality</Button>
                  </Show>
                </div>
              </Group>
            </Match>
          </Switch>
        </section>
        <div class="flex w-28 shrink-0 flex-col gap-2 border-l border-line p-3">
          <Button primary testId="prefs-ok" onClick={ok}>
            OK
          </Button>
          <Button testId="prefs-cancel" onClick={() => props.onClose()}>
            Cancel
          </Button>
          <div class="h-2" />
          <Button onClick={() => step(-1)}>Prev</Button>
          <Button onClick={() => step(1)}>Next</Button>
        </div>
      </div>
    </div>
  );
}
