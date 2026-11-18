import { describe, expect, it } from "vitest";
import { fitWords, type CatalogEntry, type FitReport, type GpuOccupant, type Message, type Source } from "@gates-local/contracts";
import { CONTEXT_SIZES, cardGb, ctxFor, decodeSpeed, describeModel, fileSize, folderWords, gb, holderName, k, replyMeta, replyWait, shortAge, slowReason, sourceDetail, titleFrom, turnTime, verdictOf, when } from "./format.ts";
import { drawTimes } from "../../thread/times.ts";
import { homeTilde, libraryToolCanUse } from "./settings-rules.ts";

const SP = String.fromCharCode(160);

const src = (kind: "folder" | "file" | "sqlite", state: "ready" | "refreshing" | "error" = "ready") => ({ kind, state });

describe("libraryToolCanUse: a tool is ready only with a source it can really read", () => {
  it("Read files takes folders and files, never a SQLite database (readLibrary leaves those out)", () => {
    expect(libraryToolCanUse("read", [src("folder")])).toBe(true);
    expect(libraryToolCanUse("read", [src("file")])).toBe(true);
    expect(libraryToolCanUse("read", [src("sqlite")])).toBe(false);
  });

  it("Query databases takes SQLite only (querySnapshot refuses anything else)", () => {
    expect(libraryToolCanUse("query", [src("sqlite")])).toBe(true);
    expect(libraryToolCanUse("query", [src("folder"), src("file")])).toBe(false);
  });

  it("Run commands sees every source in the sandbox", () => {
    expect(libraryToolCanUse("run", [src("sqlite")])).toBe(true);
    expect(libraryToolCanUse("run", [src("folder")])).toBe(true);
    expect(libraryToolCanUse("run", [])).toBe(false);
  });

  it("a source that is not ready counts for nothing", () => {
    expect(libraryToolCanUse("read", [src("folder", "error")])).toBe(false);
    expect(libraryToolCanUse("query", [src("sqlite", "refreshing")])).toBe(false);
    expect(libraryToolCanUse("run", [src("file", "error")])).toBe(false);
  });
});

describe("gb", () => {
  it("keeps the number and its unit on one line", () => {
    expect(gb(5.1 * 1024 ** 3)).toBe(`5.1${SP}GB`);
  });

  it("says a whole card's size in whole GB, as the memory marks do (16303 MiB is a 16 GB card)", () => {
    expect(cardGb(16303 * 1024 ** 2)).toBe(`16${SP}GB`);
  });
});

describe("shortAge, the drawer's one time format", () => {
  const now = Date.UTC(2026, 10, 12, 20);
  const ago = (ms: number) => shortAge(now - ms, now);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  it.each([
    [10_000, "now"],
    [5 * MIN, "5m"],
    [3 * HOUR, "3h"],
    [2 * DAY, "2d"],
    [21 * DAY, "3w"],
    [150 * DAY, "5mo"],
    [800 * DAY, "2y"],
  ])("%d ms ago is %s", (ms, want) => {
    expect(ago(ms)).toBe(want);
  });
});

const size = (sizeBytes: number) => sourceDetail({ id: "s", kind: "file", label: "notes.txt", path: "notes.txt", addedAt: 0, sizeBytes, state: "ready" });
describe("a home folder in a path", () => {
  it.each([
    ["/home/u/docs/notes", "~/docs/notes"],
    ["/home/u", "~"],
    ["/Users/u/docs", "~/docs"],
    ["C:\\Users\\u\\Documents", "~\\Documents"],
    ["/data/home/u/docs", "/data/home/u/docs"],
    ["D:\\work", "D:\\work"],
  ])("%s reads %s", (path, want) => {
    expect(homeTilde(path)).toBe(want);
  });
});

describe("a Library folder's detail", () => {
  it("has none: the size on disk of a folder entry is not the size of what is in it", () => {
    expect(sourceDetail({ id: "s", kind: "folder", label: "docs", path: "docs", addedAt: 0, sizeBytes: 4096, state: "ready" })).toBe("");
  });
});

describe("a Library source's size", () => {
  it("says a small file's real size, never rounds it up to 1 MB", () => {
    // A 223-byte text file showed as "1 MB" in the Library (Windows test, 2026-11-07).
    expect(size(223)).toBe("223 bytes");
    expect(size(1)).toBe("1 byte");
    expect(size(40_000)).toBe("39 KB");
    expect(size(5 * 1024 ** 2)).toBe("5 MB");
    expect(size(3 * 1024 ** 3)).toBe(`3.0${SP}GB`);
  });
});

