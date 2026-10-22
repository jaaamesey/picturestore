import type { PanelName } from "../editor/typeCommands";

/**
 * The panel dock's layout, as in Photoshop: a column of panel groups beside
 * the canvas, each a stack of tabbed panels showing one at a time. Its
 * width is set by dragging its edge; groups share its height, resized by
 * dragging the divider between two, and a group minimized (double-click its
 * tab) shows only its tabs. Window menu items open and close panels: a
 * panel opened that isn't docked comes back in its usual group (Character
 * with Paragraph, as Photoshop groups them), at the top.
 */

export type PanelId = PanelName;

export interface DockGroup {
  /** Its key: the panel it was opened for. */
  readonly id: PanelId;
  readonly tabs: readonly PanelId[];
  /** The tab in front. */
  readonly active: PanelId;
  /** Its share of the dock's height, in pixels at the size last set (heights scale with the dock). */
  readonly size: number;
  readonly minimized: boolean;
}

export interface DockLayout {
  readonly width: number;
  readonly groups: readonly DockGroup[];
}

export const PANEL_TITLES: Record<PanelId, string> = {
  history: "History",
  properties: "Properties",
  layers: "Layers",
  character: "Character",
  paragraph: "Paragraph",
  characterStyles: "Character Styles",
  paragraphStyles: "Paragraph Styles",
  glyphs: "Glyphs",
};

/** Photoshop's groupings, for panels opened from the Window menu. */
const USUAL_GROUPS: readonly (readonly PanelId[])[] = [["history"], ["properties"], ["layers"], ["character", "paragraph"], ["characterStyles", "paragraphStyles"], ["glyphs"]];

const group = (tabs: readonly PanelId[], size: number, active = tabs[0]): DockGroup => ({ id: tabs[0], tabs, active, size, minimized: false });

export const DEFAULT_DOCK: DockLayout = {
  width: 256,
  groups: [group(["history"], 192), group(["properties"], 240), group(["layers"], 420)],
};

export const DOCK_MIN_WIDTH = 200;
export const DOCK_MAX_WIDTH = 640;
/** A panel's smallest height, tab included. */
export const PANEL_MIN_HEIGHT = 72;
const OPENED_SIZE = 300;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const withWidth = (d: DockLayout, width: number): DockLayout => ({ ...d, width: Math.round(clamp(width, DOCK_MIN_WIDTH, DOCK_MAX_WIDTH)) });

const groupOf = (d: DockLayout, id: PanelId) => d.groups.find((g) => g.tabs.includes(id));
const mapGroup = (d: DockLayout, id: PanelId, f: (g: DockGroup) => DockGroup): DockLayout => ({ ...d, groups: d.groups.map((g) => (g.tabs.includes(id) ? f(g) : g)) });

/** Minimizes or restores the group a panel is in. */
export const toggleMinimized = (d: DockLayout, id: PanelId): DockLayout => mapGroup(d, id, (g) => ({ ...g, minimized: !g.minimized }));

/** Brings a docked panel's tab to the front. */
export const activateTab = (d: DockLayout, id: PanelId): DockLayout => mapGroup(d, id, (g) => ({ ...g, active: id }));

/** Whether a panel is open: docked and in front of its group (the Window menu's check). */
export const isOpen = (d: DockLayout, id: PanelId) => groupOf(d, id)?.active === id;

/** Opens a panel: to the front of its group, restored; one not docked comes back in its usual group, at the top. */
export function openPanel(d: DockLayout, id: PanelId): DockLayout {
  if (groupOf(d, id)) return mapGroup(d, id, (g) => ({ ...g, active: id, minimized: false }));
  const tabs = USUAL_GROUPS.find((u) => u.includes(id))!.filter((t) => t === id || !groupOf(d, t));
  return { ...d, groups: [group(tabs, OPENED_SIZE, id), ...d.groups] };
}

/** Closes a panel: its tab goes, and its group if it was the last. */
export function closePanel(d: DockLayout, id: PanelId): DockLayout {
  const g = groupOf(d, id);
  if (!g) return d;
  const tabs = g.tabs.filter((t) => t !== id);
  if (!tabs.length) return { ...d, groups: d.groups.filter((h) => h !== g) };
  const active = g.active === id ? tabs[Math.min(g.tabs.indexOf(id), tabs.length - 1)] : g.active;
  return { ...d, groups: d.groups.map((h) => (h === g ? { ...g, tabs, active } : h)) };
}

