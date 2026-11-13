// Which screens a landing's changed files touch: each screen lists the source
// globs it depends on (screens.ts). App code no screen names (web, server or a
// package) walks the whole app: when unsure, everything, so a new component is
// never walked by nothing. Docs, scripts and tests walk nothing.

/** `**` crosses folders, `*` stays inside one, anything else is literal. */
export function globRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*" && glob[i + 1] === "*") {
      // "**/" matches no folder or any number of them
      if (glob[i + 2] === "/") { out += "(?:.*/)?"; i += 2; } else { out += ".*"; i += 1; }
    } else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

export interface Pick {
  /** Screen ids, in the table's order. */
  readonly screens: readonly string[];
  /** Changed files no screen names. */
  readonly unmatched: readonly string[];
  /** App code among them: every screen is walked. */
  readonly whole: boolean;
}

const APP = /^(apps\/(web|server)\/src|packages\/[^/]+\/src)\/.+\.(tsx?|css)$/;
const TEST = /\.test\.tsx?$/;

export function screensFor(changed: readonly string[], table: readonly { readonly id: string; readonly paths: readonly string[] }[]): Pick {
  const hit = new Set<string>();
  const unmatched: string[] = [];
  let whole = false;
  const res = table.map((s) => ({ id: s.id, res: s.paths.map(globRegex) }));
  for (const raw of changed) {
    const file = raw.replace(/^\.\//, "");
    if (TEST.test(file)) continue;
    const mine = res.filter((s) => s.res.some((re) => re.test(file))).map((s) => s.id);
    if (mine.length === 0) {
      unmatched.push(file);
      if (APP.test(file)) whole = true;
    }
    for (const id of mine) hit.add(id);
  }
  return { screens: table.map((s) => s.id).filter((id) => whole || hit.has(id)), unmatched, whole };
}
