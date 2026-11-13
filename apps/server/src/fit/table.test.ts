// The fit table. The first two tests are the owner's picker, 2026-11-11: a 26B model loaded at 16k
// partly in system memory. Ollama's /api/ps answered with the GPU part plus a little (the CPU side of
// the weights is mapped from disk and not counted), and the row for the loaded context showed that
// beside estimates of the whole model, each context from its own GPU reading.
import { readFileSync } from "node:fs";
import type { FitTable } from "@gates-local/contracts";
import { afterEach, expect, it } from "vitest";
import { MIB } from "./constants.ts";
import { json, startFakeServer, type FakeServer } from "./fake-http.ts";
import { createGpuBaseline } from "./baseline.ts";
import { planLoad } from "./fit.ts";
import { createFitTable, TABLE_CONTEXTS, type FitTableDeps, type TableModel } from "./table.ts";
import type { NvidiaSmiRunner } from "./types.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const GEMMA = "gemma4-abliterated:26b";
const WEIGHTS = 17990843601;
const SHOW = JSON.parse(fixture("show-gemma4-abliterated-26b.json")) as unknown;
/** What the owner's Ollama said for the copy loaded at 16k: 11.0 GB on the GPU, 11.3 GB in all. */
const SPILLED = { name: GEMMA, model: GEMMA, size: 11.3e9, size_vram: 11.0e9, context_length: 16384 };
const MEMINFO = async () => "MemAvailable: 30000000 kB\n";
const INSTALLED: TableModel[] = [{ name: GEMMA, downloadBytes: WEIGHTS, installed: true }];

let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A fake Ollama with GEMMA installed and `ps` resident; `hold` delays /api/ps until it resolves. */
async function ollama(ps: { models: unknown[] }, hold?: () => Promise<void>): Promise<FakeServer> {
  server = await startFakeServer({
    "GET /api/tags": (_b, res) => json(res, 200, { models: [{ name: GEMMA, size: WEIGHTS, digest: "b" }] }),
    "GET /api/ps": async (_b, res) => {
      await hold?.();
      json(res, 200, ps);
    },
    "POST /api/show": (_b, res) => json(res, 200, SHOW),
  });
  return server;
}

/** A 16303 MiB card: whisper, another app and a runner holding `runnerMib`; counts its totals reads. */
function card(runnerMib = Math.round(11.0e9 / MIB)): NvidiaSmiRunner & { totals: number } {
  const used = 2202 + 1822 + runnerMib + 300;
  const run = async (args: readonly string[]) => {
    if (args[0]?.startsWith("--query-gpu")) {
      run.totals++;
      return `16303, ${used}, ${16303 - used}\n`;
    }
    const runner = runnerMib > 0 ? `5800, /usr/bin/ollama, ${runnerMib}\n` : "";
    return `5100, /usr/bin/whisper-server, 2202\n5400, /opt/media-vault/vision-runtime/bin/python, 1822\n${runner}`;
  };
  run.totals = 0;
  return run;
}

function table(s: FakeServer, smi: NvidiaSmiRunner, deps: Partial<FitTableDeps> = {}) {
  const pushed: FitTable[] = [];
  let clock = 1_000;
  const t = createFitTable({
    baseUrl: () => s.baseUrl,
    fit: { runNvidiaSmi: smi, readMeminfo: MEMINFO, now: () => clock++ },
    models: async () => INSTALLED,
    busy: () => [],
    comfyPid: () => undefined,
    push: (x) => pushed.push(x),
    boot: "boot-1",
    ...deps,
  });
  return { t, pushed };
}

const needs = (t: FitTable, model = GEMMA) => t.rows.filter((r) => r.model === model).map((r) => r.needVramBytes);
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

it("every context of one model is stated on one basis: a larger context never needs less", async () => {
  const s = await ollama({ models: [SPILLED] });
  const { t } = table(s, card());
  const got = await t.get();
  const gb = needs(got).map((n) => (n / 1e9).toFixed(1));
  expect(got.rows.map((r) => r.numCtx)).toEqual([...TABLE_CONTEXTS]);
  for (let i = 1; i < gb.length; i++) expect(needs(got)[i], `needs by context ${gb.join(", ")} GB`).toBeGreaterThanOrEqual(needs(got)[i - 1] ?? 0);
  // The copy loaded at 16k runs as it is, partly in system memory: never "does not fit".
  expect(got.rows.find((r) => r.numCtx === 16384)).toMatchObject({ verdict: "spills", source: "estimate", stops: [] });
});

