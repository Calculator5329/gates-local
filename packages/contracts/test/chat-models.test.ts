// Row 7 (roadmap 274c94c9): the suggested chat models are one data file. The
// app's code names no model from it, so changing the list never needs a code
// edit, and a broken edit is refused with the reason.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import data from "../src/chat-models.json" with { type: "json" };

const root = join(import.meta.dirname, "../../..");
/** Every non-test source file of the web client and the server. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
  };
  for (const app of ["apps/web/src", "apps/server/src"]) walk(join(root, app));
  return out;
}

describe("the suggested chat models", () => {
  it("are named only in chat-models.json: no source file spells a listed tag or label", () => {
    const named = data.models.flatMap((m) => [m.name, m.label]);
    const hits = sources().flatMap((file) => {
      // comment lines may name a model as an example; code may not
      const text = readFileSync(file, "utf8").split("\n").filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).join("\n");
      return named.filter((n) => new RegExp(`["'\`>]${n.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)).map((n) => `${file.slice(root.length + 1)}: ${n}`);
    });
    expect(hits).toEqual([]);
  });

  it("load with no problems, and a pick outside the list is refused by name", async () => {
    const { chatModelsProblems, CHAT_MODELS } = await import("../src/chat-models.ts");
    expect(chatModelsProblems(CHAT_MODELS)).toEqual([]);
    const broken = { ...CHAT_MODELS, tiers: { ...CHAT_MODELS.tiers, gpu: [{ gb: 8, picks: ["qwen3:14b"] }] } };
    expect(chatModelsProblems(broken)).toEqual(["gpu 8 GB: qwen3:14b is not in models"]);
    expect(chatModelsProblems({ ...CHAT_MODELS, typedExample: CHAT_MODELS.example })).toEqual([`typedExample ${CHAT_MODELS.example} is already in models`]);
  });
});
