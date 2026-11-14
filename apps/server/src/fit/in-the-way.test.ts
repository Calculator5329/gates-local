// A model the card holds runs slower right now because other programs hold part of the card. The
// fit table names them on the row's card verdict (card.inTheWay), biggest first, as many as cover
// the spill. The reading is the app's own record of a 27B run on a 16 GB card: the file 13.21 GB,
// 15.36 GB planned at 16K against 11.86 GB usable, 3.49 GB spilled; Whisper held 2.0 GiB, a model
// that leaves for the load held 8.6 GiB, the desktop and a few apps the rest.
import { readFileSync } from "node:fs";
import type { FitTable } from "@gates-local/contracts";
import { afterEach, expect, it } from "vitest";
import { createGpuBaseline } from "./baseline.ts";
import { MIB } from "./constants.ts";
import { json, startFakeServer, type FakeServer } from "./fake-http.ts";
import { createFitTable, inTheWay } from "./table.ts";
import type { NvidiaSmiRunner } from "./types.ts";

const SHOW = JSON.parse(readFileSync(new URL("./fixtures/show-qwen3-8-abliterated-27b.json", import.meta.url), "utf8")) as unknown;
const MODEL = { name: "big-model:27b", weights: 13210122027 };
const LEAVING = { name: "other-model:12b", sizeVram: 8.39e9 };

let servers: FakeServer[] = [];
afterEach(async () => {
  for (const s of servers) await s.close();
  servers = [];
});

/** The card as nvidia-smi read it when the row was planned: 3827 of 16303 MiB free, 1050 MiB of the used no process claims. */
function reading(): NvidiaSmiRunner {
  const whisperMib = 2010;
  const apps = [
    [1200, "/usr/bin/kwin_wayland", 108],
    [3300, "/opt/chat-app/chat-app --type=gpu-process", 129],
    [3400, "/usr/bin/python3", 222],
    [4400, "/opt/browser/browser --type=gpu-process", 74],
    [5100, "/usr/bin/whisper-server", whisperMib],
    [5200, "/opt/desk/electron --type=gpu-process", 61],
    [5800, "/usr/local/lib/ollama/llama-server", 8822],
  ] as const;
  const used = apps.reduce((n, [, , mib]) => n + mib, 0) + 1050;
  return async (args) =>
    args[0]?.startsWith("--query-gpu") ? `16303, ${used}, ${16303 - used}\n` : apps.map(([pid, name, mib]) => `${pid}, ${name}, ${mib}\n`).join("");
}

async function table(smi: NvidiaSmiRunner): Promise<FitTable> {
  const s = await startFakeServer({
    "GET /api/tags": (_b, res) => json(res, 200, { models: [{ name: MODEL.name, size: MODEL.weights, digest: "d" }] }),
    "GET /api/ps": (_b, res) => json(res, 200, { models: [{ name: LEAVING.name, model: LEAVING.name, size: LEAVING.sizeVram, size_vram: LEAVING.sizeVram, context_length: 16384 }] }),
    "POST /api/show": (_b, res) => json(res, 200, SHOW),
  });
  servers.push(s);
  return createFitTable({
    baseUrl: () => s.baseUrl,
    fit: { runNvidiaSmi: smi, readMeminfo: async () => "MemTotal: 32000000 kB\nMemAvailable: 22000000 kB\n", now: () => 1, baseline: createGpuBaseline() },
    models: async () => [{ name: MODEL.name, downloadBytes: MODEL.weights, installed: true }],
    busy: () => [],
    comfyPid: () => undefined,
    push: () => undefined,
    boot: "b",
  }).get();
}

const at16k = (t: FitTable) => t.rows.find((r) => r.model === MODEL.name && r.numCtx === 16384);

it("the 27B at 16K: fits the card, spills right now, and the card names Whisper first, then as many as cover the spill", async () => {
  const row = at16k(await table(reading()));
  expect(row).toMatchObject({ verdict: "spills", card: { verdict: "fits" } });
  // the app's record: 3.49 GB spilled
  expect(row!.spillRamBytes / 1e9).toBeCloseTo(3.49, 1);
  const named = row!.card!.inTheWay ?? [];
  expect(named[0]).toEqual({ label: "Whisper", bytes: 2010 * MIB, kind: "whisper", protected: true });
  // biggest first, and never the runtime's runner
  expect(named.map((o) => o.bytes)).toEqual(named.map((o) => o.bytes).toSorted((a, b) => b - a));
  expect(named.some((o) => o.kind === "chat-model")).toBe(false);
});

it("nothing is named where the model runs on the GPU right now, or where the card itself does not hold it", async () => {
  const t = await table(reading());
  for (const r of t.rows) {
    if (r.verdict === "spills" && r.card?.verdict === "fits") continue;
    expect(r.card?.inTheWay, `${r.numCtx}: ${r.verdict} / card ${r.card?.verdict}`).toBeUndefined();
  }
});

const h = (label: string, gb: number) => ({ label, bytes: gb * 1e9, kind: "other-app" as const, protected: true });

it("inTheWay covers the gap with the fewest, biggest first; all of them when nothing covers it", () => {
  const holders = [h("A", 2), h("B", 1), h("C", 0.5)];
  expect(inTheWay(holders, 1.5e9).map((o) => o.label)).toEqual(["A"]);
  expect(inTheWay(holders, 2.5e9).map((o) => o.label)).toEqual(["A", "B"]);
  expect(inTheWay(holders, 9e9).map((o) => o.label)).toEqual(["A", "B", "C"]);
});
