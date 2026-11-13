// The rules behind Settings › Models (models-rules.ts): fit words per
// verdict, the installed order, the next default and the name truncation.
import type { CatalogEntry, FitReport, FitVerdict } from "@gates-local/contracts";
import { describe, expect, it } from "vitest";
import {
  type Row,
  about,
  canBeDefault,
  filterShows,
  fitLabel,
  fitReason,
  nameOf,
  nextDefault,
  optionVariants,
  pullName,
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
  it("says an estimate is one, and keeps Runs for a model that really ran at that size", () => {
    expect(fitLabel("fits")).toBe("Should run well");
    expect(fitLabel("spills")).toBe("Should run slower");
    expect(fitLabel("fits", true)).toBe("Runs well");
    expect(fitLabel("spills", true)).toBe("Runs slower");
  });

  it("says a model that cannot load won't run, measured or not", () => {
    expect(fitLabel("refuse")).toBe("Won't run here");
    expect(fitLabel("refuse", true, true)).toBe("Won't run here");
  });

  it("says system memory when there is no supported GPU", () => {
    expect(fitLabel("spills", false, true)).toBe("Should run in system memory");
    expect(fitLabel("spills", true, true)).toBe("Runs in system memory");
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
  it("shows curated models by label and purpose, any other by a cleaned name and its Ollama id, with no invented tagline", () => {
    const cat = [entry("qwen3.5:9b", "fits", { label: "Qwen 3.5 9B", purpose: "Fast everyday answers" }), entry("mine:latest", "fits", { label: "mine", purpose: "Installed by you" })];
    expect(nameOf("qwen3.5:9b", cat)).toEqual({ text: "Qwen 3.5 9B", purpose: "Fast everyday answers" });
    expect(nameOf("mine:latest", cat)).toEqual({ text: "mine", purpose: "", id: "mine:latest" });
    expect(nameOf("other3:7b", undefined)).toEqual({ text: "Other 3 7B", purpose: "", id: "other3:7b" });
  });

  it("leaves the owner's path out of a cleaned hf.co name", () => {
    expect(nameOf("hf.co/someone/qwen3.5-GGUF:9b", undefined).text).toBe("Qwen 3.5 GGUF 9B");
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

  it("keeps the filter field while it holds text, even when the list got short (MR-03)", () => {
    expect(filterShows(9, "")).toBe(true);
    expect(filterShows(8, "")).toBe(false);
    expect(filterShows(8, "qwen")).toBe(true);
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

const options = (text: string, ...names: string[]) => names.map((name) => ({ name, label: { text } }));
const variants = (text: string, ...names: string[]) => [...optionVariants(options(text, ...names)).values()];

describe("optionVariants: what tells two options with the same name apart", () => {
  it("shows the quant when only the quant differs", () => {
    expect(variants("model 9B", "local/model:9b-q4_K_M", "local/model:9b-q8_0")).toEqual(["q4_K_M", "q8_0"]);
  });

  it("shows the owner when only the owner differs", () => {
    expect(variants("custom", "a/custom:latest", "b/custom:latest")).toEqual(["a", "b"]);
  });

  it("never leaves an option with nothing to show", () => {
    expect(variants("model", "x/model:latest", "model:latest")).toEqual(["x/model", "model"]);
    expect(variants("model 9B", "model:9b", "model:9b-q4")).toEqual(["9b", "9b-q4"]);
  });

  it("tells every member of a larger group apart", () => {
    const shown = variants("m", "a/m:1", "b/m:1", "c/m:2");
    expect(new Set(shown).size).toBe(3);
    expect(shown.every((v) => v !== "")).toBe(true);
  });

  it("gives up on shortening when that would make two read alike, and shows the whole id", () => {
    expect(variants("x", "a/x:1", "a:x:1")).toEqual(["a/x:1", "a:x:1"]);
  });

  it("adds nothing to a name that is already unique", () => {
    expect(optionVariants([...options("Gemma 4 12B", "gemma4:12b"), ...options("Qwen 3.5 9B", "qwen3.5:9b")]).size).toBe(0);
  });
});


describe("the name typed under Any model from the Ollama library", () => {
  it("takes a command pasted from the Ollama site as the model it names", () => {
    expect(pullName("ollama run gemma4:26b")).toBe("gemma4:26b");
    expect(pullName("  ollama pull  phi5:14b ")).toBe("phi5:14b");
    expect(pullName("Ollama Run hf.co/a/b:Q4_K_M")).toBe("hf.co/a/b:Q4_K_M");
  });

  it("leaves a plain name alone, trimmed", () => {
    expect(pullName(" qwen3.5:9b ")).toBe("qwen3.5:9b");
    expect(pullName("ollama")).toBe("ollama");
    expect(pullName("   ")).toBe("");
  });
});
