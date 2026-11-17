import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OWN_MODELS_FILE, keptRecord } from "./kept-record.ts";

const folder = () => mkdtempSync(path.join(os.tmpdir(), "gates-local-kept-"));
const saved = (dir: string) => JSON.parse(readFileSync(path.join(dir, OWN_MODELS_FILE), "utf8")) as { models: { tag: string; carried?: boolean }[] };

/** decision 2026-11-17: a chat model this app loaded is its own, recorded across one restart. */
describe("the app's own chat models, kept across one restart", () => {
  it("a model the app loaded is its own after one restart and no longer after two", () => {
    const dir = folder();
    const first = keptRecord({ dataDir: dir, mode: () => "system", now: () => 5 });
    first.loaded("qwen3.5:9b", 16384);
    expect(saved(dir).models).toEqual([{ tag: "qwen3.5:9b", numCtx: 16384, at: 5, mode: "system" }]);

    const second = keptRecord({ dataDir: dir, mode: () => "system" });
    expect(second.oursAt("qwen3.5:9b"), "one restart: still the app's").toBe(16384);
    expect(second.listed(), "not said to be resident until Ollama lists it").toEqual([]);
    expect(saved(dir).models, "written back as carried, at its first time").toEqual([{ tag: "qwen3.5:9b", numCtx: 16384, at: 5, mode: "system", carried: true }]);

    const third = keptRecord({ dataDir: dir, mode: () => "system" });
    expect(third.ours(), "a second restart drops it").toEqual([]);
  });

  it("a carried model the app loads again is fresh, so it survives the next restart", () => {
    const dir = folder();
    keptRecord({ dataDir: dir, mode: () => "system" }).loaded("m:7b", 8192);
    keptRecord({ dataDir: dir, mode: () => "system", now: () => 9 }).loaded("m:7b", 8192);
    expect(keptRecord({ dataDir: dir, mode: () => "system" }).oursAt("m:7b")).toBe(8192);
  });

  it("a model that left, or a runtime switch, is gone from the file too", () => {
    const dir = folder();
    const record = keptRecord({ dataDir: dir, mode: () => "system" });
    record.loaded("a:1b", 4096);
    record.loaded("b:1b", 4096);
    record.observe([{ name: "b:1b" }]);
    expect(saved(dir).models.map((m) => m.tag)).toEqual(["b:1b"]);
    const kept = record.clear();
    expect(saved(dir).models).toEqual([]);
    record.restore(kept);
    expect(saved(dir).models.map((m) => m.tag), "a refused switch puts it back").toEqual(["b:1b"]);
  });

  it("a record written for the other runtime, or a file that cannot be read, makes nothing the app's", () => {
    const dir = folder();
    keptRecord({ dataDir: dir, mode: () => "app" }).loaded("m:7b", 8192);
    expect(keptRecord({ dataDir: dir, mode: () => "system" }).ours()).toEqual([]);

    const broken = folder();
    writeFileSync(path.join(broken, OWN_MODELS_FILE), "{ not json");
    const lines: string[] = [];
    expect(keptRecord({ dataDir: broken, mode: () => "system", log: (l) => lines.push(l) }).ours()).toEqual([]);
    expect(lines.join("\n")).toContain("unreadable");
  });

  it.each([
    ["not JSON", "{ not json"],
    ["JSON of another shape", `{"version":2,"entries":[]}\n`],
  ])("a file the app cannot decode (%s) is moved aside once, never written over", (_, text) => {
    const dir = folder();
    writeFileSync(path.join(dir, OWN_MODELS_FILE), text);
    const lines: string[] = [];
    keptRecord({ dataDir: dir, mode: () => "system", now: () => 77, log: (l) => lines.push(l) }).loaded("m:7b", 8192);
    const aside = path.join(dir, `${OWN_MODELS_FILE}.unreadable-77`);
    expect(existsSync(aside) ? readFileSync(aside, "utf8") : "missing", "the person's file, as it was").toBe(text);
    expect(saved(dir).models.map((m) => m.tag), "then the app writes its own").toEqual(["m:7b"]);
    expect(lines.join("\n")).toContain(`${OWN_MODELS_FILE}.unreadable-77`);
    keptRecord({ dataDir: dir, mode: () => "system", now: () => 78 });
    expect(readdirSync(dir).filter((f) => f.includes("unreadable")), "the app's own file is read, not moved again").toEqual([`${OWN_MODELS_FILE}.unreadable-77`]);
  });
});
