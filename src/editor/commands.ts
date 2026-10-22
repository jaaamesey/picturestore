import { ADJUSTMENTS, type AdjustmentKind } from "../core/adjustments";
import { activeLayer } from "../core/document";
import { hasPixels, isClipped, isGroup, locate } from "../core/layers";
import { TOOLBAR } from "./tools";
import { TYPE_COMMANDS, type PanelName } from "./typeCommands";
import type { Editor } from "./editor";
import type { ToolId } from "./types";
import type { PreferencesPane } from "./preferences";
import type { SnapToOptions, ViewOptions } from "./viewOptions";

/** UI-level actions commands can trigger (dialogs, file pickers, downloads). */
export interface Shell {
  newDocument(): void;
  open(): void;
  /** Save to the document's file (PSD), asking where if it has none. */
  save(): void;
  saveAs(): void;
  exportAs(format: "png" | "jpeg" | "webp"): void;
  /** Edit ▸ Preferences, optionally opening a given pane. */
  preferences(pane?: PreferencesPane): void;
  /** Image ▸ Canvas Size dialog. */
  canvasSize(): void;
  /** Image ▸ Image Size dialog. */
  imageSize(): void;
  /** File ▸ Place Embedded: picks an image and places it as a smart object. */
  placeEmbedded(): void;
  /** Opens the active smart object's contents as a document. */
  editContents(): void;
  /** View ▸ Guides ▸ New Guide dialog. */
  newGuide(): void;
  /** Image ▸ Adjustments: the adjustment's dialog (with Preview), applied to the layer. */
  adjust(kind: AdjustmentKind): void;
  /**
   * Delete Layer; for a group, asks whether to delete its contents too, as
   * Photoshop does. From the Layers panel's trash with the mask targeted, it
   * removes the mask instead (asking whether to apply it).
   */
  deleteLayer(fromPanel?: boolean): void;
  /** Copy/Cut also put a PNG on the system clipboard; Paste reads it (or our own copy). */
  copy(merged: boolean): void;
  cut(): void;
  paste(inPlace: boolean): void;
  /** Window ▸ a panel: opens it, or closes it if it's open. */
  togglePanel(id: PanelName): void;
  panelOpen(id: PanelName): boolean;
  /** Opens or closes panels together (the Type tools' Character and Paragraph button). */
  togglePanelGroup(ids: readonly PanelName[]): void;
  /** Type ▸ Warp Text dialog. */
  warpText(): void;
  /** Type ▸ Add Fonts: picks font files and keeps them in this browser. */
  addFonts(): void;
  /** Type ▸ Manage Fonts dialog. */
  manageFonts(): void;
}

export interface CommandSpec {
  readonly label: string;
  /** A label that depends on the state (Merge Down is Merge Group on a group). */
  readonly title?: (ed: Editor) => string;
  /** First is shown in menus. "Mod" is Ctrl, or Cmd on macOS. */
  readonly shortcuts?: readonly string[];
  readonly run: (ed: Editor, shell: Shell) => void;
  readonly enabled?: (ed: Editor) => boolean;
  /** For toggles: shown with a check mark when true. */
  readonly checked?: (ed: Editor, shell: Shell) => boolean;
}

const hasDoc = (ed: Editor) => ed.active() !== null;

type ViewFlag = { [K in keyof ViewOptions]: ViewOptions[K] extends boolean ? K : never }[keyof ViewOptions];
const viewToggle = (label: string, key: ViewFlag, shortcuts?: string[]): CommandSpec => ({
  label,
  shortcuts,
  run: (ed) => ed.setViewOptions({ [key]: !ed.viewOptions()[key] }),
  checked: (ed) => ed.viewOptions()[key],
});
const snapToToggle = (label: string, key: keyof SnapToOptions): CommandSpec => ({
  label,
  run: (ed) => ed.setViewOptions({ snapTo: { ...ed.viewOptions().snapTo, [key]: !ed.viewOptions().snapTo[key] } }),
  checked: (ed) => ed.viewOptions().snapTo[key],
});
const hasSelection = (ed: Editor) => !!ed.active()?.doc().selection;
const cropping = (ed: Editor) => ed.tool() === "crop" || ed.tool() === "perspective-crop";
const current = (ed: Editor) => {
  const d = ed.active()?.doc();
  return d && activeLayer(d);
};
const layerKind = (ed: Editor) => current(ed)?.content.kind;
/** Where the active layer is in its container. */
const place = (ed: Editor) => {
  const d = ed.active()?.doc();
  return d ? locate(d.layers, d.activeLayerId) : null;
};
const canDelete = (ed: Editor) => {
  const p = place(ed);
  return !!p && (!!p.parent || p.siblings.length > 1);
};
/** What Merge Down (Ctrl+E) can do here: Merge Group, Merge Clipping Mask, or into a layer with pixels below. */
const canMerge = (ed: Editor) => {
  const p = place(ed);
  if (!p) return false;
  const l = p.siblings[p.index];
  if (isGroup(l)) return true;
  if (!isClipped(p.siblings, p.index) && p.siblings[p.index + 1]?.clipped) return hasPixels(l);
  const below = p.siblings[p.index - 1];
  return !!below && hasPixels(below);
};
const hasMask = (ed: Editor) => !!current(ed)?.mask;
const canAddMask = (ed: Editor) => !!current(ed) && !current(ed)!.mask;

