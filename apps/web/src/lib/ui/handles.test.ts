import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { handleKey } from "./handles.ts";

const SRC = new URL("../../", import.meta.url);
const ID_ATTR = /\b(?:data-testid|testid|testId)=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})|"data-testid":\s*"([^"]*)"/g;
const GRAMMAR = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

function testIds(): { file: string; id: string }[] {
  const out: { file: string; id: string }[] = [];
  for (const file of readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tsx"))) {
    for (const m of readFileSync(new URL(file, SRC), "utf8").matchAll(ID_ATTR)) {
      out.push({ file, id: m[1] ?? m[2] ?? m[3] ?? m[4] ?? "" });
    }
  }
  return out;
}

it("an item's key becomes the lowercase kebab last part of its identity, with no edge dashes, one dash per run of other characters, and none when nothing is left", () => {
  expect(handleKey("qwen3.5:4b")).toBe("qwen3-5-4b");
  expect(handleKey("--Llama 3 ::Q4__K_M--")).toBe("llama-3-q4-k-m");
  expect(handleKey("  hf.co/Org/Model  ")).toBe("hf-co-org-model");
  expect(handleKey(42)).toBe("42");
  expect(handleKey("")).toBe("none");
  expect(handleKey("::--..")).toBe("none");
});

it("every test identity in the web app is dot-separated lowercase kebab parts, an item's key filling a part", () => {
  const ids = testIds();
  expect(ids.length).toBeGreaterThan(300);
  for (const { file, id } of ids) expect(id.replaceAll(/\$\{[^}]*\}/g, "x"), `${file}: ${id}`).toMatch(GRAMMAR);
});
