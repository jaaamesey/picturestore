import { resolutionOf, type Doc, type Guide } from "../core/document";
import { rulerStep } from "./view";
import { vec, type Rect, type Vec2 } from "../core/geometry";
import { NO_SNAP, SNAP_PX, snapPoint, snapRect, snapTargets, type SmartGuide, type Snapped, type SnapTargets } from "../core/snap";
import { gridSpacing, type Preferences } from "./preferences";
import type { SnapToOptions } from "./viewOptions";

export interface SnapOptions {
  /** Layers being moved (they don't snap to themselves). */
  readonly exclude?: readonly string[];
  /** Leave guides out (a guide being dragged snaps to everything else). */
  readonly noGuides?: boolean;
  /** Snapping is suspended (Ctrl while moving): nothing snaps, and smart guides clear. */
  readonly off?: boolean;
}

/**
 * Snapping as tools see it: a dragged point or a moving box comes back
 * pulled onto whatever's within reach. Smart guides for the alignment are
 * shown as a side effect, and cleared when the gesture ends.
 */
export interface Snapper {
  /** Where a dragged point lands. */
  point(p: Vec2, o?: SnapOptions): Vec2;
  /** How far to shift a moving box (by its edges or centre). */
  rect(r: Rect, o?: SnapOptions): Vec2;
}

/** For contexts where nothing snaps. */
export const NO_SNAPPING: Snapper = { point: (p) => p, rect: () => vec(0, 0) };

/** Targets per document and options: layer bounds are computed once per gesture, not per pointer move. */
const cache = new WeakMap<Doc, Map<string, SnapTargets>>();

function targetsFor(doc: Doc, to: SnapToOptions, prefs: Preferences, o: SnapOptions | undefined): SnapTargets {
  const key = JSON.stringify([to, prefs.gridEvery, prefs.gridUnit, prefs.gridSubdivisions, o?.exclude ?? [], !!o?.noGuides]);
  let byKey = cache.get(doc);
  if (!byKey) cache.set(doc, (byKey = new Map()));
  let t = byKey.get(key);
  if (!t) {
    const grid = to.grid ? gridSpacing(prefs, doc.width, doc.height, resolutionOf(doc)).minor : null;
    t = snapTargets(doc, { guides: to.guides && !o?.noGuides, grid, layers: to.layers, bounds: to.bounds }, o?.exclude);
    byKey.set(key, t);
  }
  return t;
}

/**
 * A snapper for `doc` seen at `zoom` (the reach is {@link SNAP_PX} screen
 * pixels). `to` is null when snapping is off. `show` receives the smart
 * guides of each snap (empty when nothing aligned).
 */
export function createSnapper(doc: Doc, zoom: number, to: SnapToOptions | null, prefs: Preferences, show: (g: readonly SmartGuide[]) => void): Snapper {
  if (!to) return NO_SNAPPING;
  const tolerance = SNAP_PX / zoom;
  const run = (f: (t: SnapTargets) => Snapped, o?: SnapOptions) => {
    const s = o?.off ? NO_SNAP : f(targetsFor(doc, to, prefs, o));
    show(s.guides);
    return s;
  };
  return {
    point(p, o) {
      const s = run((t) => snapPoint(p, t, tolerance), o);
      return vec(p.x + s.dx, p.y + s.dy);
    },
    rect(r, o) {
      const s = run((t) => snapRect(r, t, tolerance), o);
      return vec(s.dx, s.dy);
    },
  };
}

/**
 * Where a guide dragged to `p` lands: snapped like anything else (but not
 * to other guides) on whole pixels, or with Shift to the ruler's ticks.
 */
export function guidePosition(snap: Snapper, zoom: number, orientation: Guide["orientation"], p: Vec2, shift: boolean): number {
  const v = orientation === "vertical" ? p.x : p.y;
  if (shift) {
    const { minor } = rulerStep(zoom);
    return Math.round(v / minor) * minor;
  }
  const q = snap.point(p, { noGuides: true });
  return Math.round(orientation === "vertical" ? q.x : q.y);
}
