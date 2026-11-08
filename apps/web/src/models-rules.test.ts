// The rules behind Settings › Models (models-rules.ts): fit words per
// verdict, the installed order, the next default and the name truncation.
import type { CatalogEntry, FitReport, FitVerdict } from "@gates-local/contracts";
import { describe, expect, it } from "vitest";
import {
  FIT_LABELS,
  type Row,
  about,
  canBeDefault,
  fitLabel,
  fitReason,
  fitSymbol,
  nameOf,
  nextDefault,
  shortTag,
  sizeText,
  sortRows,
  splitTail,
} from "./models-rules.ts";

const GIB = 1024 ** 3;

const fit = (verdict: FitVerdict, need = 8 * GIB, free = 14 * GIB): FitReport => ({
  model: "m",
  numCtx: 16384,
  freeVramBytes: free,
  needVramBytes: need,
  spillRamBytes: verdict === "spills" ? need - free : 0,
  verdict,
  source: "estimate",
  measuredAt: 0,
});

const entry = (name: string, verdict: FitVerdict | undefined, more: Partial<CatalogEntry> = {}): CatalogEntry => ({
  name,
  label: name.toUpperCase(),
  purpose: "Curated purpose",
  downloadBytes: 5 * GIB,
  installed: false,
  recommended: verdict === "fits",
  ...(verdict === undefined ? {} : { fit: fit(verdict) }),
  ...more,
});

const row = (name: string, verdict: FitVerdict | undefined = "fits", chat = true, display = name): Row => ({ name, display, chat, verdict });

describe("fit words", () => {
  it("(b) is built: Runs well, Runs slower, Won't run here", () => {
    expect(fitLabel("fits")).toBe("Runs well");
    expect(fitLabel("spills")).toBe("Runs slower");
    expect(fitLabel("refuse")).toBe("Won't run here");
  });

  it("keeps (a) and (c) one switch away", () => {
    expect(fitLabel("fits", "a")).toBe("Runs on your GPU");
    expect(fitLabel("refuse", "a")).toBe("Too big for this computer");
    expect(Object.keys(FIT_LABELS)).toEqual(["a", "b", "c"]);
  });

  it("puts a symbol on the exceptions only, except in (c)", () => {
    expect(fitSymbol("fits")).toBeNull();
    expect(fitSymbol("spills")).toBe("slow");
    expect(fitSymbol("refuse")).toBe("big");
    expect(fitSymbol("fits", "c")).toBe("ok");
  });

  it("gives the reason outcome first, one number per resource", () => {
    expect(fitReason(fit("spills", 15.3 * GIB, 13.6 * GIB))).toBe("Needs about 15 GB. Your GPU has 14 GB free, so the rest runs in slower system memory.");
    expect(fitReason(fit("fits", 7.5 * GIB, 13.6 * GIB))).toBe("Needs about 7.5 GB. Your GPU has 14 GB free, so it runs entirely on the GPU.");
    expect(fitReason(fit("refuse", 49 * GIB))).toMatch(/^Needs about 49 GB\. .*can't load\.$/);
  });

  it("rounds sizes like the tooltips: one decimal under 10 GB", () => {
    expect(about(6.6 * GIB)).toBe("6.6 GB");
    expect(about(9.97 * GIB)).toBe("10 GB");
    expect(about(43.2 * GIB)).toBe("43 GB");
  });

  it("gives a model under 1 GB its size in MB", () => {
    expect(sizeText(274 * 1024 ** 2)).toBe("274 MB");
    expect(sizeText(6.6 * GIB)).toBe("6.6 GB");
  });
});

describe("names", () => {
  it("shows curated models by label and purpose, any other by its tag in mono", () => {
    const cat = [entry("qwen3.5:9b", "fits", { label: "Qwen 3.5 9B", purpose: "Fast everyday answers" }), entry("mine:latest", "fits", { label: "mine", purpose: "Installed by you" })];
    expect(nameOf("qwen3.5:9b", cat)).toEqual({ text: "Qwen 3.5 9B", purpose: "Fast everyday answers", mono: false });
    expect(nameOf("mine:latest", cat)).toEqual({ text: "mine", purpose: "", mono: true });
    expect(nameOf("other:7b", undefined)).toEqual({ text: "other:7b", purpose: "", mono: true });
  });

  it("collapses the hf.co owner and drops :latest", () => {
    expect(shortTag("hf.co/llmfan46/gemma-4-26B-A4B-it-ultra-uncensored-heretic-GGUF:Q4_K_M")).toBe("hf.co/…/gemma-4-26B-A4B-it-ultra-uncensored-heretic-GGUF:Q4_K_M");
    expect(shortTag("milo-e4b-v4:latest")).toBe("milo-e4b-v4");
  });

  it("cuts long names in the middle and always keeps the quant tail", () => {
    const [head, tail] = splitTail("hf.co/…/gemma-4-26B-A4B-it-ultra-uncensored-heretic-GGUF:Q4_K_M");
    expect(tail).toBe("GGUF:Q4_K_M");
    expect(head + tail).toBe("hf.co/…/gemma-4-26B-A4B-it-ultra-uncensored-heretic-GGUF:Q4_K_M");
    expect(splitTail("hf.co/…/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF:IQ3_M")[1]).toBe("GGUF:IQ3_M");
    expect(splitTail("qwen3.8-abliterated:27b")).toEqual(["qwen3.8-abliterated:27b", ""]);
  });
});

describe("installed order and the default", () => {
  const rows = [row("zeta"), row("Alpha"), row("big", "refuse"), row("embed", undefined, false), row("beta"), row("mid", "spills")];

  it("puts the default first, then A to Z with case ignored", () => {
    expect(sortRows(rows, "mid").map((r) => r.name)).toEqual(["mid", "Alpha", "beta", "big", "embed", "zeta"]);
    expect(sortRows(rows, undefined).map((r) => r.name)).toEqual(["Alpha", "beta", "big", "embed", "mid", "zeta"]);
  });

  it("offers Use as default only on loadable chat models that are not the default", () => {
    expect(canBeDefault(row("beta"), "mid")).toBe(true);
    expect(canBeDefault(row("mid", "spills"), "mid")).toBe(false);
    expect(canBeDefault(row("big", "refuse"), "mid")).toBe(false);
    expect(canBeDefault(row("embed", undefined, false), "mid")).toBe(false);
    expect(canBeDefault(row("unchecked", undefined), "mid")).toBe(true);
  });

  it("moves the default to the next chat model that can load, skipping won't-run and embeddings", () => {
    const sorted = sortRows([row("a-def"), row("b-big", "refuse"), row("c-embed", undefined, false), row("d-slow", "spills"), row("e")], "a-def");
    expect(nextDefault(sorted, "a-def", "a-def")).toBe("d-slow");
  });

  it("leaves the default alone when another model goes, and clears it when nothing can take over", () => {
    const sorted = sortRows([row("a"), row("b")], "a");
    expect(nextDefault(sorted, "b", "a")).toBeUndefined();
    expect(nextDefault(sortRows([row("only"), row("big", "refuse")], "only"), "only", "only")).toBeNull();
  });
});

