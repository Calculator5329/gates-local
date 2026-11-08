// The first run rendered to static markup over a stubbed store (MP3-02): an
// Ollama that does not report capabilities gets the update line and Retry,
// never a download that would be as undescribed as what is installed.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ state: undefined as unknown }));
vi.mock("./store.ts", () => ({ NA: "na", useStore: (fn: (s: unknown) => unknown) => fn(store.state), fitKey: (m: string, c: number) => `${m}@${c}` }));
vi.mock("./session.ts", () => {
  const noop = () => undefined;
  return { ensureFit: noop, finishFirstRun: noop, firstPull: noop, openSettings: noop, pull: noop, cancelPull: noop, recheckRuntime: noop };
});
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
      expect(t).toContain("Ollama 0.1.32 doesn't say which models can chat. Updating Ollama fixes this.");
    });
  }

  it("words the line without a version when the runtime gave none", () => {
    expect(text(oldOllama([gemma]))).toContain("This Ollama doesn't say which models can chat. Updating Ollama fixes this.");
  });
});
