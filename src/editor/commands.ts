import { TOOLBAR } from "./tools";
import type { Editor } from "./editor";
import type { ToolId } from "./types";

/** UI-level actions commands can trigger (dialogs, file pickers, downloads). */
export interface Shell {
  newDocument(): void;
  open(): void;
  save(): void;
  exportAs(format: "png" | "jpeg" | "webp" | "psd"): void;
}

export interface Command {
  readonly id: string;
  readonly label: string;
  /** First is shown in menus. "Mod" is Ctrl, or Cmd on macOS. */
  readonly shortcuts?: readonly string[];
  readonly run: (ed: Editor, shell: Shell) => void;
  readonly enabled?: (ed: Editor) => boolean;
}

const hasDoc = (ed: Editor) => ed.active() !== null;
const hasSelection = (ed: Editor) => !!ed.active()?.doc().selection;
const layerCount = (ed: Editor) => ed.active()?.doc().layers.length ?? 0;

const commandList: Command[] = [
  // File
  { id: "file.new", label: "New…", shortcuts: ["Alt+Mod+N"], run: (_, s) => s.newDocument() },
  { id: "file.open", label: "Open…", shortcuts: ["Mod+O"], run: (_, s) => s.open() },
  { id: "file.save", label: "Save (.pstore)", shortcuts: ["Mod+S"], run: (_, s) => s.save(), enabled: hasDoc },
  { id: "file.export.psd", label: "PSD", shortcuts: ["Mod+Shift+S"], run: (_, s) => s.exportAs("psd"), enabled: hasDoc },
  { id: "file.export.png", label: "PNG", shortcuts: ["Alt+Shift+Mod+W"], run: (_, s) => s.exportAs("png"), enabled: hasDoc },
  { id: "file.export.jpeg", label: "JPG", run: (_, s) => s.exportAs("jpeg"), enabled: hasDoc },
  { id: "file.export.webp", label: "WebP", run: (_, s) => s.exportAs("webp"), enabled: hasDoc },
  {
    id: "file.close",
    label: "Close",
    shortcuts: ["Alt+Mod+W"],
    run: (ed) => ed.active() && ed.closeDocument(ed.active()!.id),
    enabled: hasDoc,
  },

  // Edit
  { id: "edit.undo", label: "Undo", shortcuts: ["Mod+Z"], run: (ed) => ed.undo(), enabled: (ed) => ed.canUndo() },
  { id: "edit.redo", label: "Redo", shortcuts: ["Mod+Shift+Z", "Mod+Y"], run: (ed) => ed.redo(), enabled: (ed) => ed.canRedo() },
  {
    id: "edit.fillForeground",
    label: "Fill with Foreground",
    shortcuts: ["Alt+Backspace", "Alt+Delete"],
    run: (ed) => ed.fill(ed.foreground()),
    enabled: hasDoc,
  },
  {
    id: "edit.fillBackground",
    label: "Fill with Background",
    shortcuts: ["Mod+Backspace", "Mod+Delete"],
    run: (ed) => ed.fill(ed.background()),
    enabled: hasDoc,
  },
  { id: "edit.clear", label: "Clear", shortcuts: ["Delete", "Backspace"], run: (ed) => ed.clear(), enabled: hasDoc },
  {
    id: "edit.freeTransform",
    label: "Free Transform",
    // Browsers reserve Ctrl+T, so Alt+Ctrl+T is the primary binding (as in Photopea).
    shortcuts: ["Alt+Mod+T", "Mod+T"],
    run: (ed) => ed.freeTransform(),
    enabled: hasDoc,
  },

  // Layer
  { id: "layer.new", label: "New Layer", shortcuts: ["Mod+Shift+N"], run: (ed) => ed.newLayer(), enabled: hasDoc },
  { id: "layer.duplicate", label: "Duplicate Layer", shortcuts: ["Mod+J"], run: (ed) => ed.duplicateLayer(), enabled: hasDoc },
  { id: "layer.delete", label: "Delete Layer", run: (ed) => ed.deleteLayer(), enabled: (ed) => layerCount(ed) > 1 },
  {
    id: "layer.mergeDown",
    label: "Merge Down",
    shortcuts: ["Mod+E"],
    run: (ed) => ed.mergeDown(),
    enabled: (ed) => {
      const d = ed.active()?.doc();
      return !!d && d.layers.findIndex((l) => l.id === d.activeLayerId) > 0;
    },
  },

  // Select
  { id: "select.all", label: "All", shortcuts: ["Mod+A"], run: (ed) => ed.selectAll(), enabled: hasDoc },
  { id: "select.deselect", label: "Deselect", shortcuts: ["Mod+D"], run: (ed) => ed.deselect(), enabled: hasSelection },
  { id: "select.inverse", label: "Inverse", shortcuts: ["Mod+Shift+I"], run: (ed) => ed.invertSelection(), enabled: hasDoc },

  // View
  { id: "view.zoomIn", label: "Zoom In", shortcuts: ["Mod+="], run: (ed) => ed.zoomIn(), enabled: hasDoc },
  { id: "view.zoomOut", label: "Zoom Out", shortcuts: ["Mod+-"], run: (ed) => ed.zoomOut(), enabled: hasDoc },
  { id: "view.fit", label: "Fit The Area", shortcuts: ["Mod+0"], run: (ed) => ed.fitOnScreen(), enabled: hasDoc },
  { id: "view.actual", label: "Pixel to Pixel", shortcuts: ["Mod+1"], run: (ed) => ed.actualPixels(), enabled: hasDoc },
];

