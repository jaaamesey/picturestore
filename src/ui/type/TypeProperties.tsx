import { For, Show, createMemo } from "solid-js";
import { fontFamilies } from "../../fonts/service";
import { fontLibrary } from "../../text/engine";
import { Slider } from "../AdjustmentControls";
import { AntiAliasSelect, ColorSwatch, FontFields, SizeField } from "./CharacterPanel";
import { AlignmentButtons } from "./ParagraphPanel";
import { useTypeState } from "./state";

/**
 * Properties for a type layer, as Photoshop's Properties panel has them:
 * the common Character and Paragraph settings, and a slider for each axis
 * of a variable font (weight, width, slant, optical size…), from the named
 * instance's values.
 */
export function TypeProperties() {
  const t = useTypeState();
  const info = createMemo(() => {
    fontFamilies();
    const f = t.font();
    return f ? fontLibrary().find(f) : undefined;
  });
  const axes = () => info()?.axes.filter((a) => !a.hidden) ?? [];
  const variations = () => t.char("variations");
  const valueOf = (tag: string, fallback: number) => variations()?.[tag] ?? info()?.coords[tag] ?? fallback;
  return (
    <div class="space-y-3" data-testid="type-properties">
      <div class="font-semibold">Character</div>
      <div class="flex gap-1">
        <FontFields t={t} testId="props-font" />
      </div>
      <div class="grid grid-cols-2 items-center gap-2">
        <SizeField t={t} testId="props-size" />
        <ColorSwatch title="Set the text color" testId="props-color" color={t.color()} onChange={t.setColor} />
      </div>
      <Show when={axes().length}>
        <div class="space-y-1" data-testid="variable-axes">
          <div class="text-dim">Variable Font</div>
          <For each={axes()}>
            {(a) => (
              <Slider
                label={a.name}
                value={Math.round(valueOf(a.tag, a.default) * 10) / 10}
                min={a.min}
                max={a.max}
                step={a.max - a.min > 20 ? 1 : 0.1}
                onChange={(v) => t.setChar((s) => ({ variations: { ...s.variations, [a.tag]: v } }), `axis:${a.tag}`)}
              />
            )}
          </For>
        </div>
      </Show>
      <div class="font-semibold">Paragraph</div>
      <AlignmentButtons t={t} justify testId="props-align" />
      <AntiAliasSelect t={t} testId="props-anti-alias" />
    </div>
  );
}
