// Prepare durable test data before starting any timed server-readiness checks.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { defaultSettings } from "../../apps/server/src/settings/store.ts";
import type { openThreadStore } from "../../apps/server/src/threads/store.ts";

export interface FixtureIds { short: string; long: string; thousands: string; huge: string }

/** Build one closed, pristine database using the subject commit's store and schema. */
export async function prepareFixture(target: string): Promise<string> {
  const cache = path.join(homedir(), ".cache", "gates-local-perf");
  mkdirSync(cache, { recursive: true });
  const data = mkdtempSync(path.join(cache, "fixture-"));
  const db = path.join(data, "threads.sqlite");
  const subject = await import(pathToFileURL(path.join(target, "apps/server/src/threads/store.ts")).href) as { openThreadStore: typeof openThreadStore };
  const store = subject.openThreadStore(db);
  try {
    function seedLong(messages: number) {
      const id = store.createThread({ title: `Perf ${messages === 200 ? "long" : "thousands"} ${messages}` }).id;
      for (let i = 0; i < messages; i++) store.appendMessage({ threadId: id, role: i % 2 ? "assistant" : "user", content: i % 2 ? "A measured answer.\n\n- First item\n- Second item\n\n```ts\nconst value = 42;\n```" : `Question ${i}`, ...(i % 2 ? { model: "qwen3.5:9b" } : {}) });
      return id;
    }
    const long = seedLong(200);
    const thousands = seedLong(2000);
    const short = store.createThread({ title: "Perf short" }).id;
    store.appendMessage({ threadId: short, role: "user", content: "Short marker" });
    const huge = store.createThread({ title: "Perf huge reply" }).id;
    const hugeText = ["Huge reply marker", "", "```ts", ...Array.from({ length: 4000 }, (_, i) => `const item${i} = { value: ${i}, label: 'deterministic code fixture' };`), "```", "", "| Item | Value |", "| --- | --- |", ...Array.from({ length: 300 }, (_, i) => `| Row ${i} | Value ${i} |`), "", "Huge reply end"].join("\n");
    store.appendMessage({ threadId: huge, role: "assistant", content: hugeText, model: "qwen3.5:9b" });
    for (let i = 0; i < 396; i++) store.createThread({ title: `Perf sidebar ${String(i).padStart(3, "0")}` });
    const settings = await import(pathToFileURL(path.join(target, "apps/server/src/settings/store.ts")).href) as { defaultSettings: typeof defaultSettings; SETTINGS_FILE_NAME: string; SETTINGS_FILE_VERSION: number };
    writeFileSync(path.join(data, settings.SETTINGS_FILE_NAME), JSON.stringify({ version: settings.SETTINGS_FILE_VERSION, settings: { ...settings.defaultSettings("system"), thinking: false } }));
    writeFileSync(path.join(data, "fixture.json"), JSON.stringify({ short, long, thousands, huge }));
    return data;
  } finally { store.close(); }
}

/** Each server gets independent files; mutations never reach another block or the template. */
export function restoreFixture(prepared: string, destination: string): FixtureIds {
  const ids: unknown = JSON.parse(readFileSync(path.join(prepared, "fixture.json"), "utf8"));
  if (typeof ids !== "object" || ids === null
    || !("short" in ids) || typeof ids.short !== "string" || ids.short.length === 0
    || !("long" in ids) || typeof ids.long !== "string" || ids.long.length === 0
    || !("thousands" in ids) || typeof ids.thousands !== "string" || ids.thousands.length === 0
    || !("huge" in ids) || typeof ids.huge !== "string" || ids.huge.length === 0) throw new Error("Invalid prepared performance fixture");
  cpSync(prepared, destination, { recursive: true, force: false, errorOnExist: true });
  return { short: ids.short, long: ids.long, thousands: ids.thousands, huge: ids.huge };
}
