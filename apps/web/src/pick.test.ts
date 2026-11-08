import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@gates-local/contracts";
import { canChat, canThink, chatModels, firstChatPull, modelChoice, newChatChoice, notForChat, sendableModel } from "./pick.ts";

const m = (name: string, sizeBytes: number, capabilities: string[], pick?: ModelInfo["pick"]): ModelInfo => ({
  name,
  digest: name,
  sizeBytes,
  modifiedAt: "2026-11-01T00:00:00Z",
  capabilities,
  ...(pick ? { pick } : {}),
});
const embed = m("nomic-embed-text:latest", 274_000_000, ["embedding"]);
const small = m("qwen3.5:4b", 3_400_000_000, ["completion", "thinking"]);
const picked = m("qwen3.5:9b", 6_600_000_000, ["completion", "thinking", "tools"], { numCtx: 16384, verdict: "fits" });
const gemma = m("gemma4:12b", 7_600_000_000, ["completion", "tools"]);

const set = (model: string) => ({ kind: "set", model });
const keep = { kind: "keep" };
const clear = { kind: "clear" };

describe("client model choice", () => {
  it("starts on the server's pick, not the smallest model, and never on an embedding model", () => {
    expect(modelChoice([embed, small, picked], undefined)).toEqual(set("qwen3.5:9b"));
  });

  it("keeps the current model when it can chat, and leaves an embedding model", () => {
    expect(modelChoice([embed, small, picked], "qwen3.5:4b")).toEqual(keep);
    expect(modelChoice([embed, small, picked], "nomic-embed-text:latest")).toEqual(set("qwen3.5:9b"));
  });

  it("chooses nothing when only an embedding model is installed", () => {
    expect(modelChoice([embed], undefined)).toEqual(clear);
  });

  it("MP-03: clears a selection that cannot chat when no chat model is left", () => {
    // Discovery corrected a guessed model to embedding-only, and nothing else can chat.
    expect(modelChoice([embed], "nomic-embed-text:latest")).toEqual(clear);
    // A removed model with nothing left to chat with.
    expect(modelChoice([], "qwen3.5:4b")).toEqual(clear);
    // An unknown model (discovery failed) is not a chat model yet.
    expect(modelChoice([m("search:latest", 600_000_000, ["unknown"])], "search:latest")).toEqual(clear);
  });

  it("MP-03: keeps the selection while the list is not known yet", () => {
    expect(modelChoice(undefined, "qwen3.5:4b")).toEqual(keep);
  });

  it("MP-03: sends only with a model that can chat", () => {
    expect(sendableModel([embed, small], "nomic-embed-text:latest")).toBeUndefined();
    expect(sendableModel([embed, small], "qwen3.5:4b")).toBe("qwen3.5:4b");
    expect(sendableModel(undefined, "qwen3.5:4b")).toBeUndefined();
    expect(sendableModel([small], undefined)).toBeUndefined();
  });

  it("MP-05: a new chat starts on the server's current pick; an existing chat keeps its choice", () => {
    expect(newChatChoice([small, picked], "qwen3.5:4b")).toEqual(set("qwen3.5:9b"));
    expect(modelChoice([small, picked], "qwen3.5:4b")).toEqual(keep);
    // Without a pick, a new chat keeps a valid choice.
    expect(newChatChoice([small, gemma], "gemma4:12b")).toEqual(keep);
  });

  it("MP-01: Settings says an unknown model is being checked, not that it is an embedding model", () => {
    expect(notForChat(m("search:latest", 1, ["unknown"])).label).toBe("Checking what this model can do");
    expect(notForChat(embed).label).toBe("Embedding model, not for chat");
  });

  it("MP-04: the first download is the first chat model: an installed embedding model does not count", () => {
    const pulls = { "qwen3.5:9b": { name: "qwen3.5:9b", state: "downloading" as const, completedBytes: 1 } };
    expect(firstChatPull([embed], pulls)).toBe("qwen3.5:9b");
    expect(firstChatPull([], pulls)).toBe("qwen3.5:9b");
    expect(firstChatPull([embed, small], pulls)).toBeUndefined();
    expect(firstChatPull([embed], {})).toBeUndefined();
  });

  it("filters chat models and reads thinking from capabilities", () => {
    expect(chatModels([embed, small, gemma]).map((x) => x.name)).toEqual(["qwen3.5:4b", "gemma4:12b"]);
    expect(canChat(embed)).toBe(false);
    expect(canThink(small)).toBe(true);
    expect(canThink(gemma)).toBe(false);
  });
});
