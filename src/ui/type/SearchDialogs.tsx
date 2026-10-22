import type { JSX } from "@solidjs/web";
import { For, Show, createSignal, onSettled, useContext } from "solid-js";
import { addToDictionary, spellChecker, spellingCovers, type NSpell } from "../../text/spelling";
import type { FindOptions } from "../../text/search";
import { AppContext } from "../context";
import { Button } from "../controls";
import { dismissable } from "../Popover";

/** A dialog beside the canvas (not over it): the text it finds is selected where it is. */
function SideDialog(props: { title: string; testId: string; onClose: () => void; children: JSX.Element }) {
  onSettled(() => dismissable(props.onClose));
  return (
    <div class="fixed top-24 right-72 z-50 w-[26rem] rounded-sm border border-line bg-panel p-4 shadow-2xl" role="dialog" aria-label={props.title} data-testid={props.testId}>
      <div class="mb-3 font-semibold">{props.title}</div>
      {props.children}
    </div>
  );
}

const box = (label: string, testId: string, value: () => boolean, set: (v: boolean) => void) => (
  <label class="flex items-center gap-1.5">
    <input type="checkbox" data-testid={testId} checked={value()} onChange={(e) => set(e.currentTarget.checked)} />
    <span>{label}</span>
  </label>
);

/** Edit ▸ Find and Replace Text, as in Photoshop. */
export function FindReplaceDialog(props: { onClose: () => void }) {
  const { editor, notify } = useContext(AppContext);
  const [find, setFind] = createSignal("");
  const [change, setChange] = createSignal("");
  const [all, setAll] = createSignal(true);
  const [forward, setForward] = createSignal(true);
  const [caseSensitive, setCase] = createSignal(false);
  const [wholeWord, setWhole] = createSignal(false);
  const [ignoreAccents, setAccents] = createSignal(false);
  const o = (): FindOptions => ({ caseSensitive: caseSensitive(), wholeWord: wholeWord(), ignoreAccents: ignoreAccents(), backward: !forward() });
  const s = () => editor.type.search;
  const next = () => s().findNext(find(), o(), all()) || notify("Search completed. No more matches found.");
  const field = (label: string, testId: string, value: () => string, set: (v: string) => void) => (
    <label class="flex items-center gap-2">
      <span class="w-20">{label}</span>
      <input class="flex-1" data-testid={testId} value={value()} onInput={(e) => set(e.currentTarget.value)} onKeyDown={(e) => e.stopPropagation()} />
    </label>
  );
  return (
    <SideDialog title="Find and Replace Text" testId="find-replace" onClose={props.onClose}>
      <div class="flex gap-4">
        <div class="flex-1 space-y-2">
          {field("Find What:", "find-what", find, setFind)}
          {field("Change To:", "change-to", change, setChange)}
          <div class="grid grid-cols-2 gap-1">
            {box("Search All Layers", "find-all-layers", all, setAll)}
            {box("Forward", "find-forward", forward, setForward)}
            {box("Case Sensitive", "find-case", caseSensitive, setCase)}
            {box("Whole Word Only", "find-whole", wholeWord, setWhole)}
            {box("Ignore Accents", "find-accents", ignoreAccents, setAccents)}
          </div>
        </div>
        <div class="flex flex-col gap-1.5">
          <Button primary testId="find-next" onClick={next}>
            Find Next
          </Button>
          <Button testId="find-change" onClick={() => s().change(find(), change(), o())}>
            Change
          </Button>
          <Button
            testId="find-change-all"
            onClick={() => {
              const n = s().changeAll(find(), change(), o(), all());
              notify(n ? `Replaced ${n} ${n === 1 ? "occurrence" : "occurrences"}.` : "No matches found.");
            }}
          >
            Change All
          </Button>
          <Button testId="find-change-find" onClick={() => (s().change(find(), change(), o()), next())}>
            Change/Find
          </Button>
          <Button testId="find-done" onClick={props.onClose}>
            Done
          </Button>
        </div>
      </div>
    </SideDialog>
  );
}

/** Edit ▸ Check Spelling, as in Photoshop: each word the dictionary doesn't know, in turn. */
export function SpellingDialog(props: { onClose: () => void }) {
  const { editor } = useContext(AppContext);
  const [checker, setChecker] = createSignal<NSpell | null>(null);
  // Kept as a plain value too: a signal reads its old value until Solid flushes.
  let sp: NSpell | null = null;
  const [word, setWord] = createSignal<string | null>(null);
  const [changeTo, setChangeTo] = createSignal("");
  const [all, setAll] = createSignal(true);
  const [done, setDone] = createSignal(false);
  const ignored = new Set<string>();
  const advance = () => {
    if (!sp) return;
    const check = sp;
    const w = editor.type.search.nextMisspelling((x) => ignored.has(x) || check.correct(x), spellingCovers, all());
    setWord(w);
    setDone(!w);
    setChangeTo(w ? (check.suggest(w)[0] ?? w) : "");
  };
  void spellChecker().then((loaded) => {
    sp = loaded;
    setChecker(loaded);
    advance();
  });
  const suggestions = () => (word() && checker() ? checker()!.suggest(word()!) : []);
  const opts = { caseSensitive: true, wholeWord: true, ignoreAccents: false };
  return (
    <SideDialog title="Check Spelling" testId="spelling" onClose={props.onClose}>
      <div class="flex gap-4">
        <div class="flex-1 space-y-2">
          <Show when={checker()} fallback={<p class="text-dim">Loading the dictionary…</p>}>
            <Show when={!done()} fallback={<p data-testid="spelling-complete">Spell check complete.</p>}>
              <div>
                <span class="text-dim">Not in Dictionary: </span>
                <span data-testid="spelling-word">{word()}</span>
              </div>
              <label class="flex items-center gap-2">
                <span class="text-dim">Change To:</span>
                <input class="flex-1" data-testid="spelling-change-to" value={changeTo()} onInput={(e) => setChangeTo(e.currentTarget.value)} onKeyDown={(e) => e.stopPropagation()} />
              </label>
              <div class="h-28 overflow-y-auto rounded-xs border border-line bg-app" role="listbox" aria-label="Suggestions">
                <For each={suggestions()}>
                  {(sug) => (
                    <div role="option" aria-selected={sug === changeTo() ? "true" : "false"} class={["px-2 py-0.5", sug === changeTo() ? "bg-accent text-white" : "hover:bg-raised"]} onClick={() => setChangeTo(sug)}>
                      {sug}
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
          {box("Check All Layers", "spelling-all-layers", all, setAll)}
        </div>
        <div class="flex flex-col gap-1.5">
          <Button testId="spelling-ignore" onClick={advance}>
            Ignore
          </Button>
          <Button testId="spelling-ignore-all" onClick={() => (word() && ignored.add(word()!), advance())}>
            Ignore All
          </Button>
          <Button primary testId="spelling-change" onClick={() => (word() && editor.type.search.change(word()!, changeTo(), opts), advance())}>
            Change
          </Button>
          <Button testId="spelling-change-all" onClick={() => (word() && editor.type.search.changeAll(word()!, changeTo(), opts, all()), advance())}>
            Change All
          </Button>
          <Button testId="spelling-add" onClick={() => void (word() && addToDictionary(word()!).then(advance))}>
            Add
          </Button>
          <Button testId="spelling-done" onClick={props.onClose}>
            Done
          </Button>
        </div>
      </div>
    </SideDialog>
  );
}
