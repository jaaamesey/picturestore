import { For, Show, createSignal, useContext } from "solid-js";
import { AppContext } from "../context";
import { IconButton } from "../controls";

/**
 * Window ▸ Character Styles and Paragraph Styles: the document's named
 * styles. Click one to apply it to the selected text (or the active type
 * layer); a "+" marks a selection that's been formatted differently since
 * (an override). Clear Override, Redefine by Merging Overrides, New and
 * Delete are along the bottom; double-click a name to rename it.
 */
export function StylesPanel(props: { kind: "character" | "paragraph" }) {
  const { editor } = useContext(AppContext);
  const s = () => editor.type.styles;
  const list = () => s().list()[props.kind];
  const sel = () => s().selection(props.kind);
  const [renaming, setRenaming] = createSignal<string | null>(null);
  const label = props.kind === "character" ? "Character" : "Paragraph";
  const row = (id: string | null, name: string) => {
    const current = () => sel().id === id && !!editor.type.target();
    return (
      <div
        role="option"
        aria-selected={current() ? "true" : "false"}
        data-style={name}
        class={["flex cursor-default items-center px-2 py-0.5", current() ? "bg-accent text-white" : "hover:bg-raised"]}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => s().apply(props.kind, id)}
        onDblClick={() => id && setRenaming(id)}
      >
        <Show
          when={renaming() === id && id}
          fallback={
            <span class="flex-1 truncate">
              {name}
              {current() && sel().overridden ? "+" : ""}
            </span>
          }
        >
          <input
            class="flex-1"
            data-testid="style-rename"
            value={name}
            ref={(el) => queueMicrotask(() => el.select())}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setRenaming(null);
            }}
            onBlur={(e) => {
              if (renaming()) s().rename(props.kind, id!, e.currentTarget.value);
              setRenaming(null);
            }}
          />
        </Show>
      </div>
    );
  };
  return (
    <div class="flex min-h-0 flex-1 flex-col" data-testid={`${props.kind}-styles`}>
      <div class="min-h-0 flex-1 overflow-y-auto py-1" role="listbox" aria-label={`${label} Styles`}>
        {row(null, props.kind === "character" ? "None" : "Basic Paragraph")}
        <For each={list()}>{(st) => row(st.id, st.name)}</For>
      </div>
      <div class="flex justify-end gap-0.5 border-t border-line px-1 py-0.5">
        <IconButton icon="undo" title="Clear Override" testId={`${props.kind}-style-clear`} disabled={!sel().id || !sel().overridden} onClick={() => s().clearOverride(props.kind)} />
        <IconButton icon="check" title={`Redefine ${label} Style by Merging Overrides`} testId={`${props.kind}-style-redefine`} disabled={!sel().id || !sel().overridden} onClick={() => s().redefine(props.kind)} />
        <IconButton icon="plus" title={`Create new ${label} Style`} testId={`${props.kind}-style-new`} onClick={() => s().create(props.kind)} />
        <IconButton icon="trash" title={`Delete current ${label} Style`} testId={`${props.kind}-style-delete`} disabled={!sel().id} onClick={() => sel().id && s().remove(props.kind, sel().id!)} />
      </div>
    </div>
  );
}