const GIB = 1024 ** 3;
const base: FitReport = {
  model: "m",
  numCtx: 16384,
  freeVramBytes: 12 * GIB,
  needVramBytes: 0,
  spillRamBytes: 0,
  verdict: "refuse",
  source: "estimate",
  measuredAt: 1,
};

describe("the context a model runs at", () => {
  const models = [{ name: "tiny:2k", maxContext: 2048 }, { name: "big:9b", maxContext: 262144 }, { name: "new:1b" }];

  it("is the chosen size, never past what the model takes, and never jumps up to its maximum", () => {
    expect(ctxFor(16384, models, "tiny:2k")).toBe(2048);
    expect(ctxFor(16384, models, "big:9b")).toBe(16384);
  });

  it("stays the chosen size until the model is known", () => {
    expect(ctxFor(16384, models, "new:1b")).toBe(16384);
    expect(ctxFor(16384, models, "absent")).toBe(16384);
    expect(ctxFor(16384, undefined, "tiny:2k")).toBe(16384);
  });

  it("offers an 8k choice and labels small windows honestly", () => {
    expect(CONTEXT_SIZES).toEqual([8192, 16384, 32768, 65536]);
    expect(k(2048)).toBe("2k");
    expect(k(512)).toBe("512");
  });
});

describe("verdictOf", () => {
  it("prints the server's words and judges nothing itself", () => {
    const refused: FitReport = { ...base, needVramBytes: 20 * GIB, shortfallBytes: 3 * GIB };
    const v = verdictOf({ ...refused, words: fitWords(refused, "card", false) });
    expect(v.word).toBe("Not enough memory at 16k");
    expect(v.need).toBe(20 * GIB);
    // a report the server sent without words prints nothing, keeping only the colour of its verdict
    expect(verdictOf({ ...base, verdict: "fits" })).toMatchObject({ k: "gpu", word: "", label: "" });
  });

  it.each(["fits", "spills", "refuse"] as const)("a %s report from a server too old to send words shows no verdict in any of its words", (verdict) => {
    const v = verdictOf({ ...base, verdict });
    expect([v.label, v.word, v.chip, v.detail, v.mark, v.short]).toEqual(["", "", "", "", "", ""]);
    expect(v.amt).toBe(0);
  });
});

const msg = (stats: Message["stats"]): Message => ({ id: "a", threadId: "t", role: "assistant", content: "x", createdAt: 1, ...(stats ? { stats } : {}) });

describe("decode speed", () => {
  it("divides by decode time, not the total that includes the load", () => {
    // A cold turn: 4 s total (3.5 s of it loading the model), 60 tokens decoded in 0.5 s.
    const m = msg({ completionTokens: 60, durationMs: 4000, evalDurationMs: 500 });
    expect(decodeSpeed(m.stats)).toBe(120);
    expect(replyMeta(m, 4500)).toBe("4.5 s · 120 tok/s");
    // a reply that did no thinking or tool work says its speed alone
    expect(replyMeta(m, 0)).toBe("120 tok/s");
  });

  it("a reply that waited for its model says the wait as its own figure, beside the work it did", () => {
    // a first answer on a new card: ready 52.8 s after Enter, then 5.3 s of thinking
    const saved: Message = { ...msg({ completionTokens: 1665, evalDurationMs: 15_000 }), times: { startedAt: 1_000, readyAt: 53_800, firstTokenAt: 59_100, spans: [], callsAt: {}, workMs: 5_300, ended: { reason: "done", at: 74_300 } } };
    const drawn = drawTimes(saved, undefined);
    expect(drawn.waitMs).toBe(52_800);
    expect(replyWait(drawn.waitMs)).toBe("52.8 s");
    expect(replyMeta(saved, drawn.workMs)).toBe("5.3 s · 111 tok/s");
    // a warm reply, ready within a second of Enter, says no wait
    expect(replyWait(drawTimes({ ...saved, times: { ...saved.times!, readyAt: 1_400 } }, undefined).waitMs)).toBeUndefined();
    // a row saved before the server kept when the model was ready says none either
    const { readyAt: _r, ...older } = saved.times!;
    expect(drawTimes({ ...saved, times: older }, undefined).waitMs).toBeUndefined();
  });

  it("falls back to the total for a reply saved before decode time was kept", () => {
    expect(decodeSpeed({ completionTokens: 60, durationMs: 2000 })).toBe(30);
    expect(decodeSpeed({ completionTokens: 60 })).toBeUndefined();
  });
});

describe("fileSize", () => {
  it("moves up a unit when rounding reaches 1024 (LS-01)", () => {
    expect(fileSize(1_048_064)).toBe("1 MB");
    expect(fileSize(1_073_217_536)).toBe(`1.0${SP}GB`);
  });

  it("stays in the unit below that", () => {
    expect(fileSize(1023)).toBe("1023 bytes");
    expect(fileSize(1_047_552)).toBe("1023 KB");
    expect(fileSize(1_072_693_248)).toBe("1023 MB");
  });
});

