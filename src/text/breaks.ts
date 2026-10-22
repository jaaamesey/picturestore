import LineBreaker from "linebreak";

/**
 * Where lines may break: Unicode's line breaking algorithm (UAX #14), and
 * within words, hyphenation by Liang's patterns (TeX's), per language.
 */

/** Positions a line may break before, with whether the break is required. */
export function breakOpportunities(text: string): { position: number; required: boolean }[] {
  const out: { position: number; required: boolean }[] = [];
  const b = new LineBreaker(text);
  for (let bk = b.nextBreak(); bk; bk = b.nextBreak()) out.push({ position: bk.position, required: bk.required });
  return out;
}

interface Hyphenator {
  hyphenateSync(text: string, options?: { hyphenChar?: string; minWordLength?: number }): string;
}

type Loader = () => Promise<Hyphenator | { default: Hyphenator }>;

/** Photoshop's languages (Character panel), by BCP 47 tag, and their patterns. */
export const LANGUAGES: readonly { readonly tag: string; readonly name: string; readonly load: Loader | null }[] = [
  { tag: "en-US", name: "English: USA", load: () => import("hyphen/en-us") },
  { tag: "en-GB", name: "English: UK", load: () => import("hyphen/en-gb") },
  { tag: "en-CA", name: "English: Canadian", load: () => import("hyphen/en-us") },
  { tag: "de-DE", name: "German: 2006 Reform", load: () => import("hyphen/de-1996") },
  { tag: "de-DE-1901", name: "German: Traditional", load: () => import("hyphen/de-1901") },
  { tag: "de-CH", name: "German: Swiss", load: () => import("hyphen/de-ch-1901") },
  { tag: "fr-FR", name: "French", load: () => import("hyphen/fr") },
  { tag: "fr-CA", name: "French: Canadian", load: () => import("hyphen/fr") },
  { tag: "it-IT", name: "Italian", load: () => import("hyphen/it") },
  { tag: "es-ES", name: "Spanish", load: () => import("hyphen/es") },
  { tag: "pt-PT", name: "Portuguese", load: () => import("hyphen/pt") },
  { tag: "pt-BR", name: "Portuguese: Brazilian", load: () => import("hyphen/pt") },
  { tag: "nl-NL", name: "Dutch", load: () => import("hyphen/nl") },
  { tag: "sv-SE", name: "Swedish", load: () => import("hyphen/sv") },
  { tag: "da-DK", name: "Danish", load: () => import("hyphen/da") },
  { tag: "nb-NO", name: "Norwegian: Bokmål", load: () => import("hyphen/nb") },
  { tag: "nn-NO", name: "Norwegian: Nynorsk", load: () => import("hyphen/nn") },
  { tag: "fi-FI", name: "Finnish", load: () => import("hyphen/fi") },
  { tag: "is-IS", name: "Icelandic", load: () => import("hyphen/is") },
  { tag: "pl-PL", name: "Polish", load: () => import("hyphen/pl") },
  { tag: "cs-CZ", name: "Czech", load: () => import("hyphen/cs") },
  { tag: "sk-SK", name: "Slovak", load: () => import("hyphen/sk") },
  { tag: "hu-HU", name: "Hungarian", load: () => import("hyphen/hu") },
  { tag: "ro-RO", name: "Romanian", load: () => import("hyphen/ro") },
  { tag: "hr-HR", name: "Croatian", load: () => import("hyphen/hr") },
  { tag: "sl-SI", name: "Slovenian", load: () => import("hyphen/sl") },
  { tag: "sr-Latn", name: "Serbian (Latin)", load: () => import("hyphen/sh-latn") },
  { tag: "sr-Cyrl", name: "Serbian (Cyrillic)", load: () => import("hyphen/sr-cyrl") },
  { tag: "bg-BG", name: "Bulgarian", load: () => import("hyphen/bg") },
  { tag: "ru-RU", name: "Russian", load: () => import("hyphen/ru") },
  { tag: "uk-UA", name: "Ukrainian", load: () => import("hyphen/uk") },
  { tag: "el-GR", name: "Greek", load: () => import("hyphen/el-monoton") },
  { tag: "tr-TR", name: "Turkish", load: () => import("hyphen/tr") },
  { tag: "ca-ES", name: "Catalan", load: () => import("hyphen/ca") },
  { tag: "et-EE", name: "Estonian", load: () => import("hyphen/et") },
  { tag: "lv-LV", name: "Latvian", load: () => import("hyphen/lv") },
  { tag: "lt-LT", name: "Lithuanian", load: () => import("hyphen/lt") },
  { tag: "ar", name: "Arabic", load: null },
  { tag: "he", name: "Hebrew", load: null },
  { tag: "ja-JP", name: "Japanese", load: null },
  { tag: "zh-CN", name: "Chinese", load: null },
  { tag: "ko-KR", name: "Korean", load: null },
  { tag: "hi-IN", name: "Hindi", load: () => import("hyphen/hi") },
];

const loaded = new Map<string, Hyphenator | null>();
const pending = new Map<string, Promise<void>>();

const languageOf = (tag: string) => LANGUAGES.find((l) => l.tag === tag) ?? LANGUAGES.find((l) => l.tag.split("-")[0] === tag.split("-")[0]);

/** Loads a language's patterns (once); layout uses whatever has loaded. */
export function loadHyphenation(tag: string): Promise<void> {
  const lang = languageOf(tag);
  if (!lang || loaded.has(lang.tag)) return Promise.resolve();
  let p = pending.get(lang.tag);
  if (!p) {
    p = (lang.load ? lang.load() : Promise.resolve(null))
      .then((m) => void loaded.set(lang.tag, m ? ("default" in m ? m.default : m) : null))
      .catch(() => void loaded.set(lang.tag, null));
    pending.set(lang.tag, p);
  }
  return p;
}

export const hyphenationLoaded = (tag: string) => {
  const lang = languageOf(tag);
  return !lang || loaded.has(lang.tag);
};

/** Positions inside `word` where it may be hyphenated (break before the position), per the language's patterns. */
export function hyphenationPoints(word: string, language: string): number[] {
  const lang = languageOf(language);
  const h = lang && loaded.get(lang.tag);
  if (!h) return [];
  const marked = h.hyphenateSync(word, { hyphenChar: "­", minWordLength: 1 });
  const out: number[] = [];
  for (let i = 0, at = 0; i < marked.length; i++) {
    if (marked[i] === "­") out.push(at);
    else at++;
  }
  return out;
}