/** The Window menu's toggle: open in front, it closes; otherwise it opens. */
export const togglePanel = (d: DockLayout, id: PanelId): DockLayout => (isOpen(d, id) ? closePanel(d, id) : openPanel(d, id));

/** Opens or closes a group of panels together (the Type tools' panel button: Character and Paragraph). */
export function togglePanels(d: DockLayout, ids: readonly PanelId[]): DockLayout {
  const open = ids.some((id) => isOpen(d, id));
  return ids.reduce((acc, id) => (open ? closePanel(acc, id) : groupOf(acc, id) ? mapGroup(acc, id, (g) => ({ ...g, minimized: false })) : openPanel(acc, id)), d);
}

/**
 * The groups a divider (between group `i` and the next) resizes: the
 * nearest unminimized group at or above it and at or below it, if both exist.
 */
export function dividerPanels(d: DockLayout, i: number): [number, number] | null {
  let a = i, b = i + 1;
  while (a >= 0 && d.groups[a].minimized) a--;
  while (b < d.groups.length && d.groups[b].minimized) b++;
  return a >= 0 && b < d.groups.length ? [a, b] : null;
}

/**
 * Drags divider `i` by `dy` from group heights `heights` (as drawn when the
 * drag began): the groups on either side trade height, neither going below
 * the minimum. Every group's size becomes its drawn height, so the others
 * stay as they are.
 */
export function dragDivider(d: DockLayout, heights: readonly number[], i: number, dy: number): DockLayout {
  const pair = dividerPanels(d, i);
  if (!pair) return d;
  const [a, b] = pair;
  const total = heights[a] + heights[b];
  const above = clamp(heights[a] + dy, PANEL_MIN_HEIGHT, Math.max(PANEL_MIN_HEIGHT, total - PANEL_MIN_HEIGHT));
  return {
    ...d,
    groups: d.groups.map((g, k) => (k === a ? { ...g, size: above } : k === b ? { ...g, size: total - above } : g.minimized ? g : { ...g, size: heights[k] })),
  };
}

const PANELS = new Set(Object.keys(PANEL_TITLES));

/**
 * A stored layout made valid: every panel at most once, groups in their
 * stored order, with sane sizes. A layout from before groups (one panel
 * each) keeps its panels and gains any default one it lacks.
 */
export function normalizeDock(raw: unknown): DockLayout {
  const o = (raw && typeof raw === "object" ? raw : {}) as { width?: unknown; panels?: unknown; groups?: unknown };
  const legacy = !Array.isArray(o.groups);
  const stored = (Array.isArray(o.groups) ? o.groups : Array.isArray(o.panels) ? o.panels.map((p) => ({ ...p, tabs: [p?.id] })) : []) as Partial<DockGroup>[];
  const seen = new Set<PanelId>();
  const groups: DockGroup[] = [];
  for (const g of stored) {
    const tabs = (Array.isArray(g?.tabs) ? g.tabs : []).filter((t): t is PanelId => PANELS.has(t) && !seen.has(t) && !!seen.add(t));
    if (!tabs.length) continue;
    const size = typeof g.size === "number" && Number.isFinite(g.size) && g.size > 0 ? g.size : (DEFAULT_DOCK.groups.find((d) => tabs.includes(d.id))?.size ?? OPENED_SIZE);
    groups.push({ id: tabs[0], tabs, active: tabs.includes(g.active!) ? g.active! : tabs[0], size, minimized: g.minimized === true });
  }
  if (legacy || !groups.length) for (const def of DEFAULT_DOCK.groups) if (!seen.has(def.id)) groups.push(def);
  const width = typeof o.width === "number" && Number.isFinite(o.width) ? o.width : DEFAULT_DOCK.width;
  return withWidth({ width, groups }, width);
}

const KEY = "picturestore.dock";

export function loadDock(): DockLayout {
  try {
    return normalizeDock(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return DEFAULT_DOCK;
  }
}

export function saveDock(d: DockLayout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    // Storage full or disabled: the layout still applies for this session.
  }
}
