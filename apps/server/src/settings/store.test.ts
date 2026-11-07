import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSettingsHandlers } from "./handlers.ts";
import { openSettingsStore, SETTINGS_FILE_NAME } from "./store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dataDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "gates-settings-"));
  dirs.push(d);
  return d;
}
const NOW = Date.UTC(2026, 10, 7, 21, 4, 5, 123);
const open = (dir: string, system = true) => openSettingsStore({ dataDir: dir, systemOllamaAnswers: async () => system, now: () => NOW });
const fileIn = (dir: string) => path.join(dir, SETTINGS_FILE_NAME);

describe("settings store", () => {
  it("first run: defaults with the system Ollama when one answers, written to disk", async () => {
    const dir = dataDir();
    const s = await open(dir, true);
    expect(s.get()).toEqual({ defaultNumCtx: 16384, thinking: true, theme: "system", runtimeMode: "system", tools: true, imageGen: false });
    expect(s.loadNote).toBeUndefined();
    expect(JSON.parse(readFileSync(fileIn(dir), "utf8"))).toEqual({ version: 1, settings: s.get() });
  });

  it("first run with no system Ollama picks the app's own copy", async () => {
    expect((await open(dataDir(), false)).get().runtimeMode).toBe("app");
  });

  it("an update persists, survives a reopen, and null clears defaultModel and comfyUrl", async () => {
    const dir = dataDir();
    const s = await open(dir);
    s.update({ defaultModel: "qwen3.5:9b", comfyUrl: "http://127.0.0.1:8188", thinking: false, defaultNumCtx: 32768 });
    const again = await open(dir, false);
    expect(again.get()).toMatchObject({ defaultModel: "qwen3.5:9b", comfyUrl: "http://127.0.0.1:8188", thinking: false, defaultNumCtx: 32768, runtimeMode: "system" });
    again.update({ defaultModel: null, comfyUrl: null });
    const third = await open(dir);
    expect(third.get()).not.toHaveProperty("defaultModel");
    expect(third.get()).not.toHaveProperty("comfyUrl");
    // No temp file left behind by the atomic write.
    expect(readdirSync(dir)).toEqual([SETTINGS_FILE_NAME]);
  });

  it("a corrupt file is kept aside and defaults load", async () => {
    const dir = dataDir();
    writeFileSync(fileIn(dir), "{ not json");
    const s = await open(dir);
    const aside = `${fileIn(dir)}.bad-2026-11-07T21-04-05-123Z`;
    expect(readFileSync(aside, "utf8")).toBe("{ not json");
    expect(s.loadNote).toContain("is not valid JSON");
    expect(s.loadNote).toContain(aside);
    expect(s.get().theme).toBe("system");
  });

  it("a file a newer build wrote is kept aside, not overwritten in place", async () => {
    const dir = dataDir();
    const newer = JSON.stringify({ version: 2, settings: { theme: "sepia" } });
    writeFileSync(fileIn(dir), newer);
    const s = await open(dir);
    expect(s.loadNote).toContain("newer Gates Local");
    expect(readFileSync(`${fileIn(dir)}.bad-2026-11-07T21-04-05-123Z`, "utf8")).toBe(newer);
    expect(JSON.parse(readFileSync(fileIn(dir), "utf8")).version).toBe(1);
  });

  it("a value outside the schema is a bad file too", async () => {
    const dir = dataDir();
    writeFileSync(fileIn(dir), JSON.stringify({ version: 1, settings: { defaultNumCtx: 8192, thinking: true, theme: "dark", runtimeMode: "system", tools: true, imageGen: false } }));
    const s = await open(dir);
    expect(s.loadNote).toContain("does not match the settings shape");
    expect(existsSync(`${fileIn(dir)}.bad-2026-11-07T21-04-05-123Z`)).toBe(true);
    expect(s.get().defaultNumCtx).toBe(16384);
  });
});

describe("settings handlers", () => {
  it("settings.update pushes settings.changed once per real change and notifies readers", async () => {
    const s = await open(dataDir());
    const pushes: unknown[] = [];
    const seen: string[] = [];
    s.onChange((next, prev) => seen.push(`${prev.theme}->${next.theme}`));
    const h = createSettingsHandlers({ settings: s, push: (channel, payload) => pushes.push({ channel, payload }) });
    const next = await h["settings.update"]({ theme: "dark" });
    expect(next.theme).toBe("dark");
    await h["settings.update"]({ theme: "dark" });
    expect(pushes).toEqual([{ channel: "settings.changed", payload: next }]);
    expect(seen).toEqual(["system->dark"]);
    expect(await h["settings.get"]()).toEqual(next);
  });
});
