import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeRequest } from "@gates-local/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { imageToolChoice } from "../image/presets.ts";
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
    expect(s.get()).toEqual({ defaultNumCtx: 16384, thinking: true, theme: "dark", runtimeMode: "system", tools: true, imageGen: false });
    expect(s.loadNote).toBeUndefined();
    expect(JSON.parse(readFileSync(fileIn(dir), "utf8"))).toEqual({ version: 1, settings: s.get() });
  });

  it("a file from before image presets loads with Make images off; the choice and the switch persist and clear", async () => {
    const dir = dataDir();
    // What a person who used the Image button had on disk: image generation on, nothing else.
    writeFileSync(fileIn(dir), JSON.stringify({ version: 1, settings: { defaultNumCtx: 16384, thinking: true, theme: "dark", runtimeMode: "system", tools: true, imageGen: true, comfyUrl: "http://127.0.0.1:8188" } }));
    const s = await open(dir);
    expect(s.loadNote).toBeUndefined();
    expect(s.get().imageTool).toBeUndefined();
    expect(imageToolChoice(s.get())).toBeUndefined();
    s.update({ imageChoice: { preset: "moss-image", width: 1024, height: 1024 }, imageTool: true });
    const again = await open(dir);
    expect(again.get()).toMatchObject({ imageChoice: { preset: "moss-image", width: 1024, height: 1024 }, imageTool: true });
    expect(imageToolChoice(again.get())).toEqual({ preset: "moss-image", width: 1024, height: 1024 });
    again.update({ imageChoice: null, imageGen: false });
    expect(again.get()).not.toHaveProperty("imageChoice");
    // Image generation off turns the tool off with it, whatever the switch says.
    expect(imageToolChoice(again.get())).toBeUndefined();
  });

  it("first run with no system Ollama picks the app's own copy", async () => {
    expect((await open(dataDir(), false)).get().runtimeMode).toBe("app");
  });

  it("an update persists, survives a reopen, and null clears defaultModel and comfyUrl", async () => {
    const dir = dataDir();
    const s = await open(dir);
    s.update({ defaultModel: "qwen3.5:9b", comfyUrl: "http://127.0.0.1:8188", whisperUrl: "http://127.0.0.1:18078", thinking: false, defaultNumCtx: 32768 });
    const again = await open(dir, false);
    expect(again.get()).toMatchObject({ defaultModel: "qwen3.5:9b", comfyUrl: "http://127.0.0.1:8188", whisperUrl: "http://127.0.0.1:18078", thinking: false, defaultNumCtx: 32768, runtimeMode: "system" });
    again.update({ defaultModel: null, comfyUrl: null, whisperUrl: null });
    const third = await open(dir);
    expect(third.get()).not.toHaveProperty("defaultModel");
    expect(third.get()).not.toHaveProperty("comfyUrl");
    expect(third.get()).not.toHaveProperty("whisperUrl");
    // No temp file left behind by the atomic write.
    expect(readdirSync(dir)).toEqual([SETTINGS_FILE_NAME]);
  });

  it("the accent saves, survives a reopen, and a first run has none (Neutral)", async () => {
    const dir = dataDir();
    const s = await open(dir);
    expect(s.get()).not.toHaveProperty("accent");
    s.update({ accent: "violet" });
    expect((await open(dir)).get().accent).toBe("violet");
    s.update({ accent: "neutral" });
    expect((await open(dir)).get().accent).toBe("neutral");
  });

  it("a file from when Text size existed loads at the default size, and an old client's text size is ignored without an error", async () => {
    const dir = dataDir();
    writeFileSync(fileIn(dir), JSON.stringify({ version: 1, settings: { defaultNumCtx: 16384, thinking: true, theme: "light", runtimeMode: "system", tools: true, imageGen: false, textSize: "large" } }));
    const s = await open(dir);
    expect(s.loadNote).toBeUndefined();
    expect(readdirSync(dir)).toEqual([SETTINGS_FILE_NAME]);
    expect(s.get()).toEqual({ defaultNumCtx: 16384, thinking: true, theme: "light", runtimeMode: "system", tools: true, imageGen: false });
    // an app from before the removal still sends it with Reset: the request decodes, without it
    const old = decodeRequest(JSON.stringify({ type: "request", id: "old", method: "settings.update", params: { textSize: "large", thinking: false } }));
    expect(old.ok && old.value.params).toEqual({ thinking: false });
    expect(() => s.update({ textSize: "large", thinking: false } as Parameters<typeof s.update>[0])).not.toThrow();
    expect(s.get()).not.toHaveProperty("textSize");
    expect(s.get().thinking).toBe(false);
    expect(JSON.parse(readFileSync(fileIn(dir), "utf8")).settings).not.toHaveProperty("textSize");
  });

  it("a corrupt file is kept aside and defaults load", async () => {
    const dir = dataDir();
    writeFileSync(fileIn(dir), "{ not json");
    const s = await open(dir);
    const aside = `${fileIn(dir)}.bad-2026-11-07T21-04-05-123Z`;
    expect(readFileSync(aside, "utf8")).toBe("{ not json");
    expect(s.loadNote).toContain("is not valid JSON");
    expect(s.loadNote).toContain(aside);
    expect(s.get().theme).toBe("dark");
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
    writeFileSync(fileIn(dir), JSON.stringify({ version: 1, settings: { defaultNumCtx: 12345, thinking: true, theme: "dark", runtimeMode: "system", tools: true, imageGen: false } }));
    const s = await open(dir);
    expect(s.loadNote).toContain("does not match the settings shape");
    expect(existsSync(`${fileIn(dir)}.bad-2026-11-07T21-04-05-123Z`)).toBe(true);
    expect(s.get().defaultNumCtx).toBe(16384);
  });

  it("an interrupted write (the rename throws) leaves the old file intact, the settings unchanged and no temp file", async () => {
    const dir = dataDir();
    let fail = false;
    const s = await openSettingsStore({
      dataDir: dir,
      systemOllamaAnswers: async () => true,
      now: () => NOW,
      rename: (from, to) => {
        if (fail) throw new Error("EIO: power cut");
        renameSync(from, to);
      },
    });
    s.update({ defaultModel: "qwen3.5:9b" });
    const before = readFileSync(fileIn(dir), "utf8");
    fail = true;
    expect(() => s.update({ defaultModel: "gemma3:4b", thinking: false })).toThrow(/power cut/);
    expect(readFileSync(fileIn(dir), "utf8")).toBe(before);
    expect(s.get()).toMatchObject({ defaultModel: "qwen3.5:9b", thinking: true });
    expect(readdirSync(dir)).toEqual([SETTINGS_FILE_NAME]);
    expect((await open(dir)).get().defaultModel).toBe("qwen3.5:9b");
  });

  it("two stores on one file: the later write wins and the file stays valid JSON", async () => {
    const dir = dataDir();
    const a = await open(dir);
    const b = await open(dir);
    a.update({ defaultModel: "qwen3.5:9b", theme: "light" });
    b.update({ defaultModel: "gemma3:4b" });
    const onDisk = JSON.parse(readFileSync(fileIn(dir), "utf8")) as { version: number; settings: Record<string, unknown> };
    expect(onDisk.version).toBe(1);
    expect(onDisk.settings).toEqual(b.get());
    expect(onDisk.settings).toMatchObject({ defaultModel: "gemma3:4b", theme: "dark" });
    expect(readdirSync(dir)).toEqual([SETTINGS_FILE_NAME]);
    expect((await open(dir)).get().defaultModel).toBe("gemma3:4b");
  });
});

