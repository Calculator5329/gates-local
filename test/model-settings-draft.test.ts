// The window's model-settings draft (apps/web) against the server's settings
// store: a draft sends only the controls the person changed.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openSettingsStore } from "../apps/server/src/settings/store.ts";
import { controlPatch, editControl } from "../apps/web/src/instruction-draft.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanups.splice(0).toReversed()) await close(); });
const dir = () => {
  const root = mkdtempSync(path.join(tmpdir(), "model-settings-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
};
const saved = (dataDir = dir()) => openSettingsStore({ dataDir, systemOllamaAnswers: async () => true });
const MODEL = "qwen3.5:9b";

it("MT-01: reverting 0.5 to 0.6 to 0.5 does not overwrite another client's 0.7 when seed is saved", async () => {
  const store = await saved();
  store.updateModel(MODEL, { temperature: 0.5 });
  let draft = editControl(store.get().modelSettings?.[MODEL] ?? {}, {}, "temperature", "0.6");
  draft = editControl(store.get().modelSettings?.[MODEL] ?? {}, draft, "temperature", "0.5");
  store.updateModel(MODEL, { temperature: 0.7 });
  draft = editControl(store.get().modelSettings?.[MODEL] ?? {}, draft, "seed", "42");
  store.updateModel(MODEL, controlPatch(draft));
  expect(store.get().modelSettings?.[MODEL]).toEqual({ temperature: 0.7, seed: 42 });
  expect(draft).not.toHaveProperty("temperature");
});
