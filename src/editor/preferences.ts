import { LENGTH_UNITS, toPixels, type LengthUnit } from "./imageSize";

/**
 * User preferences (Edit ▸ Preferences), persisted per browser. Organised as
 * in Photoshop: History States and Memory Usage live under Performance,
 * recovery saving under File Handling.
 */
export interface Preferences {
  /** Performance ▸ History & Cache ▸ History States (Photoshop: 1–1000, default 50). */
  readonly historyStates: number;
  /**
   * Performance ▸ Memory Usage, in MB: what open documents and their history
   * may retain. Past it, the oldest history states are freed.
   */
  readonly memoryUsageMB: number;
  /** File Handling ▸ Automatically Save Recovery Information Every N minutes; 0 = off. */
  readonly recoveryMinutes: number;
  /** Guides, Grid & Slices ▸ Guides: colour ("#rrggbb") and style. */
  readonly guideColor: string;
  readonly guideStyle: LineStyle;
  /** Guides, Grid & Slices ▸ Smart Guides: colour. */
  readonly smartGuideColor: string;
  /** Guides, Grid & Slices ▸ Grid: colour, style, Gridline Every (a length in a unit) and Subdivisions. */
  readonly gridColor: string;
  readonly gridStyle: LineStyle;
  readonly gridEvery: number;
  readonly gridUnit: LengthUnit;
  readonly gridSubdivisions: number;
  /** Units & Rulers ▸ Type: the unit type sizes are shown in. */
  readonly typeUnits: TypeUnit;
  /** Type ▸ Use Smart Quotes: typed straight quotes become curly. */
  readonly smartQuotes: boolean;
  /** Type ▸ Enable Missing Glyph Protection: characters a font lacks come from another font. */
  readonly missingGlyphProtection: boolean;
  /** Type ▸ Fill new type layers with placeholder text (Lorem Ipsum, selected). */
  readonly placeholderText: boolean;
  /** Type ▸ Use Esc key to commit text (else Esc cancels). */
  readonly escCommits: boolean;
  /** Type ▸ Show Font Names in English. */
  readonly fontNamesInEnglish: boolean;
  /** Type ▸ Font Preview Size: names in font menus drawn in their font, at this size (none: plain). */
  readonly fontPreviewSize: FontPreviewSize;
}

export type TypeUnit = "points" | "pixels" | "millimeters";
export type FontPreviewSize = "none" | "small" | "medium" | "large" | "extra-large" | "huge";
export const FONT_PREVIEW_PX: Record<FontPreviewSize, number> = { none: 0, small: 11, medium: 13, large: 16, "extra-large": 20, huge: 26 };

export type LineStyle = "lines" | "dashed" | "dots";

/** Photoshop's named guide and grid colours. */
export const GUIDE_COLORS: readonly { readonly label: string; readonly hex: string }[] = [
  { label: "Light Blue", hex: "#4a8cff" },
  { label: "Light Red", hex: "#ff4a4a" },
  { label: "Green", hex: "#4aff4a" },
  { label: "Medium Blue", hex: "#4a4aff" },
  { label: "Yellow", hex: "#ffff4a" },
  { label: "Magenta", hex: "#ff4aff" },
  { label: "Cyan", hex: "#4affff" },
  { label: "Light Gray", hex: "#c0c0c0" },
  { label: "Black", hex: "#000000" },
];

export const HISTORY_STATES_RANGE = { min: 1, max: 1000 } as const;
export const RECOVERY_INTERVALS = [0, 1, 5, 10, 15, 30, 60] as const;

/** What the browser is likely to let us use, in MB (Photoshop's "Available RAM"). */
export function availableMemoryMB(): number {
  const heap = (globalThis.performance as { memory?: { jsHeapSizeLimit: number } } | undefined)?.memory?.jsHeapSizeLimit;
  if (heap) return Math.round(heap / 2 ** 20);
  const device = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory;
  // Browsers cap a tab's heap well below device memory; assume half, at most 4 GB.
  return device ? Math.min(4096, device * 512) : 4096;
}

/** Photoshop's ideal range is 55–85% of available RAM; it defaults to 70%. */
export const memoryUsageRange = (available = availableMemoryMB()) => ({
  min: 128,
  max: Math.max(128, Math.round(available * 0.9)),
  ideal: [Math.round(available * 0.55), Math.round(available * 0.85)] as const,
  default: Math.round(available * 0.7),
});

export const defaultPreferences = (): Preferences => ({
  historyStates: 50,
  memoryUsageMB: memoryUsageRange().default,
  recoveryMinutes: 10,
  // Photoshop's defaults: cyan guides, magenta smart guides, a grey grid every 25 mm in 4 subdivisions.
  guideColor: "#4affff",
  guideStyle: "lines",
  smartGuideColor: "#ff4aff",
  gridColor: "#9c9c9c",
  gridStyle: "lines",
  gridEvery: 25,
  gridUnit: "millimeters",
  gridSubdivisions: 4,
  typeUnits: "points",
  smartQuotes: true,
  missingGlyphProtection: true,
  placeholderText: true,
  escCommits: true,
  fontNamesInEnglish: true,
  fontPreviewSize: "medium",
});