type AdjustmentCommands<P extends string> = { readonly [K in AdjustmentKind as `${P}.${K}`]: CommandSpec };

/** Layer ▸ New Adjustment Layer ▸ … */
const newAdjustmentLayers = Object.fromEntries(
  ADJUSTMENTS.map(({ kind, label }) => [`layer.adjustment.${kind}`, { label: `${label}…`, run: (ed: Editor) => ed.newAdjustmentLayer(kind), enabled: hasDoc }]),
) as unknown as AdjustmentCommands<"layer.adjustment">;

/** Photoshop's shortcuts for Image ▸ Adjustments. */
const ADJUST_SHORTCUTS: Partial<Record<AdjustmentKind, string[]>> = {
  levels: ["Mod+L"],
  curves: ["Mod+M"],
  "hue-saturation": ["Mod+U"],
  "color-balance": ["Mod+B"],
  "black-white": ["Alt+Shift+Mod+B"],
  invert: ["Mod+I"],
};

/** Image ▸ Adjustments ▸ …: a dialog for each (Invert just applies). */
const imageAdjustments = Object.fromEntries(
  ADJUSTMENTS.map(({ kind, label }) => [
    `image.adjust.${kind}`,
    {
      label: kind === "invert" ? label : `${label}…`,
      shortcuts: ADJUST_SHORTCUTS[kind],
      run: (ed: Editor, s: Shell) => (kind === "invert" ? ed.applyAdjustment({ kind: "invert" }) : s.adjust(kind)),
      enabled: hasDoc,
    },
  ]),
) as unknown as AdjustmentCommands<"image.adjust">;

/**
 * Every command, keyed by a stable id. Ids are typed (see {@link CommandId}),
 * so menus and shortcut tables can't reference commands that don't exist.
 * Order matters for shortcut lookup: the first command claiming a key wins.
 */
