// The first run rendered to static markup over a stubbed store (MP3-02): an
// Ollama that does not report capabilities gets the update line and Retry,
// never a download that would be as undescribed as what is installed.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ state: undefined as unknown }));
vi.mock("./store.ts", () => ({ NA: "na", useStore: (fn: (s: unknown) => unknown) => fn(store.state), fitKey: (m: string, c: number) => `${m}@${c}` }));
vi.mock("./session.ts", () =>
  Object.fromEntries(["ensureFit", "finishFirstRun", "firstPull", "openSettings", "pull", "cancelPull", "recheckRuntime"].map((name) => [name, () => undefined])),
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
  fits: {},
  staleFits: {},
  settings: {},
});

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
  fits: { "qwen3.5:4b@16384": { model: "qwen3.5:4b", numCtx: 16384, verdict, needVramBytes: 1, freeVramBytes: 0, spillRamBytes: 1, source: "estimate", measuredAt: 0 } },
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
  const state = { ...oldOllama([{ ...gemma, fit }]), models: [], gpu: { vendor: "nvidia" }, fits: { [`${gemma.name}@16384`]: fit } };
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
    fits: { ...selected.fits, [`${gemma.name}@16384`]: { ...selected.fits["qwen3.5:4b@16384"], model: gemma.name, verdict: "fits" } },
  };
  const t = text(state);
  expect(t).toContain("Qwen 3.5 4B doesn't fit at 16k. A smaller context may fit.");
  expect(t).not.toMatch(/None of your models|Download a smaller/);
  expect(t).toContain("Choose a model");
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
