// The rules behind Settings › Models (models-rules.ts): fit words per
// verdict, the installed order, the next default, Recommended with its
// backfill, the typed-name check and the name truncation.
import type { CatalogEntry, FitReport, FitVerdict, PullProgress } from "@gates-local/contracts";
import { describe, expect, it } from "vitest";
import {
  FIT_LABELS,
  type Row,
  about,
  canBeDefault,
  downloadCards,
  fitLabel,
  fitReason,
  fitSymbol,
  lookup,
  nameOf,
  nextDefault,
  progressParts,
  recommendedPicks,
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

const p = (name: string, state: PullProgress["state"], more: Partial<PullProgress> = {}): PullProgress => ({ name, state, completedBytes: 0, ...more });

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

  it("says a model past its context limit is held back by the limit, not memory", () => {
    expect(fitReason({ ...fit("refuse"), contextLimit: 8192 })).toBe("Supports up to 8k of context; new chats use 16k.");
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

describe("Recommended", () => {
  const cat = [entry("w1", "fits"), entry("w2", "fits"), entry("slow", "spills"), entry("w3", "fits"), entry("w4", "fits"), entry("own", "fits", { purpose: "Installed by you", installed: true })];
  const none = new Set<string>();

  it("lists only models that run well, in catalog order, three at most", () => {
    const r = recommendedPicks(cat, none, none);
    expect(r.picks.map((c) => c.name)).toEqual(["w1", "w2", "w3"]);
    expect(r).toMatchObject({ allInstalled: false, slower: false });
  });

  it("backfills the next pick once one is installed or downloading", () => {
    expect(recommendedPicks(cat, new Set(["w1"]), none).picks.map((c) => c.name)).toEqual(["w2", "w3", "w4"]);
    expect(recommendedPicks(cat, none, new Set(["w2"])).picks.map((c) => c.name)).toEqual(["w1", "w3", "w4"]);
  });

  it("says every pick is installed when none is left", () => {
    const r = recommendedPicks(cat, new Set(["w1", "w2", "w3", "w4"]), none);
    expect(r.picks).toEqual([]);
    expect(r.allInstalled).toBe(true);
  });

  it("on a computer where nothing runs well, offers the lightest slower picks and says so", () => {
    const slow = [entry("s-big", "spills", { downloadBytes: 9 * GIB }), entry("s-small", "spills", { downloadBytes: 3 * GIB }), entry("never", "refuse")];
    const r = recommendedPicks(slow, none, none);
    expect(r.picks.map((c) => c.name)).toEqual(["s-small", "s-big"]);
    expect(r.slower).toBe(true);
  });
});

describe("downloads", () => {
  it("splits pushes into running, ready and failed cards", () => {
    const pulls = { a: p("a", "downloading"), b: p("b", "done"), c: p("c", "error"), d: p("d", "cancelled"), e: p("e", "queued") };
    const c = downloadCards(pulls);
    expect(c.running.map((x) => x.name)).toEqual(["a", "e"]);
    expect(c.ready.map((x) => x.name)).toEqual(["b"]);
    expect(c.failed.map((x) => x.name)).toEqual(["c"]);
  });

  it("leaves the not-found error of the typed name to the search results", () => {
    const pulls = { nemox: p("nemox", "error", { reason: "not-found" }) };
    expect(downloadCards(pulls, "nemox").failed).toEqual([]);
    expect(downloadCards(pulls, "other").failed).toHaveLength(1);
  });

  it("words progress as percent, time left, bytes and speed", () => {
    expect(progressParts(p("a", "downloading", { completedBytes: 3.9 * GIB, totalBytes: 9.3 * GIB, bytesPerSecond: 41e6 }))).toEqual({
      pct: 41,
      left: "about 3 min left",
      got: "3.9 of 9.3 GB",
      rate: "41 MB/s",
    });
    expect(progressParts(p("a", "queued"))).toEqual({ pct: null, left: null, got: null, rate: null });
  });
});

describe("typed names", () => {
  const cat = [entry("qwen3:14b", "fits"), entry("gemma4:12b", "fits", { installed: true })];
  const none = new Set<string>();

  it("answers a catalog name at once and an installed one as installed", () => {
    expect(lookup("qwen3:14b", cat, none, {})).toMatchObject({ k: "catalog", entry: { name: "qwen3:14b" } });
    expect(lookup("gemma4:12b", cat, none, {})).toEqual({ k: "installed" });
    expect(lookup("phi4", cat, new Set(["phi4:latest"]), {})).toEqual({ k: "installed" });
  });

  it("leaves any other name unchecked until its download asks the library", () => {
    expect(lookup("mistral-nemo", cat, none, {})).toEqual({ k: "unchecked" });
    expect(lookup("mistral-nemo", cat, none, { "mistral-nemo": p("mistral-nemo", "queued") })).toEqual({ k: "checking" });
    expect(lookup("mistral-nemo", cat, none, { "mistral-nemo": p("mistral-nemo", "downloading", { totalBytes: 7 * GIB }) })).toEqual({ k: "found", totalBytes: 7 * GIB });
    expect(lookup("mistral-nemox", cat, none, { "mistral-nemox": p("mistral-nemox", "error", { reason: "not-found" }) })).toEqual({ k: "not-found" });
  });

  it("ignores text that cannot be a model name", () => {
    expect(lookup("", cat, none, {})).toEqual({ k: "none" });
    expect(lookup("a model for code", cat, none, {})).toEqual({ k: "none" });
  });
});
