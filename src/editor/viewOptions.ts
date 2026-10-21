/**
 * The View menu's toggles: what's shown over the canvas and what snaps.
 * Application-wide (the same for every document) and remembered, as in
 * Photoshop.
 */
export interface ViewOptions {
  /** View ▸ Extras (Ctrl+H): shows guides, the grid, smart guides and selection edges at all. */
  readonly extras: boolean;
  /** View ▸ Show ▸ … */
  readonly showGuides: boolean;
  readonly showGrid: boolean;
  readonly showSmartGuides: boolean;
  /** View ▸ Rulers (Ctrl+R). */
  readonly rulers: boolean;
  /** View ▸ Snap (Shift+Ctrl+;). */
  readonly snap: boolean;
  /** View ▸ Snap To ▸ … */
  readonly snapTo: SnapToOptions;
  /** View ▸ Lock Guides (Alt+Ctrl+;). */
  readonly lockGuides: boolean;
}

export interface SnapToOptions {
  readonly guides: boolean;
  readonly grid: boolean;
  readonly layers: boolean;
  readonly bounds: boolean;
}

/** Photoshop's defaults: guides and smart guides shown, the grid and rulers hidden, snapping to everything. */
export const DEFAULT_VIEW_OPTIONS: ViewOptions = {
  extras: true,
  showGuides: true,
  showGrid: false,
  showSmartGuides: true,
  rulers: false,
  snap: true,
  snapTo: { guides: true, grid: true, layers: true, bounds: true },
  lockGuides: false,
};

/** Whether guides, the grid and smart guides are actually shown (Extras gates them all). */
export const shown = (v: ViewOptions) => ({
  guides: v.extras && v.showGuides,
  grid: v.extras && v.showGrid,
  smartGuides: v.extras && v.showSmartGuides,
});

/**
 * What snapping pulls things to. Guides and the grid are targets only while
 * shown (Photoshop disables Snap To ▸ Grid while the grid is hidden).
 */
export function activeSnapTo(v: ViewOptions): SnapToOptions | null {
  if (!v.snap) return null;
  const s = shown(v);
  return { guides: v.snapTo.guides && s.guides, grid: v.snapTo.grid && s.grid, layers: v.snapTo.layers, bounds: v.snapTo.bounds };
}

const KEY = "picturestore.view";

export function normalizeViewOptions(raw: unknown): ViewOptions {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const d = DEFAULT_VIEW_OPTIONS;
  const to = (o.snapTo && typeof o.snapTo === "object" ? o.snapTo : {}) as Record<string, unknown>;
  return {
    extras: bool(o.extras, d.extras),
    showGuides: bool(o.showGuides, d.showGuides),
    showGrid: bool(o.showGrid, d.showGrid),
    showSmartGuides: bool(o.showSmartGuides, d.showSmartGuides),
    rulers: bool(o.rulers, d.rulers),
    snap: bool(o.snap, d.snap),
    snapTo: {
      guides: bool(to.guides, d.snapTo.guides),
      grid: bool(to.grid, d.snapTo.grid),
      layers: bool(to.layers, d.snapTo.layers),
      bounds: bool(to.bounds, d.snapTo.bounds),
    },
    lockGuides: bool(o.lockGuides, d.lockGuides),
  };
}

export function loadViewOptions(): ViewOptions {
  try {
    return normalizeViewOptions(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return DEFAULT_VIEW_OPTIONS;
  }
}

export function saveViewOptions(v: ViewOptions): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // Storage full or disabled: the options still apply for this session.
  }
}