export const COMMANDS: Readonly<Record<string, Command>> = Object.fromEntries(commandList.map((c) => [c.id, c]));

export interface KeyLike {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

export function matchShortcut(shortcut: string, e: KeyLike): boolean {
  const parts = shortcut.split("+");
  const key = parts.pop() || "+";
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  if (mods.has("mod") !== (e.ctrlKey || e.metaKey)) return false;
  if (mods.has("shift") !== e.shiftKey) return false;
  if (mods.has("alt") !== e.altKey) return false;
  // Letters and digits match on physical key, so Alt combinations (which change `key` on macOS) work.
  if (/^[a-z]$/i.test(key)) return e.code === `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return e.code === `Digit${key}` || e.key === key;
  if (key === "=") return e.key === "=" || e.key === "+";
  return e.key.toLowerCase() === key.toLowerCase();
}

export function formatShortcut(shortcut: string, mac: boolean): string {
  if (!mac) return shortcut.replace("Mod", "Ctrl");
  const symbols: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥", Backspace: "⌫", Delete: "⌦" };
  return shortcut
    .split("+")
    .map((p) => symbols[p] ?? p)
    .join("");
}

export const findCommand = (e: KeyLike): Command | undefined =>
  commandList.find((c) => c.shortcuts?.some((s) => matchShortcut(s, e)));

/** Photoshop's [ and ] brush size steps. */
export function stepBrushSize(size: number, dir: 1 | -1): number {
  const step = size < 10 ? 1 : size < 50 ? 5 : size < 100 ? 10 : size < 300 ? 25 : 50;
  const next = dir > 0 ? size + step : size - (size <= 10 ? 1 : step);
  return Math.max(1, Math.min(2500, Math.round(next)));
}

/**
 * Tool for a single-letter shortcut: the current tool if it shares the key,
 * the next one in its group with Shift (e.g. Shift+M cycles marquees), else
 * the first tool with that key.
 */
export function toolForKey(key: string, current: ToolId, shift: boolean): ToolId | null {
  const group = TOOLBAR.filter((t) => t.key === key.toLowerCase());
  if (group.length === 0) return null;
  const i = group.findIndex((t) => t.id === current);
  if (i < 0) return group[0].id;
  return shift ? group[(i + 1) % group.length].id : current;
}
