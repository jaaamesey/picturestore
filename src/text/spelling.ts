import type nspell from "nspell";
// The dictionary package exports only a Node loader; its Hunspell files are fetched as they are.
import affUrl from "../../node_modules/dictionary-en/index.aff?url";
import dicUrl from "../../node_modules/dictionary-en/index.dic?url";

/**
 * Edit ▸ Check Spelling's dictionary: Hunspell's English (US), loaded the
 * first time it's needed, plus the words the user has added (kept in this
 * browser).
 */

type NSpell = ReturnType<typeof nspell>;

const PERSONAL = "picturestore.dictionary";

const personal = (): string[] => {
  try {
    const w = JSON.parse(localStorage.getItem(PERSONAL) ?? "[]");
    return Array.isArray(w) ? w.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

let checker: Promise<NSpell> | null = null;

export type { NSpell };

export function spellChecker(): Promise<NSpell> {
  return (checker ??= (async () => {
    const [{ default: nspell }, aff, dic] = await Promise.all([import("nspell"), fetch(affUrl).then((r) => r.text()), fetch(dicUrl).then((r) => r.text())]);
    const sp = nspell(aff, dic);
    for (const w of personal()) sp.add(w);
    return sp;
  })());
}

/** The dictionary's languages: English. */
export const spellingCovers = (language: string) => language.toLowerCase().startsWith("en");

/** Add: the word is kept as spelled correctly from now on. */
export async function addToDictionary(word: string): Promise<void> {
  (await spellChecker()).add(word);
  try {
    localStorage.setItem(PERSONAL, JSON.stringify([...new Set([...personal(), word])]));
  } catch {
    // Storage full or disabled: added for this session.
  }
}
