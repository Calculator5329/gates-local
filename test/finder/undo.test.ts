import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { swap, undo } from "./undo.ts";

describe("swap", () => {
  const e = { file: "a.ts", find: "lit: reading", replace: "lit: null" };
  it("makes the edit where the text is once", () => {
    expect(swap("x\n  lit: reading,\ny", e)).toBe("x\n  lit: null,\ny");
  });
  it("refuses text that is gone, or there twice", () => {
    expect(() => swap("x\ny", e)).toThrow("a.ts: the text to undo is there 0 times, not once");
    expect(() => swap("lit: reading; lit: reading", e)).toThrow("there 2 times");
    expect(() => swap("anything", { ...e, find: "" })).toThrow("there 0 times");
  });
  it("puts the new text in as written, dollar signs and all", () => {
    expect(swap("a lit: reading b", { ...e, replace: "$& $1 `${x}`" })).toBe("a $& $1 `${x}` b");
  });
});

function tree(edits: unknown): { root: string; dir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "finder-undo-"));
  const dir = path.join(root, "case");
  mkdirSync(path.join(root, "src"));
  mkdirSync(dir);
  writeFileSync(path.join(root, "src/a.css"), ".a{height:1px}\n.b{flex:1}\n");
  if (edits !== undefined) writeFileSync(path.join(dir, "undo.json"), JSON.stringify(edits));
  return { root, dir };
}
describe("undo", () => {
  const two = [{ file: "src/a.css", find: "height:1px", replace: "max-height:1px" }, { file: "src/a.css", find: ".b{flex:1}", replace: ".b{flex:0}" }];

  it("makes every edit of a case, a later one on top of an earlier one in the same file", () => {
    const { root, dir } = tree(two);
    expect(undo(root, dir, true)).toBeUndefined();
    expect(readFileSync(path.join(root, "src/a.css"), "utf8")).toBe(".a{max-height:1px}\n.b{flex:0}\n");
  });
  it("only asks, and writes nothing, with write off", () => {
    const { root, dir } = tree(two);
    expect(undo(root, dir, false)).toBeUndefined();
    expect(readFileSync(path.join(root, "src/a.css"), "utf8")).toBe(".a{height:1px}\n.b{flex:1}\n");
  });
  it("writes nothing when one edit of several no longer fits", () => {
    const { root, dir } = tree([two[0], { file: "src/a.css", find: ".c{}", replace: "" }]);
    expect(undo(root, dir, true)).toBe('the undo does not apply: src/a.css: the text to undo is there 0 times, not once: ".c{}"');
    expect(readFileSync(path.join(root, "src/a.css"), "utf8")).toBe(".a{height:1px}\n.b{flex:1}\n");
  });
  it("says what is wrong with the case: no list, an empty one, a missing file, a half edit", () => {
    expect(undo(...Object.values(tree(undefined)) as [string, string], false)).toBe("no undo.json");
    expect(undo(...Object.values(tree([])) as [string, string], false)).toBe("the undo does not apply: undo.json is not a list of edits");
    expect(undo(...Object.values(tree([{ file: "src/gone.css", find: "a", replace: "b" }])) as [string, string], false)).toBe("the undo does not apply: src/gone.css: no such file");
    expect(undo(...Object.values(tree([{ file: "src/a.css", find: "a" }])) as [string, string], false)).toBe("the undo does not apply: undo.json edit 1 needs file, find and replace");
  });
});
