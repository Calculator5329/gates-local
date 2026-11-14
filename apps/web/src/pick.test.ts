import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@gates-local/contracts";
import { canChat, canThink, chatBlockedReason, chatModels, firstChatPull, modelChoice, newestOnly, notForChat, sendableModel } from "./pick.ts";

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
    expect(modelChoice([embed, small, picked], undefined, undefined)).toEqual(set("qwen3.5:9b"));
  });

  it("keeps a model the user chose when it can chat, and leaves an embedding model", () => {
    expect(modelChoice([embed, small, picked], "qwen3.5:4b", "qwen3.5:4b")).toEqual(keep);
    expect(modelChoice([embed, small, picked], "nomic-embed-text:latest", undefined)).toEqual(set("qwen3.5:9b"));
    // Without a pick, a current model that can chat stays.
    expect(modelChoice([small, gemma], "gemma4:12b", undefined)).toEqual(keep);
  });

  it("chooses nothing when only an embedding model is installed", () => {
    expect(modelChoice([embed], undefined, undefined)).toEqual(clear);
  });

  it("MP-03: clears a selection that cannot chat when no chat model is left", () => {
    // Discovery corrected a guessed model to embedding-only, and nothing else can chat.
    expect(modelChoice([embed], "nomic-embed-text:latest", undefined)).toEqual(clear);
    // A removed model with nothing left to chat with.
    expect(modelChoice([], "qwen3.5:4b", undefined)).toEqual(clear);
    // An unknown model (discovery failed) is not a chat model yet.
    expect(modelChoice([m("search:latest", 600_000_000, ["unknown"])], "search:latest", undefined)).toEqual(clear);
  });

  it("MP-03: keeps the selection while the list is not known yet", () => {
    expect(modelChoice(undefined, "qwen3.5:4b", "qwen3.5:4b")).toEqual(keep);
  });

  it("MP-03: sends only with a model that can chat", () => {
    expect(sendableModel([embed, small], "nomic-embed-text:latest")).toBeUndefined();
    expect(sendableModel([embed, small], "qwen3.5:4b")).toBe("qwen3.5:4b");
    expect(sendableModel(undefined, "qwen3.5:4b")).toBeUndefined();
    expect(sendableModel([small], undefined)).toBeUndefined();
  });

  it("MP-02: a model the app chose follows the server's pick when an incomplete survey recovers", () => {
    // First run started on Gemma while the survey was incomplete; the recovered pick is Qwen 9B.
    expect(modelChoice([gemma, picked], "gemma4:12b", undefined)).toEqual(set("qwen3.5:9b"));
    // MP-05: the same holds for a new chat whose pick lands after the chat exists.
    const gemmaPicked = m("gemma4:12b", 7_600_000_000, ["completion", "tools"], { numCtx: 16384, verdict: "fits" });
    expect(modelChoice([small, gemmaPicked], "qwen3.5:4b", undefined)).toEqual(set("gemma4:12b"));
  });

  it("MP-02: a model the user chose stays when the pick moves", () => {
    expect(modelChoice([gemma, picked], "gemma4:12b", "gemma4:12b")).toEqual(keep);
  });

  it("MP2-03: the user's choice survives a runtime restart's empty list and comes back with the list", () => {
    expect(modelChoice([], "gemma4:12b", "gemma4:12b")).toEqual(clear); // nothing to send to meanwhile
    expect(modelChoice([gemma, picked], undefined, "gemma4:12b")).toEqual(set("gemma4:12b"));
    // Back but not described yet: selected again, and sends wait until it is known to chat.
    const unknownGemma = m("gemma4:12b", 7_600_000_000, ["unknown"]);
    expect(modelChoice([unknownGemma, picked], undefined, "gemma4:12b")).toEqual(set("gemma4:12b"));
    expect(sendableModel([unknownGemma, picked], "gemma4:12b")).toBeUndefined();
    // Gone for good (removed): the app's pick, and the choice is not restored onto an embedding model.
    expect(modelChoice([small, picked], "gemma4:12b", "gemma4:12b")).toEqual(set("qwen3.5:9b"));
    expect(modelChoice([embed, picked], undefined, "nomic-embed-text:latest")).toEqual(set("qwen3.5:9b"));
  });

  it("MP2-02: an older models.refresh answer that lands late is dropped, as is one overtaken by a models.changed push", () => {
    const order = newestOnly();
    const older = order.next(); // window focus
    const newer = order.next(); // a finished download
    expect(order.current(newer)).toBe(true);
    expect(order.current(older)).toBe(false); // lands second: dropped
    const inFlight = order.next();
    order.next(); // models.changed arrived while it was in flight
    expect(order.current(inFlight)).toBe(false);
  });

  it("an Ollama that does not report capabilities is the reason nothing can chat, not a missing download", () => {
    const old = [m("qwen3.5:9b", 1, ["unknown", "unreported"]), m("gemma4:12b", 1, ["unknown", "unreported"])];
    // Only the missing field is known, not that the version is old: true either way.
    expect(chatBlockedReason(old, undefined)).toBe("This Ollama doesn't say which models can chat. Updating Ollama fixes this.");
    expect(notForChat(old[0]).label).toBe("Ollama doesn't say");
    // A chosen model not described yet: sends wait for it.
    expect(chatBlockedReason([m("gemma4:12b", 1, ["unknown"]), small], "gemma4:12b")).toBe("Checking what this model can do; you can send once Ollama answers.");
    // Otherwise the existing words stand: a model that can chat, or nothing installed.
    expect(chatBlockedReason([small], "qwen3.5:4b")).toBeUndefined();
    expect(chatBlockedReason([], undefined)).toBeUndefined();
    expect(chatBlockedReason(undefined, undefined)).toBeUndefined();
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