it("one table is one GPU reading: one nvidia-smi and one /api/ps read, the footer's line from it", async () => {
  const s = await ollama({ models: [SPILLED] });
  const smi = card();
  const { t } = table(s, smi);
  const got = await t.get();
  expect({ nvidiaSmiTotals: smi.totals, ps: s.requests.filter((q) => q.path === "/api/ps").length }).toEqual({ nvidiaSmiTotals: 1, ps: 1 });
  const free = (16303 - (2202 + 1822 + Math.round(11.0e9 / MIB) + 300)) * MIB;
  expect(got.memory).toEqual({ kind: "gpu", freeBytes: free, usableBytes: free - 512 * MIB });
  expect(got.reading).toEqual({ boot: "boot-1", seq: 1, measuredAt: 1_000 });
});

it("a copy wholly on the GPU replaces the estimate with its measurement; a partial one does not", async () => {
  // 18.0 GB of weights do not fit a 16 GB card, so the wholly-on-GPU case uses a small model.
  const whole = { ...SPILLED, size: 9e9, size_vram: 9e9 };
  const s = await ollama({ models: [whole] });
  const { t } = table(s, card(Math.round(9.4e9 / MIB)), { models: async () => [{ name: GEMMA, downloadBytes: 8e9, installed: true }] });
  const row = (await t.get()).rows.find((r) => r.numCtx === 16384);
  // The tags say 18 GB of weights, more than the 9.4 GB the copy holds: not the same thing, so estimated.
  expect(row?.source).toBe("estimate");
  await s.close();

  server = await startFakeServer({
    "GET /api/tags": (_b, res) => json(res, 200, { models: [{ name: GEMMA, size: 8e9, digest: "b" }] }),
    "GET /api/ps": (_b, res) => json(res, 200, { models: [whole] }),
    "POST /api/show": (_b, res) => json(res, 200, SHOW),
  });
  const measured = table(server, card(Math.round(9.4e9 / MIB)));
  const at16 = (await measured.t.get()).rows.find((r) => r.numCtx === 16384);
  expect(at16).toMatchObject({ source: "measured", verdict: "fits", needVramBytes: Math.round(9.4e9 / MIB) * MIB });
});

it("builds never overlap: triggers during a build make one more, and pushed tables rise in seq", async () => {
  let release!: () => void;
  let gate: Promise<void> | undefined = new Promise((resolve) => (release = resolve));
  const s = await ollama({ models: [SPILLED] }, () => gate ?? Promise.resolve());
  let runnerMib = Math.round(11.0e9 / MIB);
  // Each reading differs, so every build is pushed.
  const changing: NvidiaSmiRunner = async (args) => {
    runnerMib += 100;
    return card(runnerMib)(args);
  };
  const { t, pushed } = table(s, changing);
  t.changed();
  t.changed();
  t.changed();
  await settled();
  gate = undefined;
  release();
  await settled();
  await settled();
  expect(pushed.map((x) => x.reading.seq)).toEqual([1, 2]);
});

it("each trigger builds once; a trigger during a load waits for the load to end", async () => {
  const s = await ollama({ models: [SPILLED] });
  const smi = card();
  const { t } = table(s, smi);
  t.changed();
  await settled();
  expect(smi.totals).toBe(1);
  t.load({ model: GEMMA, numCtx: 32768, state: "loading" });
  t.changed();
  t.changed();
  await settled();
  expect(smi.totals, "no table while a load is half counted").toBe(1);
  t.load({ model: GEMMA, numCtx: 32768, state: "ready" });
  await settled();
  expect(smi.totals, "the load's end builds once").toBe(2);
  // An unload the app did not start (no open load) builds once too.
  t.load({ model: GEMMA, numCtx: 32768, state: "unloaded" });
  await settled();
  expect(smi.totals).toBe(3);
});

it("a build a send asks for right after its plan takes the plan's GPU reading; any other trigger reads again (chat row 33)", async () => {
  const s = await ollama({ models: [SPILLED] });
  const smi = card();
  const { t } = table(s, smi);
  // the send's plan
  await planLoad({ baseUrl: s.baseUrl, model: GEMMA, numCtx: 16384, runNvidiaSmi: smi, readMeminfo: MEMINFO, busy: [] });
  expect(smi.totals).toBe(1);
  t.changed({ afterPlan: true });
  await settled();
  expect(smi.totals, "the table took the plan's reading").toBe(1);
  t.changed();
  await settled();
  expect(smi.totals, "a plain trigger reads again").toBe(2);
});

