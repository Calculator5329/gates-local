import { describe, expect, it } from "vitest";
import type { FitReport, FitVerdict } from "../fit/types.ts";
import { canChat, pickChatModel, rankChatModels } from "./pick.ts";
import type { ModelInfo } from "./types.ts";

const GIB = 1024 ** 3;
const model = (name: string, gib: number, capabilities: string[], parameterSize?: string): ModelInfo => ({
  name,
  digest: `sha-${name}`,
  sizeBytes: Math.round(gib * GIB),
  modifiedAt: "2026-11-01T10:00:00Z",
  capabilities,
  ...(parameterSize ? { parameterSize } : {}),
});

const chat = ["completion", "tools"];
const embed = model("nomic-embed-text:latest", 0.26, ["embedding"], "137M");
const qwen9 = model("qwen3.5:9b", 6.6, [...chat, "thinking"], "9.7B");
const qwen4 = model("qwen3.5:4b", 3.4, [...chat, "thinking"], "4.7B");
const gemma12 = model("gemma4:12b", 7.6, chat, "12.2B");
const big27 = model("qwen3.8-abliterated:27b", 17.4, ["completion", "thinking"], "27B");
const own7 = model("llama3.1:8b", 4.9, chat, "8.0B");
const own3 = model("llama3.2:3b", 2.0, chat, "3.2B");

const report = (name: string, verdict: FitVerdict, numCtx: number): FitReport => ({
  model: name,
  numCtx,
  freeVramBytes: 12 * GIB,
  needVramBytes: 8 * GIB,
  spillRamBytes: verdict === "spills" ? GIB : 0,
  verdict,
  source: "estimate",
  measuredAt: 1,
});

/** A fit function from a verdict table; names not in it fit. Records the order asked. */
function fitTable(table: Record<string, FitVerdict | "fail"> = {}, numCtx = 16384) {
  const asked: string[] = [];
  const fit = async (name: string) => {
    asked.push(name);
    const v = table[name] ?? "fits";
    return v === "fail" ? undefined : report(name, v, numCtx);
  };
  return { fit, asked };
}

