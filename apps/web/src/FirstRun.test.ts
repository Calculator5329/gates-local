// The first run rendered to static markup over a stubbed store (MP3-02): an
// Ollama that does not report capabilities gets the update line and Retry,
// never a download that would be as undescribed as what is installed.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ state: undefined as unknown }));
vi.mock("./store.ts", () => ({ NA: "na", useStore: (fn: (s: unknown) => unknown) => fn(store.state) }));
vi.mock("./session.ts", () =>
  Object.fromEntries(["finishFirstRun", "firstPull", "openSettings", "pull", "cancelPull", "recheckRuntime"].map((name) => [name, () => undefined])),
);
vi.mock("./Sidebar.tsx", () => ({ focusComposer: () => undefined }));
vi.mock("./Settings.tsx", () => ({ DlDetail: () => null }));
vi.mock("./ui.tsx", () => ({ VLabel: () => null }));

const { FirstRun } = await import("./FirstRun.tsx");

const gemma = { name: "gemma4:12b", label: "Gemma", recommended: true, downloadBytes: 100, purpose: "chat", installed: false };
const text = (state: unknown) => {
  store.state = state;
  return renderToStaticMarkup(createElement(FirstRun))
    .replaceAll(/<[^>]*>/g, " ")
    .replaceAll("&#x27;", "'")
    .replaceAll(/\s+/g, " ");
};
const raw = (state: unknown) => {
  store.state = state;
  return renderToStaticMarkup(createElement(FirstRun));
};
const oldOllama = (catalog: unknown[], version?: string) => ({
  conn: { kind: "open" },
  runtime: { state: "ready", owner: "external", ...(version === undefined ? {} : { version }) },
  models: [{ name: "qwen3.5:9b", digest: "q", sizeBytes: 1, modifiedAt: "", capabilities: ["unknown", "unreported"] }],
  catalog,
  numCtx: 16384,
  pulls: {},
  unavailable: {},
  fitTable: undefined,
  settings: {},
});
/** A fit table of these rows, from one reading. */
const tableOf = (rows: readonly object[]) => ({
  reading: { boot: "b", seq: 1, measuredAt: 0 },
  memory: { kind: "gpu", freeBytes: 0, usableBytes: 0 },
  rows: rows.map((r) => ({ stops: [], ...r })),
});
const row = (model: string, verdict: string) => ({ model, numCtx: 16384, verdict, needVramBytes: 1, freeVramBytes: 0, spillRamBytes: 1, source: "estimate" });

describe("first run on a phone, where downloads and installs belong to the computer", () => {
  const phone = { ...oldOllama([]), models: [], unavailable: { "models.pull": true } };

  it("titles the screen for what is true and keeps the way to get a model", () => {
    const t = text(phone);
    expect(t).toContain("No model installed yet");
    expect(t).not.toContain("Download your first model");
    expect(t).toContain("Gates Local can't download models from here. On the computer, download one with Ollama");
    expect(t).toContain("Retry");
  });

  it("does not call a computer-only install missing from this build", () => {
    const t = text({ ...phone, runtime: { state: "missing", owner: "none" }, unavailable: { "models.pull": true, "runtime.retry": true } });
    expect(t).not.toContain("not available in this build");
    expect(t).toContain("Gates Local can't install Ollama from here. On the computer, install it from ollama.com, then press Retry.");
  });

  it("says an Ollama error needs the computer, and keeps the reason", () => {
    const failed = { state: "error", owner: "app", detail: "The download's checksum did not match." } as const;
    const t = text({ ...phone, runtime: failed, unavailable: { "models.pull": true, "runtime.retry": true } });
    expect(t).toContain("The download's checksum did not match.");
    expect(t).toContain("Gates Local can't fix this from here. On the computer, press Retry in Gates Local.");
    expect(text({ ...phone, runtime: failed, unavailable: {} })).not.toContain("can't fix this from here");
  });

  it("keeps the old sentence where the build really has no installer", () => {
    expect(text({ ...phone, runtime: { state: "missing", owner: "none" }, unavailable: {} })).toContain("not available in this build");
  });
});

