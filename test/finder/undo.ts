// How a board case puts its bug back. undo.json is a list of edits, each one exact text that is
// in the file once and what to put there. An edit breaks only when the line it names changes,
// where a patch broke whenever anything near it did (five of twelve in one evening of landings).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Edit {
  readonly file: string;
  readonly find: string;
  readonly replace: string;
}

/** The text with the edit made. `find` must be there exactly once: an edit that no longer names
 *  one place is refused, never made somewhere else. */
export function swap(text: string, e: Edit): string {
  const n = e.find === "" ? 0 : text.split(e.find).length - 1;
  if (n !== 1) throw new Error(`${e.file}: the text to undo is there ${n} times, not once: ${JSON.stringify(e.find.slice(0, 80))}`);
  return text.replace(e.find, () => e.replace);
}

function parseEdits(file: string): Edit[] {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("undo.json is not a list of edits");
  return raw.map((e: Partial<Edit>, i) => {
    if (typeof e.file !== "string" || typeof e.find !== "string" || typeof e.replace !== "string") throw new Error(`undo.json edit ${i + 1} needs file, find and replace`);
    return { file: e.file, find: e.find, replace: e.replace };
  });
}

/** Undoes the case's fix in the checkout at `root`, or with `write` off only says whether it can.
 *  Returns why it cannot, or undefined. */
export function undo(root: string, caseDir: string, write: boolean): string | undefined {
  const json = path.join(caseDir, "undo.json");
  if (!existsSync(json)) return "no undo.json";
  try {
    const texts = new Map<string, string>();
    for (const e of parseEdits(json)) {
      const at = path.join(root, e.file);
      if (!texts.has(e.file) && !existsSync(at)) throw new Error(`${e.file}: no such file`);
      texts.set(e.file, swap(texts.get(e.file) ?? readFileSync(at, "utf8"), e));
    }
    if (write) for (const [file, text] of texts) writeFileSync(path.join(root, file), text);
    return undefined;
  } catch (e) {
    return `the undo does not apply: ${e instanceof Error ? e.message : String(e)}`;
  }
}
