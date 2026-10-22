import { Show, useContext } from "solid-js";
import { runCommand } from "../../editor/commands";
import { AppContext } from "../context";
import { IconButton, Separator } from "../controls";
import { AntiAliasSelect, ColorSwatch, FontFields, SizeField } from "./CharacterPanel";
import { AlignmentButtons } from "./ParagraphPanel";
import { useTypeState } from "./state";

/**
 * The Type tools' options bar, as in Photoshop: orientation, font, size,
 * anti-aliasing, alignment, colour, Warp Text, the Character and Paragraph
 * panels, and — while editing — Cancel and Commit.
 */
export function TypeOptions() {
  const { editor, shell } = useContext(AppContext);
  const t = useTypeState();
  const toggleOrientation = () => {
    const next = t.orientation() === "vertical" ? "horizontal" : "vertical";
    if (t.target()) editor.type.update("Change Text Orientation", (c) => ({ ...c, orientation: next }));
    else editor.setTool(next === "vertical" ? (editor.tool().includes("mask") ? "type-mask-vertical" : "type-vertical") : editor.tool().includes("mask") ? "type-mask-horizontal" : "type-horizontal");
  };
  return (
    <>
      <IconButton icon="orientation" title="Toggle text orientation" testId="type-orientation" onClick={toggleOrientation} />
      <div class="flex w-72 gap-1">
        <FontFields t={t} testId="type-font" />
      </div>
      <div class="w-28">
        <SizeField t={t} testId="type-size" />
      </div>
      <AntiAliasSelect t={t} testId="type-anti-alias" />
      <AlignmentButtons t={t} justify={false} testId="type-align" />
      <ColorSwatch title="Set the text color" testId="type-color" color={t.color()} onChange={t.setColor} />
      <IconButton icon="warp" title="Create warped text" testId="type-warp" disabled={!t.target()} onClick={() => runCommand("type.warp", editor, shell)} />
      <IconButton
        icon="panels"
        title="Toggle the Character and Paragraph panels"
        testId="type-panels"
        active={shell.panelOpen("character") || shell.panelOpen("paragraph")}
        onClick={() => shell.togglePanelGroup(["character", "paragraph"])}
      />
      <Show when={editor.type.session()}>
        <Separator />
        <div class="ml-auto flex gap-1">
          <IconButton icon="x" title="Cancel any current edits (Esc)" testId="type-cancel" onClick={() => editor.type.discard()} />
          <IconButton icon="check" title="Commit any current edits (Ctrl+Enter)" testId="type-commit" onClick={() => editor.type.commit()} />
        </div>
      </Show>
    </>
  );
}