describe("first run with an Ollama that does not say which models can chat (MP3-02)", () => {
  for (const [name, catalog] of [
    ["no catalog entry", []],
    ["a recommended download", [gemma]],
  ] as const) {
    it(`shows the update line and Retry, and no download, with ${name}`, () => {
      const t = text(oldOllama([...catalog], "0.1.32"));
      expect(t).not.toContain("ollama pull");
      expect(t).not.toContain("Download and start");
      expect(t).toContain("Retry");
      expect(t).toContain("This Ollama doesn't say which models can chat. Updating Ollama fixes this.");
      expect(t).not.toContain("0.1.32");
    });
  }

  it("words the line the same when the runtime gave no version", () => {
    expect(text(oldOllama([gemma]))).toContain("This Ollama doesn't say which models can chat. Updating Ollama fixes this.");
  });
});

const cpuOnly = (verdict: "fits" | "spills" | "refuse") => ({
  ...oldOllama([]),
  runtime: { state: "ready", owner: "external", version: "0.40.15" },
  models: [{ name: "qwen3.5:4b", digest: "q", sizeBytes: 1, modifiedAt: "", capabilities: ["completion"], pick: { numCtx: 16384, verdict } }],
  gpu: { vendor: "none" },
  fitTable: tableOf([row("qwen3.5:4b", verdict)]),
});

describe("first run on a computer with no supported GPU", () => {
  for (const verdict of ["fits", "spills", "refuse"] as const) {
    it(`never promises a GPU when the pick ${verdict}`, () => {
      const t = text(cpuOnly(verdict));
      expect(t).not.toMatch(/your GPU|GPU fit/);
      expect(t).toContain(verdict === "refuse" ? "Qwen 3.5 4B doesn't fit at 16k. A smaller context may fit." : "This computer has no supported GPU, so models run in system memory");
      // the tooltip is an attribute, which text() strips (W1-03)
      expect(raw(cpuOnly(verdict))).not.toContain("fits your GPU");
    });
  }
});

it("SR-03: a recommended download that spills says so on the card's tooltip, never in a line its verdict already gives", () => {
  const fit = { model: gemma.name, numCtx: 16384, verdict: "spills", needVramBytes: 2 ** 30, freeVramBytes: 0, spillRamBytes: 2 ** 30, source: "estimate", measuredAt: 0 };
  const state = { ...oldOllama([{ ...gemma, fit }]), models: [], gpu: { vendor: "nvidia" }, fitTable: tableOf([fit]) };
  expect(text(state)).toContain("Download your first model");
  expect(text(state)).not.toContain("Your best fit uses system memory, so it is slower.");
  expect(raw(state)).toContain('data-tip="Your best fit uses system memory, so it is slower."');
  // the size is what the person decides on; the model's blurb is not
  expect(text(state)).toContain("GB download");
  expect(text(state)).not.toContain(" chat · ");
  expect(raw(state)).not.toContain("runs on your GPU with room");
});

it("SR-07: a selected model's refusal names that model when another installed model fits", () => {
  const selected = cpuOnly("refuse");
  const model = selected.models[0]!;
  const state = {
    ...selected,
    model: model.name,
    gpu: { vendor: "nvidia" },
    models: [model, { ...model, name: gemma.name, pick: { numCtx: 16384, verdict: "fits" } }],
    catalog: [{ ...gemma, name: model.name, label: "Qwen 3.5 4B", installed: true }],
    fitTable: tableOf([row(model.name, "refuse"), row(gemma.name, "fits")]),
  };
  const t = text(state);
  expect(t).toContain("Qwen 3.5 4B doesn't fit at 16k. A smaller context may fit.");
  expect(t).not.toMatch(/None of your models|Download a smaller/);
  expect(t).toContain("Choose a model");
});

