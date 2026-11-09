import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createClient, type Client, type SocketLike, type SyncMetadata } from "@gates-local/contracts";
import { WebSocket } from "ws";
import { startWsServer, type WsServer } from "../ws/server.ts";
import { createSettingsHandlers } from "./handlers.ts";
import { openSettingsStore } from "./store.ts";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).toReversed()) await close(); });
async function store() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ordered-settings-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  return openSettingsStore({ dataDir, systemOllamaAnswers: async () => true });
}

it("settings revisions follow committed immutable values, including reentrant writes and no-ops", async () => {
  const settings = await store(), initial = settings.get();
  settings.onChange(next => { if (next.theme === "light" && next.thinking) settings.update({ thinking: false }); });
  const first = settings.update({ theme: "light" });
  const current = settings.get();
  expect(settings.stamp(initial)).toEqual({ scope: "settings", kind: "snapshot", rev: 0 });
  expect(settings.stamp(first)).toEqual({ scope: "settings", kind: "snapshot", rev: 1 });
  expect(settings.stamp(current)).toEqual({ scope: "settings", kind: "snapshot", rev: 2 });
  expect(settings.update({ theme: "light" })).toBe(current);
  expect(settings.stamp(current)).toEqual({ scope: "settings", kind: "snapshot", rev: 2 });
  expect(() => settings.updateModel("model", { top_p: 2 })).toThrow();
  expect(settings.stamp(settings.get())).toEqual({ scope: "settings", kind: "snapshot", rev: 2 });
});

it("the real transport retains captured read/save revisions across later writers and keeps old peers unchanged", async () => {
  const settings = await store();
  let server: WsServer | undefined;
  const h = createSettingsHandlers({ settings, push: (channel, payload, changes) => server?.push(channel, payload, changes) });
  const reads: Array<() => void> = [], saves: Array<() => void> = [];
  let holdRead = false, holdSave = false;
  server = await startWsServer({ port: 0, token: "fixture", allowedOrigins: [], ordered: ["settings"], handlers: {
    ...h,
    "settings.get": (params, ctx) => {
      const value = h["settings.get"](params, ctx);
      return holdRead ? new Promise(resolve => reads.push(() => resolve(value))) : value;
    },
    "settings.update": (params, ctx) => {
      const value = h["settings.update"](params, ctx);
      return holdSave ? new Promise(resolve => saves.push(() => resolve(value))) : value;
    },
  } });
  cleanup.push(() => server?.close());
  const peer = (): Client => {
    const client = createClient(new WebSocket(`ws://127.0.0.1:${server?.port}/?token=fixture`) as unknown as SocketLike);
    cleanup.push(() => client.close()); return client;
  };
  const a = peer(), b = peer(), old = peer();
  const negotiated = await a.negotiate();
  expect(negotiated.mode).toBe("ordered");
  await b.negotiate();
  const snapshots: Array<{ theme: string; sync: SyncMetadata | undefined }> = [];
  const pushes: Array<{ voiceChange?: string; sync: SyncMetadata | undefined }> = [];
  a.subscribe("settings.changed", (value, sync) => pushes.push({ voiceChange: value.voiceChange, sync }));

  holdRead = true;
  const read = a.call("settings.get", {}, { onResult: (value, sync) => snapshots.push({ theme: value.theme, sync }) });
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  holdRead = false; holdSave = true;
  const save = a.call("settings.update", { theme: "light" }, { onResult: (value, sync) => snapshots.push({ theme: value.theme, sync }) });
  await vi.waitFor(() => expect(saves).toHaveLength(1));
  let modelSync: SyncMetadata | undefined;
  await b.call("settings.model.update", { model: "model:latest", patch: { systemPrompt: "model prompt" } }, { onMetadata: sync => { modelSync = sync; } });
  expect(modelSync?.changes).toEqual([{ scope: "settings", kind: "snapshot", rev: 2 }]);
  holdSave = false;
  let legacyMetadata: SyncMetadata | undefined;
  await old.call("settings.update", { theme: "dark" }, { onMetadata: sync => { legacyMetadata = sync; } });
  expect(legacyMetadata).toBeUndefined();
  saves[0]?.(); reads[0]?.();
  await expect(save).resolves.toMatchObject({ theme: "light" });
  await expect(read).resolves.toMatchObject({ theme: "dark" });
  expect(snapshots.map(value => [value.theme, value.sync?.changes])).toEqual([
    ["light", [{ scope: "settings", kind: "snapshot", rev: 1 }]],
    ["dark", [{ scope: "settings", kind: "snapshot", rev: 0 }]],
  ]);
  await a.call("settings.update", { theme: "dark", voiceChange: "no-op-owner" });
  expect(pushes.map(value => value.sync?.changes)).toEqual([1, 2, 3, 3].map(rev => [{ scope: "settings", kind: "snapshot", rev }]));
  expect(pushes.at(-1)?.voiceChange).toBe("no-op-owner");
  expect(settings.stamp(settings.get())).toEqual({ scope: "settings", kind: "snapshot", rev: 3 });
});