describe("pickChatModel", () => {
  it("skips an embedding model even when it is the smallest installed", async () => {
    const { fit } = fitTable();
    const pick = await pickChatModel({ models: [embed, qwen4, qwen9], numCtx: 16384, fit });
    expect(pick).toEqual({ name: "qwen3.5:9b", pick: { numCtx: 16384, verdict: "fits" }, complete: true });
  });

  it("returns nothing when no installed model can chat", async () => {
    const { fit, asked } = fitTable();
    expect(await pickChatModel({ models: [embed], numCtx: 16384, fit })).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("honours the settings default only when it can chat", async () => {
    const { fit } = fitTable();
    expect((await pickChatModel({ models: [embed, qwen4, qwen9], defaultModel: "qwen3.5:4b", numCtx: 16384, fit }))?.name).toBe("qwen3.5:4b");
    expect((await pickChatModel({ models: [embed, qwen4, qwen9], defaultModel: "nomic-embed-text:latest", numCtx: 16384, fit }))?.name).toBe("qwen3.5:9b");
  });

  it("drops a default that is refused at the chosen context and picks the best that fits", async () => {
    const { fit } = fitTable({ "qwen3.8-abliterated:27b": "refuse" });
    const pick = await pickChatModel({ models: [qwen4, big27, qwen9], defaultModel: "qwen3.8-abliterated:27b", numCtx: 16384, fit });
    expect(pick?.name).toBe("qwen3.5:9b");
  });

  it("keeps a default that spills: the user chose it", async () => {
    const { fit } = fitTable({ "qwen3.8-abliterated:27b": "spills" });
    const pick = await pickChatModel({ models: [qwen9, big27], defaultModel: "qwen3.8-abliterated:27b", numCtx: 16384, fit });
    expect(pick).toEqual({ name: "qwen3.8-abliterated:27b", pick: { numCtx: 16384, verdict: "spills" }, complete: true });
  });

  it("picks the best curated model that fits over the smallest one", async () => {
    const { fit } = fitTable();
    expect((await pickChatModel({ models: [own3, qwen4, gemma12], numCtx: 16384, fit }))?.name).toBe("gemma4:12b");
  });

  it("prefers a lower-ranked model that fits over a higher-ranked one that spills", async () => {
    const { fit } = fitTable({ "qwen3.5:9b": "spills" });
    expect(await pickChatModel({ models: [qwen9, gemma12], numCtx: 16384, fit })).toEqual({
      name: "gemma4:12b",
      pick: { numCtx: 16384, verdict: "fits" },
      complete: true,
    });
  });

  it("falls back to the best model that spills when none fits", async () => {
    const { fit } = fitTable({ "qwen3.5:9b": "spills", "gemma4:12b": "spills", "qwen3.8-abliterated:27b": "refuse" }, 32768);
    expect(await pickChatModel({ models: [big27, gemma12, qwen9], numCtx: 32768, fit })).toEqual({
      name: "qwen3.5:9b",
      pick: { numCtx: 32768, verdict: "spills" },
      complete: true,
    });
  });

  it("states the size the model actually runs at", async () => {
    const pick = await pickChatModel({ models: [own3], numCtx: 16384, fit: async (name) => report(name, "fits", 2048) });
    expect(pick?.pick).toEqual({ numCtx: 2048, verdict: "fits" });
  });

  it("says nothing fits: the best-ranked model with verdict refuse", async () => {
    const { fit } = fitTable({ "qwen3.5:9b": "refuse", "qwen3.5:4b": "refuse" }, 65536);
    expect(await pickChatModel({ models: [qwen4, qwen9, embed], numCtx: 65536, fit })).toEqual({
      name: "qwen3.5:9b",
      pick: { numCtx: 65536, verdict: "refuse" },
      complete: true,
    });
  });

  it("fits every chat model once and never fits an embedding model", async () => {
    const { fit, asked } = fitTable();
    await pickChatModel({ models: [own3, embed, qwen4, qwen9], defaultModel: "qwen3.5:4b", numCtx: 16384, fit });
    expect(asked.toSorted()).toEqual(["llama3.2:3b", "qwen3.5:4b", "qwen3.5:9b"]);
  });

  it("ranks by curated order, then larger parameter count, without a verdict when the fit cannot run", async () => {
    const { fit } = fitTable({ "llama3.2:3b": "fail", "llama3.1:8b": "fail" });
    expect(await pickChatModel({ models: [own3, own7], numCtx: 16384, fit })).toEqual({ name: "llama3.1:8b", pick: { numCtx: 16384 }, complete: false });
  });

  it("MP-02: one failed fit and one refused is not 'nothing runs': the unchecked model, no verdict, incomplete", async () => {
    const { fit } = fitTable({ "qwen3.5:9b": "fail", "qwen3.5:4b": "refuse" });
    expect(await pickChatModel({ models: [qwen4, qwen9], numCtx: 65536, fit })).toEqual({ name: "qwen3.5:9b", pick: { numCtx: 65536 }, complete: false });
  });

  it("MP-02: a fallback below an unchecked better-ranked model is incomplete", async () => {
    const { fit } = fitTable({ "qwen3.5:9b": "fail" });
    expect(await pickChatModel({ models: [qwen9, gemma12], numCtx: 16384, fit })).toEqual({
      name: "gemma4:12b",
      pick: { numCtx: 16384, verdict: "fits" },
      complete: false,
    });
  });

  it("MP-02: a spill with any unchecked model is incomplete (that one may fit)", async () => {
    const { fit } = fitTable({ "qwen3.5:9b": "spills", "gemma4:12b": "fail" });
    expect((await pickChatModel({ models: [qwen9, gemma12], numCtx: 16384, fit }))?.complete).toBe(false);
  });

  it("MP-02: a default whose fit failed is kept without a verdict and is incomplete", async () => {
    const { fit } = fitTable({ "qwen3.5:4b": "fail" });
    expect(await pickChatModel({ models: [qwen4, qwen9], defaultModel: "qwen3.5:4b", numCtx: 16384, fit })).toEqual({
      name: "qwen3.5:4b",
      pick: { numCtx: 16384 },
      complete: false,
    });
  });

  it("MP-01: a model whose capabilities are unknown is never fitted or picked", async () => {
    const { fit, asked } = fitTable();
    const search = model("search:latest", 0.6, ["unknown"], "600M");
    expect((await pickChatModel({ models: [search, qwen4], defaultModel: "search:latest", numCtx: 16384, fit }))?.name).toBe("qwen3.5:4b");
    expect(asked).toEqual(["qwen3.5:4b"]);
  });
});

describe("rankChatModels", () => {
  it("puts curated models in curated order first, then the rest by parameter count", () => {
    expect(rankChatModels([own3, embed, big27, own7, qwen4, gemma12, qwen9]).map((m) => m.name)).toEqual([
      "qwen3.5:9b",
      "gemma4:12b",
      "qwen3.5:4b",
      "qwen3.8-abliterated:27b", // not curated since the list holds only pullable models
      "llama3.1:8b",
      "llama3.2:3b",
    ]);
  });
});

describe("canChat", () => {
  it("is true only with the completion capability", () => {
    expect(canChat(qwen9)).toBe(true);
    expect(canChat(embed)).toBe(false);
  });
});