const library = (over: Partial<Source>): Source => ({ id: "s", kind: "file", label: "notes.txt", path: "notes.txt", addedAt: 0, state: "ready", ...over });

describe("a Library file's detail line", () => {
  it("says Refreshing… while it refreshes, the error when reading failed, and its size and copy date once it is read", () => {
    expect(sourceDetail(library({ state: "refreshing", sizeBytes: 223, snapshotAt: 1 }))).toBe("Refreshing…");
    expect(sourceDetail(library({ state: "error", detail: "The file is gone.", sizeBytes: 223 }))).toBe("The file is gone.");
    expect(sourceDetail(library({ state: "error" }))).toBe("Couldn't read it.");
    const at = new Date(2026, 10, 7, 9).getTime();
    const day = new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    expect(sourceDetail(library({ sizeBytes: 223, snapshotAt: at }))).toBe(`223 bytes · copied ${day}`);
    expect(sourceDetail(library({ snapshotAt: at }))).toBe(`copied ${day}`);
  });
});

describe("folder names in the app's words", () => {
  it("spells the folders the Windows way when the window says it runs on Windows, and as home paths everywhere else", () => {
    const win = folderWords("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36");
    expect(win).toEqual({ models: "%USERPROFILE%\\.ollama\\models", appCopy: "%LOCALAPPDATA%\\GatesLocal\\runtime\\ollama", appModels: "%LOCALAPPDATA%\\GatesLocal\\models" });
    const home = { models: "~/.ollama/models", appCopy: "~/.local/share/gates-local/runtime/ollama", appModels: "~/.local/share/gates-local/models" };
    expect(folderWords("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toEqual(home);
    expect(folderWords("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15")).toEqual(home);
  });
});

describe("a fit report from a server too old to send words", () => {
  it("keeps the colour of a spill or a refusal from its verdict alone", () => {
    expect(verdictOf({ ...base, verdict: "spills" }).k).toBe("spill");
    expect(verdictOf({ ...base, verdict: "refuse" }).k).toBe("no");
  });
});

const holder = (kind: GpuOccupant["kind"], label: string, gib: number): GpuOccupant => ({ kind, label, bytes: gib * GIB, protected: kind !== "chat-model" });

describe("who holds the card, in the app's words", () => {
  it("names Whisper, a program by its own name, and a holder nobody can name as Other", () => {
    expect(holderName({ kind: "whisper", label: "whisper-server" })).toBe("Whisper");
    expect(holderName({ kind: "other-app", label: "blender" })).toBe("blender");
    expect(holderName({ kind: "unknown", label: "pid 4312" })).toBe("Other");
  });
});

describe("why a model the card holds is slower right now", () => {
  it("names the first program it can name; the sentence names every holder as the memory rows do, unnamed ones as Other", () => {
    const why = slowReason({ inTheWay: [holder("unknown", "pid 4312", 3), holder("other-app", "blender", 2), holder("whisper", "whisper-server", 1)], spillRamBytes: 1.5 * GIB, measured: true });
    expect(why).toEqual({ short: "Slower now · blender in the way", way: "blender in the way", sentence: `Fits this card with blender (2.0${SP}GB), Whisper (1.0${SP}GB) and Other (3.0${SP}GB) off it. 1.5${SP}GB is in system memory now.` });
  });

  // Council climb-025 Q12: "Whisper (2.1 GB) and others (1.8 GB)" where the rows said Media Vault vision 1.8 GB and Other 0.2 GB.
  it("a program the rows name is never folded into others", () => {
    const why = slowReason({ inTheWay: [holder("whisper", "whisper-server", 2.1), holder("other-app", "Media Vault vision", 1.8), holder("unknown", "pid 9", 0.2)], spillRamBytes: 2.7 * GIB, measured: false });
    expect(why?.sentence).toBe(`Fits this card with Whisper (2.1${SP}GB), Media Vault vision (1.8${SP}GB) and Other (0.2${SP}GB) off it. Would use ~2.7${SP}GB of system memory, with 0.5${SP}GB of the card kept free.`);
    expect(why?.sentence).not.toContain("others");
  });

  it("says other programs when no holder in the way can be named", () => {
    const why = slowReason({ inTheWay: [holder("unknown", "pid 4312", 1), holder("unknown", "pid 977", 0.5)], spillRamBytes: 1 * GIB, measured: true });
    expect(why).toEqual({ short: "Slower now · other programs in the way", way: "other programs in the way", sentence: `Fits this card with other programs (1.5${SP}GB) off it. 1.0${SP}GB is in system memory now.` });
  });

  // Council climb-025 Q12: the card said "2.7 GB is in system memory now" beside "Not measured at 16k yet".
  it("a spill nobody measured is said as a prediction with ~; only a measured split is said in the present tense", () => {
    const why = slowReason({ inTheWay: [holder("whisper", "whisper-server", 2)], spillRamBytes: 2.7 * GIB, measured: false });
    expect(why?.sentence).toBe(`Fits this card with Whisper (2.0${SP}GB) off it. Would use ~2.7${SP}GB of system memory, with 0.5${SP}GB of the card kept free.`);
  });

  // council climb-025 Q12: the predicted spill was 0.5 GB more than need minus free, and nothing said why
  it("a predicted spill names the card's 0.5 GB reserve; a measured one is what the runtime reported, so it does not", () => {
    expect(slowReason({ inTheWay: [holder("whisper", "whisper-server", 2)], spillRamBytes: 2.7 * GIB, measured: false })?.sentence).toContain(`with 0.5${SP}GB of the card kept free.`);
    expect(slowReason({ inTheWay: [holder("whisper", "whisper-server", 2)], spillRamBytes: 2.7 * GIB, measured: true })?.sentence).not.toContain("kept free");
  });
});

const entry = (name: string, label: string, purpose: string): CatalogEntry => ({ name, label, purpose, downloadBytes: 6 * GIB, installed: false, recommended: true });

describe("a model's name and purpose", () => {
  it("takes the catalog's purpose for a model it lists, and has none for a model it does not", () => {
    const catalog = [entry("qwen3.5:9b", "Qwen 3.5 9B", "Everyday chat and writing")];
    expect(describeModel("qwen3.5:9b", catalog)).toEqual({ name: "Qwen 3.5 9B", purpose: "Everyday chat and writing" });
    expect(describeModel("gemma4:26b", catalog)).toEqual({ name: "Gemma 4 26B", purpose: "" });
    expect(describeModel("qwen3.5:9b", undefined).purpose).toBe("");
  });
});

describe("when a thread was last updated, in the sidebar", () => {
  const now = new Date(2026, 10, 12, 15, 0).getTime();
  it.each([
    ["half a minute ago", new Date(2026, 10, 12, 14, 59, 30).getTime(), "Today", "now"],
    ["five minutes ago", new Date(2026, 10, 12, 14, 55).getTime(), "Today", "5m"],
    ["just after midnight today", new Date(2026, 10, 12, 0, 30).getTime(), "Today", "14h"],
    ["last night", new Date(2026, 10, 11, 21, 5).getTime(), "Yesterday", "9:05 PM"],
    ["on Monday this week", new Date(2026, 10, 9, 10, 0).getTime(), "Previous 7 days", "Mon"],
    ["a week ago today", new Date(2026, 10, 5, 10, 0).getTime(), "Previous 7 days", "Thu"],
    ["eight days ago", new Date(2026, 10, 4, 12, 0).getTime(), "Older", "Nov 4"],
    ["early last year", new Date(2025, 0, 20, 12, 0).getTime(), "Older", "Jan 20"],
  ])("an update made %s sits under %s and reads %s", (_when, ms, group, ago) => {
    expect(when(ms, now)).toEqual({ group, ago });
  });
});

describe("the time on a user turn", () => {
  it("is the clock for a turn sent today, and the sidebar's short form for an older one", () => {
    const now = new Date(2026, 10, 12, 15, 0).getTime();
    expect(turnTime(new Date(2026, 10, 12, 14, 14).getTime(), now)).toBe("2:14 PM");
    expect(turnTime(new Date(2026, 10, 12, 0, 5).getTime(), now)).toBe("12:05 AM");
    expect(turnTime(new Date(2026, 10, 11, 21, 5).getTime(), now)).toBe("Yesterday");
    expect(turnTime(new Date(2026, 10, 9, 10, 0).getTime(), now)).toBe("Mon");
    expect(turnTime(new Date(2026, 10, 4, 12, 0).getTime(), now)).toBe("Nov 4");
  });
});

describe("a thread's title from its first message", () => {
  it("cuts a long first message at about 46 characters and ends it with an ellipsis", () => {
    expect(titleFrom("Can you help me plan a week of dinners for a family of four on a budget?")).toBe("Can you help me plan a week of dinners for a f…");
    expect(titleFrom("  Can you help me plan\n a week of dinners?  ")).toBe("Can you help me plan a week of dinners?");
    const fits = "Plan a week of dinners for four on a lean budget";
    expect(fits.length).toBe(48);
    expect(titleFrom(fits)).toBe(fits);
  });
});
