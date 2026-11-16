// The one sentence that says Gates Local runs its own Ollama, where the banner, the footer row and
// Settings › Runtime put it.
import { afterAll, expect, it, vi } from "vitest";
import type { RuntimeStatus } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
vi.stubGlobal("window", {});
vi.stubGlobal("matchMedia", () => ({ matches: false }));
const { ownCopyNote } = await import("./words.tsx");
afterAll(() => { vi.unstubAllGlobals(); });

const settings = methodSamples["settings.get"].result;
const note = (runtime: RuntimeStatus, runtimeMode?: "app" | "system") =>
  ownCopyNote({ conn: { kind: "open" }, runtime, ...(runtimeMode === undefined ? {} : { settings: { ...settings, runtimeMode } }) });

it("names the ports it routed around from the server's busyPorts, never from the detail, and the port it uses", () => {
  const stopped = { state: "stopped", owner: "app", baseUrl: "http://127.0.0.1:11435", detail: "Port 9999 answered as something else." } as const;
  expect(note({ ...stopped, busyPorts: ["11434"] })).toBe("Something other than Ollama answers on port 11434, so Gates Local uses its own Ollama on port 11435.");
  expect(note({ ...stopped, busyPorts: ["11434", "11436", "11435"] })).toBe("Something other than Ollama answers on ports 11434 and 11436, so Gates Local uses its own Ollama on port 11435.");
  expect(note(stopped, "app")).toBe("Gates Local uses its own Ollama on port 11435.");
  expect(note(stopped, "system")).toBe("");
  expect(note(stopped)).toBe("");
});

it("says nothing when Ollama is ready, when the server is gone, or in the wrong-service state that has its own words", () => {
  const busy = ["11434"];
  expect(note({ state: "ready", owner: "app", baseUrl: "http://127.0.0.1:11435", busyPorts: busy }, "app")).toBe("");
  expect(note({ state: "wrong-service", owner: "external", baseUrl: "http://127.0.0.1:11435", busyPorts: busy }, "app")).toBe("");
  expect(ownCopyNote({ conn: { kind: "connecting" }, runtime: { state: "stopped", owner: "app", baseUrl: "http://127.0.0.1:11435", busyPorts: busy } })).toBe("");
});