it("triggers during a build: one plain trigger among a send's makes the next build read again (chat row 33)", async () => {
  let release: (() => void) | undefined;
  const s = await ollama({ models: [SPILLED] }, () => new Promise<void>((resolve) => { release = resolve; }));
  const smi = card();
  const { t } = table(s, smi);
  t.changed();
  await settled();
  expect(smi.totals).toBe(1);
  // the build waits on /api/ps; a plain trigger, then a send's, arrive meanwhile
  t.changed();
  t.changed({ afterPlan: true });
  release?.();
  await settled();
  release?.();
  await settled();
  expect(smi.totals).toBe(2);
});

it("a table equal to the last one pushed is not pushed again, but fit.table answers the newest", async () => {
  const s = await ollama({ models: [SPILLED] });
  const { t, pushed } = table(s, card());
  t.changed();
  await settled();
  t.changed();
  await settled();
  expect(pushed.map((x) => x.reading.seq)).toEqual([1]);
  expect((await t.get()).reading.seq).toBe(2);
});

it("a table whose rows match the last but whose memory line moved is pushed", async () => {
  // No models: every table has no rows, so only the footer's memory line tells two apart.
  const s = await ollama({ models: [] });
  let runnerMib = 0;
  const moving: NvidiaSmiRunner = async (args) => card(runnerMib)(args);
  const { t, pushed } = table(s, moving, { models: async () => [] });
  t.changed();
  await settled();
  runnerMib = 2000;
  t.changed();
  await settled();
  expect(pushed.map((x) => x.memory)).toHaveLength(2);
});

it("a build that started before a load opened is not pushed; the load's end pushes one table", async () => {
  let release!: () => void;
  let gate: Promise<void> | undefined = new Promise((resolve) => (release = resolve));
  const s = await ollama({ models: [SPILLED] }, () => gate ?? Promise.resolve());
  const { t, pushed } = table(s, card());
  t.changed();
  await settled();
  // The build is waiting on /api/ps when the load opens: GPU memory is filling under it.
  t.load({ model: GEMMA, numCtx: 32768, state: "loading" });
  gate = undefined;
  release();
  await settled();
  await settled();
  expect(pushed, "a table read while a load fills GPU memory").toEqual([]);
  t.load({ model: GEMMA, numCtx: 32768, state: "ready" });
  await settled();
  await settled();
  expect(pushed.map((x) => x.reading.seq)).toEqual([2]);
});

it("a model offered for download gets the pre-download estimate at every context, from the same reading", async () => {
  const s = await ollama({ models: [] });
  const smi = card(0);
  const { t } = table(s, smi, { models: async () => [...INSTALLED, { name: "gpt-oss:20b", downloadBytes: 13_793_441_566, installed: false }] });
  const got = await t.get();
  const offered = got.rows.filter((r) => r.model === "gpt-oss:20b");
  expect(offered.map((r) => r.numCtx)).toEqual([...TABLE_CONTEXTS]);
  expect(offered.every((r) => r.source === "estimate" && /before download/.test(r.message ?? ""))).toBe(true);
  for (let i = 1; i < offered.length; i++) expect(offered[i]!.needVramBytes).toBeGreaterThan(offered[i - 1]!.needVramBytes);
  expect(smi.totals).toBe(1);
});

it("a row names the busy chat a send stops first only when stopping it makes room", async () => {
  const OTHER = "qwen3.8-abliterated:27b";
  const otherMib = Math.round(12e9 / MIB);
  const s = await ollama({ models: [{ name: OTHER, model: OTHER, size: 12e9, size_vram: 12e9, context_length: 16384 }] });
  const busy = await table(s, card(otherMib), { busy: () => [OTHER] }).t.get();
  const idle = await table(s, card(otherMib), { busy: () => [] }).t.get();
  expect(busy.rows.some((r) => r.stops.includes(OTHER)), JSON.stringify(busy.rows.map((r) => [r.numCtx, r.verdict, r.stops]))).toBe(true);
  expect(busy.rows.every((r) => r.stops.length === 0 || r.stops.join() === OTHER)).toBe(true);
  expect(idle.rows.every((r) => r.stops.length === 0)).toBe(true);
});

