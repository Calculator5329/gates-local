// What the Models page does to the session: which model the Default card
// names, and a removal that worked staying worked when the new default
// cannot be saved.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { State } from "./store.ts";

const session = vi.hoisted(() => ({ removeModel: vi.fn(), updateSettings: vi.fn() }));
vi.mock("./session.ts", () => session);
const store = vi.hoisted(() => ({ state: { model: "alpha" } as unknown, set: vi.fn() }));
vi.mock("./store.ts", () => ({ NA: "na", getState: () => store.state, setState: store.set }));

const { cardDefault, removeModelAndMoveDefault, savedDefault } = await import("./models-actions.ts");

const chat = (name: string, pick?: string) => ({ name, capabilities: ["completion"], ...(pick === undefined ? {} : { pick }) });
const state = (defaultModel: string, models: readonly unknown[], model: string) => ({ settings: { defaultModel }, models, model }) as unknown as State;

describe("the model the Default card names (MR-01)", () => {
  it("follows the new-chat pick, not the open chat, when the saved default is gone", () => {
    const s = state("gone", [chat("alpha", "best"), chat("beta")], "beta");
    expect(cardDefault(s)).toBe("alpha");
    expect(savedDefault(s)).toBeUndefined();
  });

  it("with no pick, stays on the model new chats would keep", () => {
    expect(cardDefault(state("gone", [chat("alpha"), chat("beta")], "beta"))).toBe("beta");
  });
});

describe("removing a model and moving the default (MR-02)", () => {
  beforeEach(() => {
    session.removeModel.mockReset().mockResolvedValue(null);
    session.updateSettings.mockReset().mockResolvedValue(null);
    store.set.mockReset();
    store.state = { threadId: "t1", model: "alpha" };
  });

  it("reports a failed save apart from the removal, which is done", async () => {
    session.updateSettings.mockResolvedValue("Couldn't save the default model.");
    expect(await removeModelAndMoveDefault("alpha", "beta")).toEqual({ removeErr: null, defaultErr: "Couldn't save the default model." });
    expect(session.removeModel).toHaveBeenCalledTimes(1);
  });

  it("moves the open chat too once the save worked", async () => {
    expect(await removeModelAndMoveDefault("alpha", "beta")).toEqual({ removeErr: null, defaultErr: null });
    expect(store.set).toHaveBeenCalledWith({ model: "beta" });
  });

  it("moves the chat even after the refresh chose a stand-in for the removed model", async () => {
    session.removeModel.mockImplementation(() => {
      store.state = { threadId: "t1", model: "stand-in" };
      return Promise.resolve(null);
    });
    await removeModelAndMoveDefault("alpha", "beta");
    expect(store.set).toHaveBeenCalledWith({ model: "beta" });
  });

  it("leaves a chat opened while the save was pending on its own model (MRR-03)", async () => {
    session.updateSettings.mockImplementation(() => {
      store.state = { threadId: "t2", model: "gamma" };
      return Promise.resolve(null);
    });
    await removeModelAndMoveDefault("alpha", "beta");
    expect(store.set).not.toHaveBeenCalled();
  });

  it("keeps a model picked in the same chat while the save was pending (MRR-03)", async () => {
    session.updateSettings.mockImplementation(() => {
      store.state = { threadId: "t1", model: "gamma" };
      return Promise.resolve(null);
    });
    await removeModelAndMoveDefault("alpha", "beta");
    expect(store.set).not.toHaveBeenCalled();
  });
});
