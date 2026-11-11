import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ state: undefined as unknown }));
vi.mock("./store.ts", () => ({ NA: "na", chatReady: () => true, useStore: (fn: (s: unknown) => unknown) => fn(mock.state), getState: () => mock.state, setState: () => undefined, streamingHere: () => false }));
vi.mock("./session.ts", () => Object.fromEntries(["pickModel", "pull", "openSettings", "setContext", "firstPull", "queueReason"].map(name => [name, () => undefined])));
const { Picker, ContextMemory } = await import("./Picker.tsx");

/** The picker for one installed model; `tabled`: the first fit table has arrived. */
function markup(tabled = true) {
  const tag = "milo-e4b-v4:latest", gib = 1024 ** 3;
  const row = { model: tag, numCtx: 16384, freeVramBytes: 12.06 * gib, needVramBytes: 6.87 * gib, spillRamBytes: 0, verdict: "fits", source: "estimate", stops: [] };
  mock.state = {
    pop: { id: "picker", kb: true, ready: true }, unavailable: {}, numCtx: 16384, model: tag,
    models: [{ name: tag, digest: "test", sizeBytes: 5.37 * gib, modifiedAt: "", capabilities: ["completion", "thinking"], maxContext: 131072 }],
    catalog: [{ name: tag, label: "milo-e4b-v4", purpose: "Installed by you", installed: true, downloadBytes: 5.37 * gib, recommended: false }],
    fitTable: tabled ? { reading: { boot: "b", seq: 1, measuredAt: 0 }, memory: { kind: "gpu", freeBytes: 12.06 * gib, usableBytes: 12.06 * gib }, rows: [row] } : undefined,
    pulls: {}, loads: {}, gpu: { vendor: "nvidia", freeVramBytes: 12.06 * gib }, settings: {},
  };
  return renderToStaticMarkup(createElement(Picker));
}
describe("approved model picker", () => {
  it("before the first table every fit value is a skeleton, with no Fits, tint or settled tooltip", () => {
    const html = markup(false);
    const context = html.match(/<button[^>]*data-ctx="16384"[\s\S]*?<\/button>/)?.[0];
    expect(context).toBeDefined();
    expect(context).toMatch(/class="pk-cost"><span class="skel fit-skel" data-skel="" aria-hidden="true"/);
    expect(context).toContain('aria-busy="true"');
    expect(context).not.toContain("Fits");
    expect(html).toContain("fit-skel");
    expect(html).not.toContain('class="pk-v gpu"');
    expect(html).not.toMatch(/fits on (?:the )?GPU/);
  });
  it("shows a CPU cost without a fictional GPU scale", () => {
    const v = { k: "spill" as const, chip: "system memory", word: "Uses system memory", detail: "", amt: 7 * 1024 ** 3, need: 7 * 1024 ** 3, avail: 0, measured: false };
    const html = renderToStaticMarkup(createElement(ContextMemory, { v, cpu: true }));
    expect(html).toContain("System memory");
    expect(html).not.toContain('class="pk-cost-track"');
  });
  it("keeps a CPU refusal explicit", () => {
    const v = { k: "no" as const, chip: "not enough memory", word: "Not enough memory", detail: "", amt: 2 * 1024 ** 3, need: 7 * 1024 ** 3, avail: 0, measured: false };
    const refused = renderToStaticMarkup(createElement(ContextMemory, { v, cpu: true }));
    expect(refused).toContain("Too big");
  });
  it("does not count a loaded model's own GPU allocation as overflow against the remaining free memory", () => {
    const gib = 1024 ** 3;
    const v = { k: "gpu" as const, chip: "on GPU", word: "Runs on GPU", detail: "", amt: 0, need: 7 * gib, avail: 2 * gib, measured: true };
    const html = renderToStaticMarkup(createElement(ContextMemory, { v, cpu: false }));
    expect(html).not.toContain('class="pk-cost-over"');
    expect(html).toContain("measured; Fits");
  });
  it("offers a Context length column and an actual Download models control", () => {
    const html = markup();
    // the size group is named for its model; the wide header itself is just "Context length"
    expect(html).toMatch(/role="radiogroup" aria-label="Context length for [^"]+"/);
    expect(/<header class="pk-context-head">.*?<\/header>/.exec(html)?.[0]).not.toContain("<small");
    expect(html).toContain("Download models");
  });
  it("shows a clean name and estimated memory need instead of disk size as its row metric", () => {
    const html = markup();
    expect(html).toContain("Milo E4B v4");
    const row = html.slice(html.indexOf('data-m="milo-e4b-v4:latest"'));
    const metric = /class="pk-v[^"]*">([^<]+)/.exec(row)?.[1];
    expect(metric).toMatch(/^6\.9(?:&#160;| | )GB$/);
  });
});
