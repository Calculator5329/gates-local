import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@gates-local/contracts";
import { canChat, canThink, chatModels, modelChoice } from "./pick.ts";

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

describe("client model choice", () => {
  it("starts on the server's pick, not the smallest model, and never on an embedding model", () => {
    expect(modelChoice([embed, small, picked], undefined)).toBe("qwen3.5:9b");
  });

  it("keeps the current model when it can chat, and leaves an embedding model", () => {
    expect(modelChoice([embed, small, picked], "qwen3.5:4b")).toBeUndefined();
    expect(modelChoice([embed, small, picked], "nomic-embed-text:latest")).toBe("qwen3.5:9b");
  });

  it("chooses nothing when only an embedding model is installed", () => {
    expect(modelChoice([embed], undefined)).toBeUndefined();
  });

  it("filters chat models and reads thinking from capabilities", () => {
    expect(chatModels([embed, small, gemma]).map((x) => x.name)).toEqual(["qwen3.5:4b", "gemma4:12b"]);
    expect(canChat(embed)).toBe(false);
    expect(canThink(small)).toBe(true);
    expect(canThink(gemma)).toBe(false);
  });
});
