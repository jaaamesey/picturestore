import type { JSX } from "@solidjs/web";
import { For, createEffect } from "solid-js";
import type { Alignment, ParagraphStyle } from "../../text/model";
import { Icon, type IconName } from "../icons";
import { ComboField } from "./fields";
import { useTypeState, type TypeState } from "./state";

/** Photoshop's limit for indents and paragraph spacing, in points. */
const MAX_INDENT_PT = 1296;

export const ALIGNMENTS: readonly { readonly id: Alignment; readonly icon: IconName; readonly title: string; readonly vertical: string; readonly justify: boolean }[] = [
  { id: "left", icon: "align-left", title: "Left align text", vertical: "Top align text", justify: false },
  { id: "center", icon: "align-center", title: "Center text", vertical: "Center text", justify: false },
  { id: "right", icon: "align-right", title: "Right align text", vertical: "Bottom align text", justify: false },
  { id: "justify-left", icon: "justify-left", title: "Justify last left", vertical: "Justify last top", justify: true },
  { id: "justify-center", icon: "justify-center", title: "Justify last centered", vertical: "Justify last centered", justify: true },
  { id: "justify-right", icon: "justify-right", title: "Justify last right", vertical: "Justify last bottom", justify: true },
  { id: "justify-all", icon: "justify-all", title: "Justify all", vertical: "Justify all", justify: true },
];

/** The alignment buttons (the first three on the options bar); justification is for paragraph type only. */
export function AlignmentButtons(props: { t: TypeState; justify: boolean; testId: string }) {
  const point = () => {
    const f = props.t.target()?.content.frame.kind;
    return f === "point" || f === "path";
  };
  const vertical = () => props.t.orientation() === "vertical";
  return (
    <div class="flex gap-0.5" role="radiogroup" aria-label="Alignment">
      <For each={ALIGNMENTS.filter((a) => props.justify || !a.justify)}>
        {(a) => (
          <button
            type="button"
            role="radio"
            title={vertical() ? a.vertical : a.title}
            aria-label={vertical() ? a.vertical : a.title}
            aria-checked={props.t.para("align") === a.id ? "true" : "false"}
            data-testid={`${props.testId}-${a.id}`}
            disabled={a.justify && point()}
            class={["grid size-6 place-items-center rounded-xs disabled:opacity-35", props.t.para("align") === a.id ? "bg-accent-soft text-white" : "hover:bg-raised"]}
            onClick={() => props.t.setPara({ align: a.id })}
          >
            <Icon name={a.icon} size={16} class={vertical() ? "rotate-90" : undefined} />
          </button>
        )}
      </For>
    </div>
  );
}

const icon = (s: string): JSX.Element => <span class="font-serif text-[10px] leading-none">{s}</span>;

/** Window ▸ Paragraph: Photoshop's Paragraph panel. */
export function ParagraphPanel() {
  const t = useTypeState();
  const length = (k: keyof ParagraphStyle & ("indentStart" | "indentEnd" | "indentFirst" | "spaceBefore" | "spaceAfter"), title: string, glyph: string, axis: "x" | "y") => (
    <ComboField
      icon={icon(glyph)}
      title={title}
      testId={`para-${k}`}
      value={t.show(t.para(k), axis)}
      onCommit={(text) => {
        const px = t.parse(text, axis, true);
        const max = t.toText(MAX_INDENT_PT, axis);
        if (px !== null) t.setPara({ [k]: Math.min(max, Math.max(k.startsWith("space") ? 0 : -max, px)) }, k);
      }}
    />
  );
  return (
    <div class="flex flex-col gap-2 overflow-y-auto p-2" data-testid="paragraph">
      <AlignmentButtons t={t} justify testId="para-align" />
      <div class="grid grid-cols-2 gap-x-2 gap-y-1.5">
        {length("indentStart", "Indent left margin", "→|", "x")}
        {length("indentEnd", "Indent right margin", "|←", "x")}
        {length("indentFirst", "Indent first line", "→¶", "x")}
        <span />
        {length("spaceBefore", "Add space before paragraph", "↑¶", "y")}
        {length("spaceAfter", "Add space after paragraph", "↓¶", "y")}
      </div>
      <label class="flex items-center gap-1.5" title="Hyphenate words that don't fit">
        <input
          type="checkbox"
          data-testid="para-hyphenate"
          checked={t.para("hyphenate") ?? false}
          ref={(el) => createEffect(() => t.para("hyphenate") === undefined, (mixed) => void (el.indeterminate = mixed))}
          onChange={(e) => t.setPara({ hyphenate: e.currentTarget.checked })}
        />
        <span>Hyphenate</span>
      </label>
    </div>
  );
}
