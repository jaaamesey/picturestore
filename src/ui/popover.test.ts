import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

/**
 * Guard rail: floating panels must be Popovers, which own dismissal (outside
 * press, Escape, nesting). A panel anchored to its control with
 * `top-full` / `left-full` / … anywhere else is a hand-rolled dropdown that
 * would forget to close — use `<Popover>` from ui/Popover.tsx instead.
 */
it("anchors floating panels only through Popover", () => {
  const dir = import.meta.dirname;
  const files = (function walk(d: string): string[] {
    return readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".tsx") ? [join(d, e.name)] : [],
    );
  })(dir);
  const offenders: string[] = [];
  for (const file of files) {
    if (file.endsWith("Popover.tsx")) continue;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (/\b(top|left|right|bottom)-full\b/.test(line) && !line.includes("<Popover")) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
  }
  expect(offenders).toEqual([]);
});
