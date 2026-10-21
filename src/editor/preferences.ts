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
}

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
  return {
    historyStates: clampInt(p.historyStates, HISTORY_STATES_RANGE.min, HISTORY_STATES_RANGE.max, defaults.historyStates),
    memoryUsageMB: clampInt(p.memoryUsageMB, mem.min, mem.max, defaults.memoryUsageMB),
    recoveryMinutes: recovery,
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
  { id: "units", label: "Units & Rulers", available: false },
  { id: "guides", label: "Guides, Grid & Slices", available: false },
  { id: "plugins", label: "Plugins", available: false },
  { id: "type", label: "Type", available: false },
  { id: "technologyPreviews", label: "Technology Previews", available: false },
  { id: "productImprovement", label: "Product Improvement", available: false },
] as const;

export type PreferencesPane = (typeof PREFERENCES_PANES)[number]["id"];