const clampInt = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;

/** Validates stored or entered values, falling back to defaults for anything missing or malformed. */
export function normalizePreferences(raw: unknown, defaults = defaultPreferences()): Preferences {
  const p = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Preferences, unknown>>;
  const mem = memoryUsageRange();
  const recovery = RECOVERY_INTERVALS.includes(p.recoveryMinutes as (typeof RECOVERY_INTERVALS)[number])
    ? (p.recoveryMinutes as number)
    : defaults.recoveryMinutes;
  const color = (v: unknown, fallback: string) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : fallback);
  const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T) => (options.includes(v as T) ? (v as T) : fallback);
  const styles: readonly LineStyle[] = ["lines", "dashed", "dots"];
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  return {
    historyStates: clampInt(p.historyStates, HISTORY_STATES_RANGE.min, HISTORY_STATES_RANGE.max, defaults.historyStates),
    memoryUsageMB: clampInt(p.memoryUsageMB, mem.min, mem.max, defaults.memoryUsageMB),
    recoveryMinutes: recovery,
    guideColor: color(p.guideColor, defaults.guideColor),
    guideStyle: oneOf(p.guideStyle, ["lines", "dashed"], defaults.guideStyle),
    smartGuideColor: color(p.smartGuideColor, defaults.smartGuideColor),
    gridColor: color(p.gridColor, defaults.gridColor),
    gridStyle: oneOf(p.gridStyle, styles, defaults.gridStyle),
    gridEvery: typeof p.gridEvery === "number" && p.gridEvery > 0 && Number.isFinite(p.gridEvery) ? p.gridEvery : defaults.gridEvery,
    gridUnit: oneOf(p.gridUnit, LENGTH_UNITS.map((u) => u.id), defaults.gridUnit),
    gridSubdivisions: clampInt(p.gridSubdivisions, 1, 100, defaults.gridSubdivisions),
    typeUnits: oneOf(p.typeUnits, ["points", "pixels", "millimeters"], defaults.typeUnits),
    smartQuotes: bool(p.smartQuotes, defaults.smartQuotes),
    missingGlyphProtection: bool(p.missingGlyphProtection, defaults.missingGlyphProtection),
    placeholderText: bool(p.placeholderText, defaults.placeholderText),
    escCommits: bool(p.escCommits, defaults.escCommits),
    fontNamesInEnglish: bool(p.fontNamesInEnglish, defaults.fontNamesInEnglish),
    fontPreviewSize: oneOf(p.fontPreviewSize, Object.keys(FONT_PREVIEW_PX) as FontPreviewSize[], defaults.fontPreviewSize),
  };
}

const KEY = "picturestore.preferences";

export function loadPreferences(): Preferences {
  try {
    return normalizePreferences(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return defaultPreferences();
  }
}

export function savePreferences(p: Preferences): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // Storage full or disabled: the preferences still apply for this session.
  }
}

/** Photoshop's Preferences panes, in its order. Only some have settings so far. */
export const PREFERENCES_PANES = [
  { id: "general", label: "General", available: true },
  { id: "interface", label: "Interface", available: false },
  { id: "workspace", label: "Workspace", available: false },
  { id: "tools", label: "Tools", available: false },
  { id: "history", label: "History & Content Credentials", available: false },
  { id: "fileHandling", label: "File Handling", available: true },
  { id: "export", label: "Export", available: false },
  { id: "performance", label: "Performance", available: true },
  { id: "scratchDisks", label: "Scratch Disks", available: false },
  { id: "cursors", label: "Cursors", available: false },
  { id: "transparency", label: "Transparency & Gamut", available: false },
  { id: "units", label: "Units & Rulers", available: true },
  { id: "guides", label: "Guides, Grid & Slices", available: true },
  { id: "plugins", label: "Plugins", available: false },
  { id: "type", label: "Type", available: true },
  { id: "technologyPreviews", label: "Technology Previews", available: false },
  { id: "productImprovement", label: "Product Improvement", available: false },
] as const;

export type PreferencesPane = (typeof PREFERENCES_PANES)[number]["id"];

/**
 * The grid's spacing in a `width × height` document at `ppi`: between
 * gridlines, and between subdivisions (what snapping uses). Percent is of
 * the document's size on each axis.
 */
export function gridSpacing(p: Pick<Preferences, "gridEvery" | "gridUnit" | "gridSubdivisions">, width: number, height: number, ppi: number) {
  const x = toPixels(p.gridEvery, p.gridUnit, ppi, width), y = toPixels(p.gridEvery, p.gridUnit, ppi, height);
  return { major: { x, y }, minor: { x: x / p.gridSubdivisions, y: y / p.gridSubdivisions } };
}
