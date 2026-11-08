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
  settings: {},
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
});

describe("first run on a computer with no supported GPU", () => {
  for (const verdict of ["fits", "spills", "refuse"] as const) {
    it(`never promises a GPU when the pick ${verdict}`, () => {
      const t = text(cpuOnly(verdict));
      expect(t).not.toMatch(/your GPU|GPU fit/);
      expect(t).toContain(verdict === "refuse" ? "No model fits in memory" : "This computer has no supported GPU, so models run in system memory");
      // the tooltip is an attribute, which text() strips (W1-03)
      expect(raw(cpuOnly(verdict))).not.toContain("fits your GPU");
    });
  }
});