const at8k = (x: FitTable, model: string) => x.rows.find((r) => r.model === model && r.numCtx === 8192);

// Settings row 10 and its addendum, 2026-11-13: another program holding 9.7 GB made every model
// look worse. The owner's ruling: a model is measured against the card's own memory; what other
// programs hold right now is shown, never the verdict. Only a send (and the composer) judge right now.
it("a model is judged against the card's own memory; a send is judged right now", async () => {
  const blenderMib = Math.round(9.7 * 1024);
  /** The card as card(0), plus `/usr/bin/blender` holding blenderMib when it is running. */
  const smi = (blender: boolean): NvidiaSmiRunner => async (args) => {
    const used = 2202 + 1822 + 300 + (blender ? blenderMib : 0);
    if (args[0]?.startsWith("--query-gpu")) return `16303, ${used}, ${16303 - used}\n`;
    return `5100, /usr/bin/whisper-server, 2202\n5400, /opt/media-vault/vision-runtime/bin/python, 1822\n${blender ? `6100, /usr/bin/blender, ${blenderMib}\n` : ""}`;
  };
  // The same 8 GB of weights twice: installed, and offered for download under another name.
  const OFFERED = "gemma4:26b-offered";
  server = await startFakeServer({
    "GET /api/tags": (_b, res) => json(res, 200, { models: [{ name: GEMMA, size: 8e9, digest: "b" }] }),
    "GET /api/ps": (_b, res) => json(res, 200, { models: [] }),
    "POST /api/show": (_b, res) => json(res, 200, SHOW),
  });
  const s = server;
  const baseline = createGpuBaseline();
  let blender = false;
  const run: NvidiaSmiRunner = (args, signal) => smi(blender)(args, signal);
  const fit = { runNvidiaSmi: run, readMeminfo: MEMINFO, baseline };
  const models = async (): Promise<TableModel[]> => [
    { name: GEMMA, downloadBytes: 8e9, installed: true },
    { name: OFFERED, downloadBytes: 8e9, installed: false },
  ];
  const t = createFitTable({ baseUrl: () => s.baseUrl, fit, models, busy: () => [], comfyPid: () => undefined, push: () => {}, boot: "b" });
  const send = async () => (await planLoad({ ...fit, baseUrl: s.baseUrl, model: GEMMA, numCtx: 8192, busy: [] })).report;

  const idle = await t.get();
  const idleSend = await send();
  expect([at8k(idle, GEMMA)?.verdict, at8k(idle, OFFERED)?.verdict, idleSend.verdict], "with the card idle all three fit").toEqual(["fits", "fits", "fits"]);
  expect(idle.memory).not.toHaveProperty("others");

  blender = true;
  t.changed();
  await settled();
  const busy = await t.get();
  const busySend = await send();
  // The card's own memory, whisper and the other always-on programs included: a download row and an
  // installed row's card verdict read it, loaded or not; the installed row itself is a send's plan.
  const onCard = { verdict: "fits", freeVramBytes: 16303 * MIB };
  expect(at8k(idle, OFFERED)).toMatchObject(onCard);
  expect(at8k(busy, OFFERED)).toMatchObject(onCard);
  expect(at8k(idle, GEMMA)?.card).toMatchObject(onCard);
  expect(at8k(busy, GEMMA)?.card).toMatchObject(onCard);
  expect(at8k(busy, GEMMA)?.verdict, "an installed model's plan right now").not.toBe("fits");
  expect(busySend.verdict, "a send").not.toBe("fits");
  expect(busySend.freeVramBytes).toBe((16303 - 2202 - 1822 - 300 - blenderMib) * MIB);
  // The list's one line names who holds the memory, and how much.
  expect(busy.memory).toMatchObject({ kind: "gpu", freeBytes: busySend.freeVramBytes, others: { programs: ["blender"], bytes: blenderMib * MIB } });
});

it("with no runtime there are no rows, and the footer's line still reads the GPU", async () => {
  const s = await ollama({ models: [] });
  const { t } = table(s, card(0), { baseUrl: () => undefined });
  const got = await t.get();
  expect(got.rows).toEqual([]);
  expect(got.memory.kind).toBe("gpu");
});