describe("settings handlers", () => {
  it("echoes voice save provenance without persisting it, including an already-disconnected save", async () => {
    const s = await open(dataDir());
    const pushes: unknown[] = [];
    const h = createSettingsHandlers({ settings: s, push: (channel, payload) => pushes.push({ channel, payload }) });
    const next = h["settings.update"]({ whisperUrl: null, voiceChange: "disconnect-action" });
    expect(pushes).toEqual([{ channel: "settings.changed", payload: { ...next, voiceChange: "disconnect-action" } }]);
    expect(s.get()).not.toHaveProperty("voiceChange");
  });
  it("settings.update pushes settings.changed once per real change and notifies readers", async () => {
    const s = await open(dataDir());
    const pushes: unknown[] = [];
    const seen: string[] = [];
    s.onChange((next, prev) => seen.push(`${prev.theme}->${next.theme}`));
    const h = createSettingsHandlers({ settings: s, push: (channel, payload) => pushes.push({ channel, payload }) });
    const next = await h["settings.update"]({ theme: "light" });
    expect(next.theme).toBe("light");
    await h["settings.update"]({ theme: "light" });
    expect(pushes).toEqual([{ channel: "settings.changed", payload: next }]);
    expect(seen).toEqual(["dark->light"]);
    expect(await h["settings.get"]()).toEqual(next);
  });
});
