/**
 * The panel dock's layout, as in Photoshop: a column of panels beside the
 * canvas. Its width is set by dragging its edge; panels share its height,
 * resized by dragging the divider between two, and a panel minimized
 * (double-click its tab) shows only its tab. Panels are listed in order, so
 * moving one is a reorder of the list.
 */

export type PanelId = "history" | "properties" | "layers";

export interface DockPanel {
  readonly id: PanelId;
  /** Its share of the dock's height, in pixels at the size last set (heights scale with the dock). */
  readonly size: number;
  readonly minimized: boolean;
}

export interface DockLayout {
  readonly width: number;
  readonly panels: readonly DockPanel[];
}

export const PANEL_TITLES: Record<PanelId, string> = { history: "History", properties: "Properties", layers: "Layers" };

export const DEFAULT_DOCK: DockLayout = {
  width: 256,
  panels: [
    { id: "history", size: 192, minimized: false },
    { id: "properties", size: 240, minimized: false },
    { id: "layers", size: 420, minimized: false },
  ],
};

export const DOCK_MIN_WIDTH = 200;
export const DOCK_MAX_WIDTH = 640;
/** A panel's smallest height, tab included. */
export const PANEL_MIN_HEIGHT = 72;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export const withWidth = (d: DockLayout, width: number): DockLayout => ({ ...d, width: Math.round(clamp(width, DOCK_MIN_WIDTH, DOCK_MAX_WIDTH)) });

export const toggleMinimized = (d: DockLayout, id: PanelId): DockLayout => ({
  ...d,
  panels: d.panels.map((p) => (p.id === id ? { ...p, minimized: !p.minimized } : p)),
});

/**
 * The panels a divider (between panel `i` and the next) resizes: the
 * nearest unminimized panel at or above it and at or below it, if both exist.
 */
export function dividerPanels(d: DockLayout, i: number): [number, number] | null {
  let a = i, b = i + 1;
  while (a >= 0 && d.panels[a].minimized) a--;
  while (b < d.panels.length && d.panels[b].minimized) b++;
  return a >= 0 && b < d.panels.length ? [a, b] : null;
}

/**
 * Drags divider `i` by `dy` from panel heights `heights` (as drawn when the
 * drag began): the panels on either side trade height, neither going below
 * the minimum. Every panel's size becomes its drawn height, so the others
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
    panels: d.panels.map((p, k) => (k === a ? { ...p, size: above } : k === b ? { ...p, size: total - above } : p.minimized ? p : { ...p, size: heights[k] })),
  };
}

/** A stored layout made valid: every panel once, in its stored order, with sane sizes. */
export function normalizeDock(raw: unknown): DockLayout {
  const o = (raw && typeof raw === "object" ? raw : {}) as { width?: unknown; panels?: unknown };
  const stored = Array.isArray(o.panels) ? (o.panels as Partial<DockPanel>[]) : [];
  const panels: DockPanel[] = [];
  for (const p of stored) {
    const def = DEFAULT_DOCK.panels.find((q) => q.id === p?.id);
    if (!def || panels.some((q) => q.id === def.id)) continue;
    const size = typeof p.size === "number" && Number.isFinite(p.size) && p.size > 0 ? p.size : def.size;
    panels.push({ id: def.id, size, minimized: p.minimized === true });
  }
  for (const def of DEFAULT_DOCK.panels) if (!panels.some((q) => q.id === def.id)) panels.push(def);
  const width = typeof o.width === "number" && Number.isFinite(o.width) ? o.width : DEFAULT_DOCK.width;
  return withWidth({ width, panels }, width);
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
