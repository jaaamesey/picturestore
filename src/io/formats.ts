/** File formats, kept free of codec imports so the main bundle doesn't pull in the PSD library. */
export type ExportFormat = "png" | "jpeg" | "webp";
export type SaveFormat = "psd" | ExportFormat;

export const EXTENSIONS: Record<SaveFormat, string> = { psd: "psd", png: "png", jpeg: "jpg", webp: "webp" };