for (const have of [false, true]) {
  it(`SR-03: first run says the table's refusal, not ${have ? "the installed pick" : "the catalog's own estimate"}`, () => {
    const name = "qwen3.5:9b";
    const promised = { ...gemma, name, label: "Qwen 3.5 9B", installed: have, fit: row(name, "fits") };
    const state = {
      ...oldOllama([promised], "0.40.15"),
      models: have ? [{ name, digest: "q", sizeBytes: 1, modifiedAt: "", capabilities: ["completion"], pick: { numCtx: 16384, verdict: "fits" } }] : [],
      gpu: { vendor: "nvidia" },
      fitTable: tableOf([row(name, "fits")]),
    };
    expect(text(state)).toContain(have ? "Ready to chat" : "Download your first model");
    // the next table refuses it: the verdict changes in place, the catalog and the pick no longer count
    const t = text({ ...state, fitTable: { ...tableOf([row(name, "refuse")]), reading: { boot: "b", seq: 2, measuredAt: 0 } } });
    expect(t).not.toContain("Ready to chat");
    expect(t).toContain(have ? "doesn't fit at 16k" : "Not enough memory");
  });
}

it("SR-03: the first download offered is a recommended one the table does not refuse, whatever the catalog estimated", () => {
    const first = { ...gemma, name: "big:1", label: "Big One", fit: row("big:1", "fits") };
    const second = { ...gemma, name: "small:1", label: "Small One", fit: row("small:1", "refuse") };
    const state = { ...oldOllama([first, second], "0.40.15"), models: [], gpu: { vendor: "nvidia" }, fitTable: tableOf([row("big:1", "refuse"), row("small:1", "fits")]) };
    const t = text(state);
    expect(t).toContain("Small One");
    expect(t).not.toContain("Big One");
});

it("PL-03: a model the table has no reading for says Couldn't check in the title and the card, never Checking or Ready", () => {
  const name = "qwen3.5:9b";
  const state = {
    ...oldOllama([{ ...gemma, name, label: "Qwen 3.5 9B", installed: true }], "0.40.15"),
    models: [{ name, digest: "q", sizeBytes: 1, modifiedAt: "", capabilities: ["completion"], pick: { numCtx: 16384, verdict: "fits" } }],
    gpu: { vendor: "nvidia" },
    fitTable: tableOf([row("other:1", "fits")]),
  };
  const t = text(state);
  expect(t).toContain("Couldn't check memory");
  expect(t).toContain("Couldn't check");
  expect(t, "no Checking memory over Couldn't check").not.toContain("Checking");
  expect(t).not.toContain("Ready to chat");
  expect(raw(state)).toContain('class="dot warn"');
});

it("F5: a busy port says its cause in the status line, one line and no sentence", () => {
  const state = { ...oldOllama([]), models: [], runtime: { state: "wrong-service", owner: "external", baseUrl: "http://localhost:11434" } };
  const t = text(state);
  expect(t).toContain("Ollama isn't answering");
  // the state also covers a port that did not answer in time, which can be a hung Ollama
  expect(t).toContain("Something else holds port 11434");
  expect(t).not.toContain("Another program");
  expect(t).not.toContain("is busy");
  expect(raw(state)).not.toMatch(/class="(sub|fr-sub)"/);
});

it("Ready to chat is the title, the status line and the card: no sentence under it, no blurb, no footer", () => {
  const state = {
    ...cpuOnly("fits"),
    gpu: { vendor: "nvidia" },
    catalog: [{ ...gemma, name: "qwen3.5:4b", label: "Qwen 3.5 4B", installed: true, purpose: "Careful longer answers" }],
  };
  const t = text(state);
  expect(t).toContain("Ready to chat");
  expect(t).toContain("Ollama · 1 chat model");
  expect(t).toContain("Qwen 3.5 4B");
  expect(t).not.toContain("Switch models in any chat");
  expect(t).not.toContain("Careful longer answers");
  expect(t).not.toContain("Nothing leaves your own network");
  expect(raw(state)).not.toMatch(/class="(sub|fr-sub|fr-foot)"/);
});
