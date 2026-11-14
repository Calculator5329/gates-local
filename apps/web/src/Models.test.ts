// Settings › Models rendered to static markup over a stubbed store, on a
// computer with no supported GPU: every model is planned in system memory, so
// nothing on either tab, tooltips included, may promise a GPU.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ state: undefined as unknown }));
vi.mock("./store.ts", () => ({
  NA: "na",
  useStore: (fn: (s: unknown) => unknown) => fn(store.state),
  setState: () => undefined,
}));
vi.mock("./session.ts", () => Object.fromEntries(["leaveSettings", "pull", "cancelPull", "updateSettings", "removeModel"].map((name) => [name, () => undefined])));
vi.mock("./FitPanel.tsx", () => ({ shortGpu: (name: string) => name }));

const { ModelsPage } = await import("./Models.tsx");

const GIB = 1024 ** 3;
const fit = (model: string, verdict: "spills" | "refuse", needGb: number) => ({
  model,
  numCtx: 16384,
  freeVramBytes: 0,
  needVramBytes: needGb * GIB,
  spillRamBytes: verdict === "spills" ? needGb * GIB : 0,
  verdict,
  source: "estimate",
  measuredAt: 0,
});
/** A fit table of these reports, from one reading. */
const tableOf = (...reports: readonly object[]) => ({
  reading: { boot: "b", seq: 1, measuredAt: 0 },
  memory: { kind: "cpu" },
  rows: reports.map((r) => ({ ...r, stops: [] })),
});
const installed = (name: string) => ({ name, digest: name, sizeBytes: 5 * GIB, modifiedAt: "", capabilities: ["completion"] });
const entry = (name: string, label: string, verdict: "spills" | "refuse", needGb: number) => ({
  name,
  label,
  purpose: "General chat",
  recommended: true,
  installed: false,
  downloadBytes: 5 * GIB,
  fit: fit(name, verdict, needGb),
});
const catalog = [entry("qwen3.5:4b", "Qwen 3.5 4B", "spills", 6), entry("huge:1t", "Huge", "refuse", 900)];
const noGpuComputer = (over: object) => ({
  gpu: { vendor: "none" },
  models: [installed("qwen3.5:4b"), installed("huge:1t")],
  catalog,
  fitTable: tableOf(fit("qwen3.5:4b", "spills", 6), fit("huge:1t", "refuse", 900)),
  numCtx: 16384,
  pulls: {},
  unavailable: {},
  settings: { defaultModel: "qwen3.5:4b" },
  addPage: false,
  ...over,
});
const render = (state: object) => {
  // the store's own empty run table (store.ts), which the Measure cells read
  store.state = { measuring: {}, ...state };
  return renderToStaticMarkup(createElement(ModelsPage));
};
/** Every mention of a GPU left once the page's own "no supported GPU" is set aside, with its surroundings. */
// The group title, with or without its explaining tooltip around the word.
const RECOMMENDED = /class="grp-t">(?:<span[^>]*>)?Recommended</;
/** An installed row's Fit cell: a placeholder inside it, or a word. */
const fitCell = (html: string) => html.match(/<span class="mp-fit(?: [^"]*)?"[^>]*>[\s\S]*?<\/span><\/span>|<span class="mp-fit(?: [^"]*)?"[^>]*>[^<]*<\/span>/)?.[0] ?? "";
const gpuPromises =(html: string) => html.replace(/no supported GPU/gi, "").match(/.{0,40}GPU.{0,40}/g) ?? [];

describe("Models on a computer with no supported GPU", () => {
  it("PL-01: catalog-only downloads wait for the fit table, never grouped or worded from the catalog's own estimate", () => {
    // Before the table the groups' placeholder stands where both groups will be (docs/design.md);
    // the catalog's estimate says "spills" and must not leak through as a verdict.
    const offered = entry("qwen3.5:4b", "Qwen 3.5 4B", "spills", 6);
    const pending = render(noGpuComputer({ models: [], addPage: true, fitTable: undefined, catalog: [offered] }));
    expect(pending).toContain('aria-busy="true"');
    expect(pending).toContain("data-skel");
    expect(pending).not.toContain('class="vl spill"');
    expect(pending).not.toMatch(RECOMMENDED);
    expect(pending).not.toContain("Also available · uses system memory");
    const refused = render(noGpuComputer({ models: [], addPage: true, catalog: [entry("huge:1t", "Huge", "refuse", 900)] }));
    expect(refused).not.toMatch(RECOMMENDED);
    const checked = render(noGpuComputer({ models: [], addPage: true, catalog: [offered] }));
    // decision 11: the mark's colour and number say it; no line above the list, no words on the row
    expect(checked).not.toContain("No supported GPU, so these run");
    expect(checked).toContain('class="mm spill"');
    expect(checked).not.toContain('class="vl spill"');
    expect(checked).toMatch(RECOMMENDED);
    expect(checked).not.toContain("data-skel");
  });

  it("PL-01: an installed model's fit waits on a placeholder before the table, and says – when the table has no reading for it", () => {
    const pending = fitCell(render(noGpuComputer({ models: [installed("qwen3.5:4b")], fitTable: undefined })));
    expect(pending).toContain('aria-busy="true"');
    expect(pending).toContain("data-skel");
    const none = fitCell(render(noGpuComputer({ models: [installed("qwen3.5:4b")], fitTable: tableOf() })));
    expect(none).toContain("–");
    expect(none).not.toContain("data-skel");
  });

  it("with nothing installed, the suggested download is the one the table says runs here, not the catalog's own estimate", () => {
    // the catalog estimated Qwen spills and Huge refuses; the table's reading says the opposite
    const html = render(noGpuComputer({ models: [], fitTable: tableOf(fit("qwen3.5:4b", "refuse", 6), fit("huge:1t", "spills", 9)) }));
    expect(html).toContain("We suggest <b>Huge</b>");
    expect(html).not.toContain("We suggest <b>Qwen 3.5 4B</b>");
  });

  it("PL-01: embedding models have no chat-fit advice, not even a skeleton", () => {
    const html = render(noGpuComputer({ models: [{ ...installed("embed:latest"), capabilities: ["embedding"] }], catalog: [], fitTable: undefined }));
    expect(html).toContain("Embedding model, not for chat");
    expect(html).not.toMatch(/Checking|data-skel/);
  });
  it("catalog hydration replaces the raw name consistently on the row and its More control", () => {
    const early = render(noGpuComputer({ catalog: undefined }));
    const label = early.match(/class="mp-row[^>]+aria-label="([^"]+)"/)?.[1];
    expect(label).toBe("Qwen 3.5 4B");
    const html = render(noGpuComputer({ catalog: catalog.map(c => ({ ...c, label: c.name === "qwen3.5:4b" ? "Everyday Qwen" : c.label })) }));
    expect(html).not.toContain(`aria-label="More for ${label}"`);
    expect(html).toMatch(/class="mp-row[^>]+aria-label="Everyday Qwen"/);
    expect(html).toContain('aria-label="More for Everyday Qwen"');
  });
  it("PK-02: a loaded current-context report gives the row its measured need", () => {
    const name = "qwen3:14b";
    const measured = { ...fit(name, "spills", 9), source: "measured", numCtx: 65536 };
    const html = render(noGpuComputer({ addPage: true, numCtx: 65536,
      catalog: [entry(name, "Qwen 3 14B", "spills", 10)], fitTable: tableOf(measured) }));
    // the mark says the table's 9 GB, not the catalog's 10 (a row has no tooltip, decision 19)
    expect(html).toContain('aria-label="Runs in system memory, slower: 9.0 GB"');
    expect(html).not.toMatch(/Measured 9\.0(?:&#160;| | )GB of memory with 64k of context/);
    expect(html).not.toContain("Measured after the first load");
  });
  it("PK-02: Download uses the viewed 64k fit instead of the saved-default 16k estimate", () => {
    const name = "qwen3:14b";
    const at16 = { ...fit(name, "spills", 10), verdict: "fits", freeVramBytes: 12 * GIB, spillRamBytes: 0 };
    const at64 = { ...fit(name, "spills", 15), numCtx: 65536, freeVramBytes: 12 * GIB, spillRamBytes: 3 * GIB };
    const html = render(noGpuComputer({ addPage: true, gpu: { vendor: "nvidia", name: "Test GPU" }, numCtx: 65536,
      catalog: [{ ...entry(name, "Qwen 3 14B", "spills", 10), fit: at16 }],
      fitTable: tableOf(at64) }));
    // the only row spills: its mark says so in amber with the 64k need (decision 11), nothing above the list
    expect(html).toContain('aria-label="Partly in system memory, slower: 15 GB"');
    expect(html).not.toContain("These are bigger than your GPU");
    expect(html).not.toMatch(/Estimated 15\.0(?:&#160;| | )GB of memory with 64k of context/);
    expect(html).not.toContain("Runs on GPU");
  });
  it("promises no GPU on either tab or with no models, and says system memory instead", () => {
    const list = render(noGpuComputer({}));
    const download = render(noGpuComputer({ addPage: true }));
    const empty = render(noGpuComputer({ models: [] }));
    expect([...gpuPromises(list), ...gpuPromises(download), ...gpuPromises(empty)]).toEqual([]);
    // decision 10: no Default card; the chip marks the default
    expect(list).not.toContain("New chats start on this model");
    expect(list).toContain("Should run in system memory");
    expect(list).not.toContain("run slower");
    // the Download rows say it by their marks' names alone (decisions 11 and 19)
    expect(download).toContain('aria-label="Runs in system memory, slower: ');
    expect(empty).toContain("should run in system memory on this computer");
    expect(empty).toContain("Download Qwen 3.5 4B");
  });
});

describe("the Default card when the saved default cannot run", () => {
  it("names the model new chats really start on, beside the preference", () => {
    const html = render(
      noGpuComputer({
        gpu: { vendor: "nvidia", name: "Test GPU" },
        models: [installed("huge:1t"), { ...installed("qwen3.5:4b"), pick: { numCtx: 16384 } }],
        settings: { defaultModel: "huge:1t" },
      }),
    );
    expect(html.replace(/<[^>]+>/g, "")).toContain("Huge won&#x27;t run here, so new chats start on Qwen 3.5 4B.");
  });

  it("says nothing extra when the saved default is the one new chats start on", () => {
    const html = render(noGpuComputer({ models: [{ ...installed("qwen3.5:4b"), pick: { numCtx: 16384 } }, installed("huge:1t")] }));
    expect(html.replace(/<[^>]+>/g, "")).not.toContain("so new chats start on");
  });
});

describe("Models with a model whose window is smaller than the default", () => {
  it("shows it as usable, judged at the size it runs at, with no too-small label", () => {
    const tag = "tiny-chat:2k";
    // the server answers a 16k check at the most the model takes
    const report = { ...fit(tag, "spills", 1), verdict: "fits", numCtx: 2048, spillRamBytes: 0 };
    const html = render(
      noGpuComputer({
        gpu: { vendor: "nvidia", name: "Test GPU" },
        models: [{ ...installed(tag), maxContext: 2048 }],
        catalog: [],
        fitTable: tableOf(report),
        settings: { defaultModel: tag },
      }),
    );
    expect(html).toContain("Should run well");
    expect(html).not.toMatch(/supports up to|too small|unsupported|won.{1,6}t run/i);
    // the Default card that said "can only run at 2k" is gone (decision 10); the picker caps the size per model
    expect(html).not.toContain("run at 16k");
  });
});