export const COMMANDS = {
  // File
  "file.new": { label: "New…", shortcuts: ["Alt+Mod+N"], run: (_, s) => s.newDocument() },
  "file.open": { label: "Open…", shortcuts: ["Mod+O"], run: (_, s) => s.open() },
  "file.save": { label: "Save", shortcuts: ["Mod+S"], run: (_, s) => s.save(), enabled: hasDoc },
  "file.saveAs": { label: "Save as PSD…", shortcuts: ["Mod+Shift+S"], run: (_, s) => s.saveAs(), enabled: hasDoc },
  "file.placeEmbedded": { label: "Place Embedded…", run: (_, s) => s.placeEmbedded(), enabled: hasDoc },
  "file.export.png": { label: "Export as PNG", shortcuts: ["Alt+Shift+Mod+W"], run: (_, s) => s.exportAs("png"), enabled: hasDoc },
  "file.export.jpeg": { label: "Export as JPG", run: (_, s) => s.exportAs("jpeg"), enabled: hasDoc },
  "file.export.webp": { label: "Export as WebP", run: (_, s) => s.exportAs("webp"), enabled: hasDoc },
  "file.close": {
    label: "Close",
    shortcuts: ["Alt+Mod+W"],
    run: (ed) => ed.active() && ed.closeDocument(ed.active()!.id),
    enabled: hasDoc,
  },

  // Edit
  "edit.undo": { label: "Undo", shortcuts: ["Mod+Z"], run: (ed) => ed.undo(), enabled: (ed) => ed.canUndo() || ed.tool() === "transform" },
  "edit.redo": { label: "Redo", shortcuts: ["Mod+Shift+Z", "Mod+Y"], run: (ed) => ed.redo(), enabled: (ed) => ed.canRedo() },
  "edit.cut": { label: "Cut", shortcuts: ["Mod+X"], run: (_, s) => s.cut(), enabled: hasDoc },
  "edit.copy": { label: "Copy", shortcuts: ["Mod+C"], run: (_, s) => s.copy(false), enabled: hasDoc },
  "edit.copyMerged": { label: "Copy Merged", shortcuts: ["Mod+Shift+C"], run: (_, s) => s.copy(true), enabled: hasDoc },
  "edit.paste": { label: "Paste", shortcuts: ["Mod+V"], run: (_, s) => s.paste(false), enabled: hasDoc },
  "edit.pasteInPlace": { label: "Paste in Place", shortcuts: ["Mod+Shift+V"], run: (_, s) => s.paste(true), enabled: hasDoc },
  "edit.fillForeground": {
    label: "Fill with Foreground",
    shortcuts: ["Alt+Backspace", "Alt+Delete"],
    run: (ed) => ed.fill(ed.foreground()),
    enabled: hasDoc,
  },
  "edit.fillBackground": {
    label: "Fill with Background",
    shortcuts: ["Mod+Backspace", "Mod+Delete"],
    run: (ed) => ed.fill(ed.background()),
    enabled: hasDoc,
  },
  "edit.clear": { label: "Clear", shortcuts: ["Delete", "Backspace"], run: (ed) => ed.clear(), enabled: hasDoc },
  "edit.preferences": { label: "General…", shortcuts: ["Mod+K"], run: (_, s) => s.preferences("general") },
  "edit.preferences.fileHandling": { label: "File Handling…", run: (_, s) => s.preferences("fileHandling") },
  "edit.preferences.performance": { label: "Performance…", run: (_, s) => s.preferences("performance") },
  "edit.freeTransform": {
    label: "Free Transform",
    // Browsers reserve Ctrl+T, so Alt+Ctrl+T is the primary binding (as in Photopea).
    shortcuts: ["Alt+Mod+T", "Mod+T"],
    run: (ed) => ed.freeTransform(),
    enabled: hasDoc,
  },
  "edit.transform.scale": { label: "Scale", run: (ed) => ed.freeTransform("scale"), enabled: hasDoc },
  "edit.transform.rotate": { label: "Rotate", run: (ed) => ed.freeTransform("rotate"), enabled: hasDoc },
  "edit.transform.skew": { label: "Skew", run: (ed) => ed.freeTransform("skew"), enabled: hasDoc },
  "edit.transform.distort": { label: "Distort", run: (ed) => ed.freeTransform("distort"), enabled: hasDoc },
  "edit.transform.perspective": { label: "Perspective", run: (ed) => ed.freeTransform("perspective"), enabled: hasDoc },
  "edit.transform.warp": { label: "Warp", run: (ed) => ed.freeTransform("warp"), enabled: hasDoc },
  "edit.transform.rotate180": { label: "Rotate 180°", run: (ed) => ed.transformCommand("rotate-180"), enabled: hasDoc },
  "edit.transform.rotate90cw": { label: "Rotate 90° Clockwise", run: (ed) => ed.transformCommand("rotate-90-cw"), enabled: hasDoc },
  "edit.transform.rotate90ccw": {
    label: "Rotate 90° Counter Clockwise",
    run: (ed) => ed.transformCommand("rotate-90-ccw"),
    enabled: hasDoc,
  },
  "edit.transform.flipHorizontal": { label: "Flip Horizontal", run: (ed) => ed.transformCommand("flip-horizontal"), enabled: hasDoc },
  "edit.transform.flipVertical": { label: "Flip Vertical", run: (ed) => ed.transformCommand("flip-vertical"), enabled: hasDoc },

  // Image
  "image.imageSize": { label: "Image Size…", shortcuts: ["Alt+Mod+I"], run: (_, s) => s.imageSize(), enabled: hasDoc },
  "image.canvasSize": { label: "Canvas Size…", shortcuts: ["Alt+Mod+C"], run: (_, s) => s.canvasSize(), enabled: hasDoc },
  "image.crop": { label: "Crop", run: (ed) => ed.cropToSelection(), enabled: hasSelection },
  ...imageAdjustments,
  "image.desaturate": { label: "Desaturate", shortcuts: ["Shift+Mod+U"], run: (ed) => ed.desaturate(), enabled: hasDoc },
  "image.equalize": { label: "Equalize", run: (ed) => ed.equalize(), enabled: hasDoc },
  "crop.commit": { label: "Crop", run: (ed) => ed.commitTool(), enabled: cropping },
  "crop.reset": { label: "Reset Crop", run: (ed) => ed.cancelTool(), enabled: cropping },
  "crop.rotateBox": { label: "Rotate Crop Box", run: (ed) => ed.rotateCropBox(), enabled: (ed) => ed.tool() === "crop" },

  // Layer
  "layer.new": { label: "New Layer", shortcuts: ["Mod+Shift+N"], run: (ed) => ed.newLayer(), enabled: hasDoc },
  "layer.duplicate": { label: "Duplicate Layer", run: (ed) => ed.duplicateLayer(), enabled: hasDoc },
  "layer.delete": { label: "Delete Layer", run: (_, s) => s.deleteLayer(), enabled: canDelete },
  "layer.mergeDown": { label: "Merge Down", title: (ed) => ed.mergeLabel() ?? "Merge Down", shortcuts: ["Mod+E"], run: (ed) => ed.mergeDown(), enabled: canMerge },
  "layer.newGroup": { label: "Group…", run: (ed) => ed.newGroup(), enabled: hasDoc },
  "layer.group": { label: "Group Layers", shortcuts: ["Mod+G"], run: (ed) => ed.groupLayers(), enabled: hasDoc },
  "layer.ungroup": { label: "Ungroup Layers", shortcuts: ["Shift+Mod+G"], run: (ed) => ed.ungroup(), enabled: (ed) => layerKind(ed) === "group" },
  "layer.clippingMask": {
    label: "Create Clipping Mask",
    shortcuts: ["Alt+Mod+G"],
    run: (ed) => ed.toggleClippingMask(),
    enabled: (ed) => (place(ed)?.index ?? 0) > 0,
  },
  "layer.releaseClippingMask": { label: "Release Clipping Mask", run: (ed) => ed.toggleClippingMask(), enabled: (ed) => !!current(ed)?.clipped && (place(ed)?.index ?? 0) > 0 },
  "layer.mask.revealAll": { label: "Reveal All", run: (ed) => ed.addMask(false), enabled: (ed) => canAddMask(ed) && !hasSelection(ed) },
  "layer.mask.hideAll": { label: "Hide All", run: (ed) => ed.addMask(true), enabled: (ed) => canAddMask(ed) && !hasSelection(ed) },
  "layer.mask.revealSelection": { label: "Reveal Selection", run: (ed) => ed.addMask(false), enabled: (ed) => canAddMask(ed) && hasSelection(ed) },
  "layer.mask.hideSelection": { label: "Hide Selection", run: (ed) => ed.addMask(true), enabled: (ed) => canAddMask(ed) && hasSelection(ed) },
  "layer.mask.delete": { label: "Delete", run: (ed) => ed.deleteMask(), enabled: hasMask },
  "layer.mask.apply": { label: "Apply", run: (ed) => ed.applyMask(), enabled: (ed) => hasMask(ed) && layerKind(ed) === "pixels" },
  "layer.mask.disable": {
    label: "Disable",
    run: (ed) => {
      const l = current(ed)!;
      ed.setMaskProps(l.id, { enabled: !l.mask!.enabled });
    },
    enabled: hasMask,
    checked: (ed) => current(ed)?.mask?.enabled === false,
  },
  ...newAdjustmentLayers,

  "layer.bringToFront": { label: "Bring to Front", shortcuts: ["Mod+Shift+]"], run: (ed) => ed.arrange("front"), enabled: hasDoc },
  "layer.bringForward": { label: "Bring Forward", shortcuts: ["Mod+]"], run: (ed) => ed.arrange("forward"), enabled: hasDoc },
  "layer.sendBackward": { label: "Send Backward", shortcuts: ["Mod+["], run: (ed) => ed.arrange("backward"), enabled: hasDoc },
  "layer.sendToBack": { label: "Send to Back", shortcuts: ["Mod+Shift+["], run: (ed) => ed.arrange("back"), enabled: hasDoc },
  "layer.viaCopy": { label: "Layer via Copy", shortcuts: ["Mod+J"], run: (ed) => ed.layerViaCopy(), enabled: hasDoc },
  "layer.viaCut": { label: "Layer via Cut", shortcuts: ["Mod+Shift+J"], run: (ed) => ed.layerViaCut(), enabled: hasSelection },
  "layer.convertToSmart": {
    label: "Convert to Smart Object",
    run: (ed) => ed.convertToSmartObject(),
    enabled: (ed) => layerKind(ed) === "pixels" || layerKind(ed) === "shape",
  },
  "layer.editContents": { label: "Edit Contents", run: (_, s) => s.editContents(), enabled: (ed) => layerKind(ed) === "smart" },
  "layer.rasterize": {
    label: "Rasterize Layer",
    run: (ed) => ed.rasterizeLayer(),
    enabled: (ed) => layerKind(ed) === "smart" || layerKind(ed) === "shape" || layerKind(ed) === "text",
  },
  ...TYPE_COMMANDS,

  // Select
  "select.all": { label: "All", shortcuts: ["Mod+A"], run: (ed) => ed.selectAll(), enabled: hasDoc },
  "select.deselect": { label: "Deselect", shortcuts: ["Mod+D"], run: (ed) => ed.deselect(), enabled: hasSelection },
  "select.inverse": { label: "Inverse", shortcuts: ["Mod+Shift+I"], run: (ed) => ed.invertSelection(), enabled: hasDoc },

  // View
  "view.zoomIn": { label: "Zoom In", shortcuts: ["Mod+="], run: (ed) => ed.zoomIn(), enabled: hasDoc },
  "view.zoomOut": { label: "Zoom Out", shortcuts: ["Mod+-"], run: (ed) => ed.zoomOut(), enabled: hasDoc },
  "view.fit": { label: "Fit The Area", shortcuts: ["Mod+0"], run: (ed) => ed.fitOnScreen(), enabled: hasDoc },
  "view.actual": { label: "Pixel to Pixel", shortcuts: ["Mod+1"], run: (ed) => ed.actualPixels(), enabled: hasDoc },
  "view.extras": viewToggle("Extras", "extras", ["Mod+H"]),
  "view.show.guides": viewToggle("Guides", "showGuides", ["Mod+;"]),
  "view.show.grid": viewToggle("Grid", "showGrid", ["Mod+'"]),
  "view.show.smartGuides": viewToggle("Smart Guides", "showSmartGuides"),
  "view.rulers": viewToggle("Rulers", "rulers", ["Mod+R"]),
  "view.snap": viewToggle("Snap", "snap", ["Shift+Mod+;"]),
  "view.snapTo.guides": snapToToggle("Guides", "guides"),
  // As in Photoshop, the grid is a target only while it's shown.
  "view.snapTo.grid": { ...snapToToggle("Grid", "grid"), enabled: (ed) => ed.viewOptions().showGrid },
  "view.snapTo.layers": snapToToggle("Layers", "layers"),
  "view.snapTo.bounds": snapToToggle("Document Bounds", "bounds"),
  "view.snapTo.all": { label: "All", run: (ed) => ed.setViewOptions({ snapTo: { guides: true, grid: true, layers: true, bounds: true } }) },
  "view.snapTo.none": { label: "None", run: (ed) => ed.setViewOptions({ snapTo: { guides: false, grid: false, layers: false, bounds: false } }) },
  "view.lockGuides": viewToggle("Lock Guides", "lockGuides", ["Alt+Mod+;"]),
  "view.clearGuides": { label: "Clear Guides", run: (ed) => ed.clearGuides(), enabled: (ed) => !!ed.active()?.doc().guides?.length },
  "view.newGuide": { label: "New Guide…", run: (_, s) => s.newGuide(), enabled: hasDoc },
} as const satisfies Record<string, CommandSpec>;

export type CommandId = keyof typeof COMMANDS;

export const command = (id: CommandId): CommandSpec => COMMANDS[id];

export const isEnabled = (id: CommandId, ed: Editor) => command(id).enabled?.(ed) ?? true;

export const runCommand = (id: CommandId, ed: Editor, shell: Shell) => {
  if (isEnabled(id, ed)) command(id).run(ed, shell);
};

const COMMAND_IDS = Object.keys(COMMANDS) as CommandId[];

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
  // Brackets, ; and ' by physical key: Shift turns them into other characters.
  const physical: Record<string, string> = { "[": "BracketLeft", "]": "BracketRight", ";": "Semicolon", "'": "Quote" };
  if (key in physical) return e.code === physical[key];
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

export const findCommand = (e: KeyLike): CommandId | undefined =>
  COMMAND_IDS.find((id) => command(id).shortcuts?.some((s) => matchShortcut(s, e)));

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
