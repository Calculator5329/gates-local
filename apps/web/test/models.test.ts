// Settings › Models against the in-memory server (harness.ts): Use as default
// updates the setting and the Default card, and removing the default moves it
// to the model the dialog named.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo, Settings } from "@gates-local/contracts";
import { methodSamples } from "@gates-local/contracts/testing";
import { type Browser, installBrowser, tick, until } from "./harness.ts";

type Session = typeof import("../src/session.ts");
type Store = typeof import("../src/store.ts");
type Actions = typeof import("../src/models-actions.ts");
type Rules = typeof import("../src/models-rules.ts");

let b: Browser;
let session: Session;
let store: Store;
let actions: Actions;
let rules: Rules;
let disconnect: (() => void) | undefined;

const info = (name: string, sizeBytes = 5e9): ModelInfo => ({ name, digest: `sha256:${name}`, sizeBytes, modifiedAt: "2026-10-01T10:00:00Z", capabilities: ["completion"] });

/** The server's state: what is installed and what is saved. */
let installed: ModelInfo[];
let saved: Settings;

beforeEach(async () => {
  b = installBrowser();
  vi.resetModules();
  session = await import("../src/session.ts");
  store = await import("../src/store.ts");
  actions = await import("../src/models-actions.ts");
  rules = await import("../src/models-rules.ts");
  disconnect = undefined;
  installed = [info("alpha:7b"), info("beta:7b"), info("gamma:7b")];
  saved = { ...methodSamples["settings.get"].result, defaultModel: "alpha:7b" };
  b.server.answer("models.list", () => installed);
  b.server.answer("models.refresh", () => installed);
  b.server.answer("settings.get", () => saved);
  b.server.answer("settings.update", (patch) => {
    // Only the default moves on this page; the rest of the patch is not under test.
    const { defaultModel } = patch;
    if (defaultModel === null) {
      const { defaultModel: _cleared, ...without } = saved;
      saved = without;
    } else if (defaultModel !== undefined) saved = { ...saved, defaultModel };
    return saved;
  });
  b.server.answer("models.remove", ({ name }) => {
    installed = installed.filter((m) => m.name !== name);
    return { name };
  });
});

afterEach(async () => {
  disconnect?.();
  b.server.accepting = false;
  for (const s of b.server.sockets) s.close();
  await tick();
  vi.unstubAllGlobals();
});

const hydrated = () => store.getState().imageStatus !== undefined && store.getState().conn.kind === "open";

async function boot(): Promise<void> {
  disconnect = session.connect();
  await until(hydrated, 2000, "hydration");
  await tick();
}

const card = () => actions.cardDefault(store.getState());

describe("Use as default", () => {
  it("saves the setting and the Default card shows the new model", async () => {
    await boot();
    expect(card()).toBe("alpha:7b");
    expect(await actions.makeDefault("gamma:7b")).toBeNull();
    expect(b.server.calls("settings.update").at(-1)?.params).toEqual({ defaultModel: "gamma:7b" });
    expect(saved.defaultModel).toBe("gamma:7b");
    expect(card()).toBe("gamma:7b");
  });
});

describe("Remove", () => {
  it("removing the default moves it to the model the dialog named", async () => {
    await boot();
    const rows = rules.sortRows(
      installed.map((m) => ({ name: m.name, display: m.name, chat: true, verdict: "fits" as const })),
      card(),
    );
    const next = rules.nextDefault(rows, "alpha:7b", card());
    expect(next).toBe("beta:7b");
    expect(await actions.removeModelAndMoveDefault("alpha:7b", next)).toBeNull();
    expect(store.getState().models?.map((m) => m.name)).toEqual(["beta:7b", "gamma:7b"]);
    expect(saved.defaultModel).toBe("beta:7b");
    expect(card()).toBe("beta:7b");
    expect(store.getState().model).toBe("beta:7b");
  });

  it("a removal that fails leaves the default where it was", async () => {
    await boot();
    b.server.answer("models.remove", () => {
      throw { code: "internal", message: "model is busy" };
    });
    const r = await actions.removeModelAndMoveDefault("alpha:7b", "beta:7b");
    expect(r).toMatch(/^Couldn't remove alpha:7b because/);
    expect(b.server.calls("settings.update")).toHaveLength(0);
    expect(card()).toBe("alpha:7b");
  });
});
