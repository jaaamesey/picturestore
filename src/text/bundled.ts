/**
 * Fonts that ship with the app: Adobe's open Source families (Source Sans
 * is by Myriad's designer, Photoshop's default). Variable, so every weight
 * is there; their PostScript names follow the static families, so PSDs
 * naming those find them. Noto Sans Arabic covers Arabic script (its
 * characters fall back to it from fonts that lack them).
 */
export interface BundledFont {
  readonly id: string;
  readonly family: string;
  /** PostScript names for a variable font's instances (static fonts keep their own). */
  readonly psPrefix?: string;
  /** Path within node_modules. */
  readonly path: string;
}

export const BUNDLED_FONTS: readonly BundledFont[] = [
  { id: "bundled:source-sans-3", family: "Source Sans 3", psPrefix: "SourceSans3", path: "source-sans/VF/SourceSans3VF-Upright.ttf" },
  { id: "bundled:source-sans-3-italic", family: "Source Sans 3", psPrefix: "SourceSans3", path: "source-sans/VF/SourceSans3VF-Italic.ttf" },
  { id: "bundled:source-serif-4", family: "Source Serif 4", psPrefix: "SourceSerif4", path: "source-serif/VAR/SourceSerif4Variable-Roman.ttf" },
  { id: "bundled:source-serif-4-italic", family: "Source Serif 4", psPrefix: "SourceSerif4", path: "source-serif/VAR/SourceSerif4Variable-Italic.ttf" },
  { id: "bundled:source-code-pro", family: "Source Code Pro", psPrefix: "SourceCodePro", path: "source-code-pro/VF/SourceCodeVF-Upright.ttf" },
  { id: "bundled:source-code-pro-italic", family: "Source Code Pro", psPrefix: "SourceCodePro", path: "source-code-pro/VF/SourceCodeVF-Italic.ttf" },
  { id: "bundled:noto-sans-arabic", family: "Noto Sans Arabic", path: "@expo-google-fonts/noto-sans-arabic/400Regular/NotoSansArabic_400Regular.ttf" },
  { id: "bundled:noto-sans-arabic-bold", family: "Noto Sans Arabic", path: "@expo-google-fonts/noto-sans-arabic/700Bold/NotoSansArabic_700Bold.ttf" },
];
