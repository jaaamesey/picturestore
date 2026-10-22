import { For, Show, createMemo, createSignal } from "solid-js";
import { cssFont, fontFamilies } from "../../fonts/service";
import { fontLibrary } from "../../text/engine";
import { useTypeState } from "./state";

/** Glyphs shown at once: a font can map tens of thousands of characters. */
const PAGE = 512;

/**
 * Window ▸ Glyphs: every character the current font maps, drawn in it;
 * double-click one to type it at the caret (or replace the selection), as
 * in Photoshop. Recently used glyphs are listed first.
 */
export function GlyphsPanel() {
  const t = useTypeState();
  const [recent, setRecent] = createSignal<string[]>([]);
  const [shown, setShown] = createSignal(PAGE);
  const font = () => t.char("font");
  const entry = createMemo(() => {
    const f = font();
    return f && fontFamilies().find((g) => g.family === f.family)?.fonts.find((g) => g.ref.style === f.style);
  });
  const chars = createMemo(() => {
    fontFamilies();
    const f = font();
    const face = f && fontLibrary().resolve(f);
    return face ? [...face.characters()].filter((c) => c > 0x20 && (c < 0x7f || c > 0x9f)).map((c) => String.fromCodePoint(c)) : [];
  });
  const insert = (ch: string) => {
    if (!t.editor.type.session()) return;
    t.editor.type.input(ch);
    setRecent((r) => [ch, ...r.filter((x) => x !== ch)].slice(0, 16));
  };
  const cell = (ch: string) => (
    <button
      type="button"
      title={`U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`}
      data-glyph={ch}
      class="grid h-8 place-items-center rounded-xs border border-line text-base hover:bg-raised"
      style={entry() ? cssFont(entry()!) : undefined}
      onPointerDown={(e) => e.preventDefault()}
      onDblClick={() => insert(ch)}
    >
      {ch}
    </button>
  );
  return (
    <div class="flex min-h-0 flex-1 flex-col gap-1 p-2" data-testid="glyphs">
      <Show when={recent().length}>
        <div class="text-dim">Recently Used</div>
        <div class="grid grid-cols-8 gap-0.5">
          <For each={recent()}>{cell}</For>
        </div>
      </Show>
      <div class="min-h-0 flex-1 overflow-y-auto" onScroll={(e) => e.currentTarget.scrollTop + e.currentTarget.clientHeight > e.currentTarget.scrollHeight - 64 && setShown((n) => n + PAGE)}>
        <div class="grid grid-cols-8 gap-0.5">
          <For each={chars().slice(0, shown())}>{cell}</For>
        </div>
      </div>
      <Show when={!chars().length}>
        <p class="text-dim">{font() ? "This font isn't available." : "Mixed fonts."}</p>
      </Show>
    </div>
  );
}
