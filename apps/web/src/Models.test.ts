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
  fitKey: (m: string, c: number) => `${m}@${c}`,
  setState: () => undefined,
}));
vi.mock("./session.ts", () => Object.fromEntries(["ensureFit", "leaveSettings", "pull", "cancelPull", "updateSettings", "removeModel"].map((name) => [name, () => undefined])));
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
  fits: { "qwen3.5:4b@16384": fit("qwen3.5:4b", "spills", 6), "huge:1t@16384": fit("huge:1t", "refuse", 900) },
  numCtx: 16384,
  pulls: {},
  unavailable: {},
  settings: { defaultModel: "qwen3.5:4b" },
  addPage: false,
  ...over,
});
const render = (state: object) => {
  store.state = state;
  return renderToStaticMarkup(createElement(ModelsPage));
};
/** Every mention of a GPU left once the page's own "no supported GPU" is set aside, with its surroundings. */
const gpuPromises = (html: string) => html.replaceAll("no supported GPU", "").match(/.{0,40}GPU.{0,40}/g) ?? [];

describe("Models on a computer with no supported GPU", () => {
  it("PK-02: a loaded current-context report is labeled measured", () => {
    const name = "qwen3:14b";
    const measured = { ...fit(name, "spills", 9), source: "measured", numCtx: 65536 };
    const html = render(noGpuComputer({ addPage: true, numCtx: 65536,
      catalog: [entry(name, "Qwen 3 14B", "spills", 10)], fits: { [`${name}@65536`]: measured } }));
    expect(html).toMatch(/measured 9\.0(?:&#160;| | )GB at 64k/);
    expect(html).not.toContain("Measured after the first load");
  });
  it("PK-02: Download uses the viewed 64k fit instead of the saved-default 16k estimate", () => {
    const name = "qwen3:14b";
    const at16 = { ...fit(name, "spills", 10), verdict: "fits", freeVramBytes: 12 * GIB, spillRamBytes: 0 };
    const at64 = { ...fit(name, "spills", 15), numCtx: 65536, freeVramBytes: 12 * GIB, spillRamBytes: 3 * GIB };
    const html = render(noGpuComputer({ addPage: true, gpu: { vendor: "nvidia", name: "Test GPU" }, numCtx: 65536,
      catalog: [{ ...entry(name, "Qwen 3 14B", "spills", 10), fit: at16 }],
      fits: { [`${name}@65536`]: at64 } }));
    expect(html).toContain("Uses system memory · slower");
    expect(html).toMatch(/est\. 15\.0(?:&#160;| | )GB at 64k/);
    expect(html).not.toContain("Runs on GPU");
  });
  it("promises no GPU on either tab or with no models, and says system memory instead", () => {
    const list = render(noGpuComputer({}));
    const download = render(noGpuComputer({ addPage: true }));
    const empty = render(noGpuComputer({ models: [], fits: {} }));
    expect([...gpuPromises(list), ...gpuPromises(download), ...gpuPromises(empty)]).toEqual([]);
    expect(list).toContain(
      "New chats start on this model. If it&#x27;s too big for this computer, they start on the best one that fits. Any chat can switch from its model menu.",
    );
    expect(list).toContain("Runs in system memory");
    expect(list).not.toContain("Runs slower");
    expect(download).toContain("all in system memory (no supported GPU)");
    expect(empty).toContain("runs in system memory on this computer");
    expect(empty).toContain("Download Qwen 3.5 4B");
  });
});

describe("Models with a model whose window is smaller than the default", () => {
  it("shows it as usable, at the size it runs at, with no too-small label", () => {
    const tag = "tiny-chat:2k";
    // the server answers a 16k check at the most the model takes
    const report = { ...fit(tag, "spills", 1), verdict: "fits", numCtx: 2048, spillRamBytes: 0 };
    const html = render(
      noGpuComputer({
        gpu: { vendor: "nvidia", name: "Test GPU" },
        models: [{ ...installed(tag), maxContext: 2048 }],
        catalog: [],
        fits: { [`${tag}@16384`]: report },
        settings: { defaultModel: tag },
      }),
    );
    expect(html).toContain("Runs well");
    expect(html).not.toMatch(/supports up to|too small|unsupported|won.{1,6}t run/i);
    expect(html).toContain("run at 2k");
    expect(html).not.toContain("run at 16k");
  });
});
