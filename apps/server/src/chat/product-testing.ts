import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Source {
  readonly file: string;
  readonly text: string;
}

export function productSource(): readonly Source[] {
  const repo = fileURLToPath(new URL("../../../../", import.meta.url));
  return ["apps", "packages"].flatMap((top) => readdirSync(path.join(repo, top)).map((name) => path.join(top, name, "src")))
    .flatMap((dir) => { try { return readdirSync(path.join(repo, dir), { recursive: true, encoding: "utf8" }).map((f) => path.join(dir, f)); } catch { return []; } })
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => ({ file: f.split(path.sep).join("/"), text: readFileSync(path.join(repo, f), "utf8") }));
}

export const mentions = (product: readonly Source[], re: RegExp): readonly string[] => product.filter((p) => re.test(p.text)).map((p) => p.file).toSorted();

// why: comments and quoted text are blanked, so a bracket or comma in them is not counted
export function argumentsOf(source: string, from: number): string {
  let out = "";
  let depth = 1;
  for (let i = from; i < source.length && depth > 0; i++) {
    const ch = source[i] ?? "";
    const two = source.slice(i, i + 2);
    if (two === "//") { i = source.indexOf("\n", i); if (i < 0) break; continue; }
    if (two === "/*") { i = source.indexOf("*/", i) + 1; if (i < 1) break; continue; }
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === "\\") i++;
      out += '""';
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (depth > 0) out += depth === 1 ? ch : " ";
  }
  return out;
}

export interface Call {
  readonly file: string;
  readonly name: string;
  readonly args: string;
}

// why: a function's own declaration is not a call
export function callsOf(product: readonly Source[], names: readonly string[]): readonly Call[] {
  const call = new RegExp(`(?<!function )\\b(${names.join("|")})\\(`, "g");
  return product.flatMap((p) => [...p.text.matchAll(call)].map((m) => ({ file: p.file, name: m[1] ?? "", args: argumentsOf(p.text, m.index + m[0].length) })));
}

// why: a trailing comma after the last argument is allowed
export const oneArgument = (c: Call): boolean => !c.args.replace(/,\s*$/, "").includes(",");
