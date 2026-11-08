// Words and numbers the design fixes (shell.md F16, F34, F35, F62): one
// decimal for GB, three verdict labels, the friendly model name first.
import type { CatalogEntry, ContextSize, FitReport, Message, ModelInfo, PullProgress, Source } from "@gates-local/contracts";

export const CONTEXT_SIZES: readonly ContextSize[] = [8192, 16384, 32768, 65536];

const GIB = 1024 ** 3;

/** "6.6 GB": one decimal everywhere. The design's sizes are GiB (16303 MiB reads 15.9 GB). */
export function gb(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`;
}

/** A Library file's size: "223 bytes", "39 KB", "5 MB", "3.0 GB". */
export function fileSize(bytes: number): string {
  // Compared after rounding, so 1023.5 KB reads "1 MB", never "1024 KB" (LS-01).
  if (Math.round(bytes / 1024 ** 2) >= 1024) return gb(bytes);
  if (Math.round(bytes / 1024) >= 1024) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
}

/** A Library row's detail: "Refreshing…", the error, or "223 bytes · copied Nov 7". */
export function sourceDetail(src: Source): string {
  if (src.state === "refreshing") return "Refreshing…";
  if (src.state === "error") return src.detail ?? "Couldn't read it.";
  const parts: string[] = [];
  if (src.sizeBytes !== undefined) parts.push(fileSize(src.sizeBytes));
  if (src.snapshotAt !== undefined) parts.push(`copied ${new Date(src.snapshotAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`);
  return parts.join(" · ") || "Available";
}

/** 16384 → "16k", 512 → "512". */
export function k(numCtx: number): string {
  return numCtx < 1024 ? String(numCtx) : `${Math.round(numCtx / 1024)}k`;
}

/** The context `tag` runs at: the size asked for, never past the most it takes. */
export function ctxFor(numCtx: number, models: readonly { readonly name: string; readonly maxContext?: number }[] | undefined, tag: string | undefined): number {
  const max = models?.find((m) => m.name === tag)?.maxContext;
  return max === undefined ? numCtx : Math.min(numCtx, max);
}

/**
 * The GPU status says there is no GPU the app can read (no nvidia-smi, as on
 * a Windows or Linux machine with only Intel or AMD graphics): every model
 * is planned in system memory, and the words must not promise a GPU.
 */
export function noGpu(gpu: { readonly vendor: string } | undefined | "na"): boolean {
  return gpu !== undefined && gpu !== "na" && gpu.vendor === "none";
}

/**
 * Folder names as this machine spells them. The server listens on loopback
 * only, so the client's OS is the server's; the desktop window's user agent
 * names Windows there.
 */
export function folderWords(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): { models: string; appCopy: string; appModels: string } {
  return /\bWindows\b/.test(userAgent)
    ? { models: "%USERPROFILE%\\.ollama\\models", appCopy: "%LOCALAPPDATA%\\GatesLocal\\runtime\\ollama", appModels: "%LOCALAPPDATA%\\GatesLocal\\models" }
    : { models: "~/.ollama/models", appCopy: "~/.local/share/gates-local/runtime/ollama", appModels: "~/.local/share/gates-local/models" };
}

/** "1 model", "3 models". */
export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the app says when noGpu() holds. */
export const NO_GPU_TEXT = "No supported GPU was found (Gates Local reads NVIDIA cards), so models run in system memory. Replies are slower than on a GPU.";

export type VerdictKind = "gpu" | "spill" | "no";

/** A fit report in the design's words: chip (short), word (full label) and detail. */
export interface Verdict {
  readonly k: VerdictKind;
  readonly chip: string;
  readonly word: string;
  readonly detail: string;
  /** Spill or shortfall in bytes; 0 when it runs on the GPU. */
  readonly amt: number;
  readonly need: number;
  readonly avail: number;
  readonly measured: boolean;
}

export function verdictOf(r: FitReport): Verdict {
  const base = { need: r.needVramBytes, avail: r.freeVramBytes, measured: r.source === "measured" };
  if (r.verdict === "fits") return { ...base, k: "gpu", chip: "on GPU", word: "Runs on GPU", detail: "", amt: 0 };
  if (r.verdict === "spills") {
    return { ...base, k: "spill", chip: "system memory", word: "Uses system memory · slower", detail: `${gb(r.spillRamBytes)} in system memory`, amt: r.spillRamBytes };
  }
  const short = r.shortfallBytes ?? Math.max(0, r.needVramBytes - r.freeVramBytes);
  return { ...base, k: "no", chip: "not enough memory", word: `Not enough memory at ${k(r.numCtx)}`, detail: `needs ${gb(short)} more`, amt: short };
}

/**
 * What the context size not chosen would do, for the line under a context
 * control (F36b): "still runs on GPU; uses 2.5 GB more".
 */
export function otherCtxWords(cur: FitReport, other: FitReport): string {
  const ov = verdictOf(other);
  const cv = verdictOf(cur);
  let says = ov.k === "gpu" ? "runs on GPU" : ov.k === "spill" ? "uses system memory, slower" : "not enough memory";
  if (ov.k === cv.k) says = `still ${says}`;
  const d = other.needVramBytes - cur.needVramBytes;
  const tail = ov.k === "gpu" ? `uses ${gb(Math.abs(d))} ${d > 0 ? "more" : "less"}` : ov.detail;
  return `${says}; ${tail}`;
}

/** Tag words that read after the size ("Gemma 4 26B abliterated"); others read before it ("Qwen 3.5 VL 9B"). */
const AFTER_SIZE = new Set(["abliterated", "uncensored", "instruct", "chat", "coder"]);

/**
 * The friendly name for an Ollama tag when the catalog has no label:
 * "qwen3.5:9b" → "Qwen 3.5 9B", "qwen3.8-abliterated:27b" → "Qwen 3.8 27B abliterated".
 */
export function friendlyName(tag: string): string {
  const [base = tag, variant = ""] = tag.split(":");
  const parts = base.split("-");
  const head = parts[0] ?? base;
  const m = /^([a-z]+)(\d[\d.]*)$/i.exec(head);
  const family = m?.[1] ?? "";
  const lead = m ? `${family.charAt(0).toUpperCase()}${family.slice(1)} ${m[2] ?? ""}` : head;
  const before: string[] = [];
  const after: string[] = [];
  for (const p of parts.slice(1)) {
    if (AFTER_SIZE.has(p.toLowerCase())) after.push(p);
    else before.push(p.length <= 2 ? p.toUpperCase() : p);
  }
  const size = /^(\d+(?:\.\d+)?)([bm])\b/i.exec(variant);
  const sizeText = size ? `${size[1] ?? ""}${(size[2] ?? "").toUpperCase()}` : variant === "latest" ? "" : variant;
  return [lead, ...before, sizeText, ...after].filter((s) => s !== "").join(" ");
}

/** The name and purpose phrase for a tag: the catalog's when it has one. */
export function describeModel(tag: string, catalog: readonly CatalogEntry[] | undefined): { name: string; purpose: string } {
  const c = catalog?.find((e) => e.name === tag);
  return { name: c?.label ?? friendlyName(tag), purpose: c?.purpose ?? "" };
}

/** "Q4_K_M · 6.6 GB on disk" pieces for a model's tooltip. */
export function modelFacts(m: ModelInfo | undefined): { quant: string; disk: string } {
  return { quant: m?.quantization ?? "", disk: m ? `${gb(m.sizeBytes)} on disk` : "" };
}

/** The meta line under a finished reply: "Qwen 3.5 9B · 2.9 s to first token · 38 tok/s". */
export function replyMeta(name: string, msg: Message, firstTokenMs?: number): string {
  const parts = [name];
  if (firstTokenMs !== undefined) parts.push(`${(firstTokenMs / 1000).toFixed(1)} s to first token`);
  const speed = decodeSpeed(msg.stats);
  if (speed !== undefined) parts.push(`${speed} tok/s`);
  return parts.join(" · ");
}

/**
 * Tokens per second of decoding: completion tokens over Ollama's
 * eval_duration. durationMs is the whole call, model load and prompt
 * included, so it is only the fallback for replies saved before decode time
 * was kept.
 */
export function decodeSpeed(s: { completionTokens?: number; durationMs?: number; evalDurationMs?: number } | undefined): number | undefined {
  if (s?.completionTokens === undefined) return undefined;
  const ms = s.evalDurationMs ?? s.durationMs;
  return ms !== undefined && ms > 0 ? Math.round(s.completionTokens / (ms / 1000)) : undefined;
}

/** "2:14 PM". */
export function clock(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h % 12 || 12}:${m < 10 ? "0" : ""}${m} ${h < 12 ? "AM" : "PM"}`;
}

const DAY = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export type Group = "Today" | "Yesterday" | "Previous 7 days" | "Older";

/** The sidebar group and the short "ago" text for a thread's last update. */
export function when(ms: number, now = Date.now()): { group: Group; ago: string } {
  const today = startOfDay(now);
  if (ms >= today) {
    const mins = Math.floor((now - ms) / 60_000);
    return { group: "Today", ago: mins < 1 ? "now" : mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h` };
  }
  if (ms >= today - DAY) return { group: "Yesterday", ago: clock(ms) };
  const d = new Date(ms);
  if (ms >= today - 7 * DAY) return { group: "Previous 7 days", ago: WEEKDAYS[d.getDay()] ?? "" };
  return { group: "Older", ago: `${MONTHS[d.getMonth()] ?? ""} ${d.getDate()}` };
}

/** The time on a user turn: a clock today, else the sidebar's short form. */
export function turnTime(ms: number, now = Date.now()): string {
  const w = when(ms, now);
  return w.group === "Today" ? clock(ms) : w.group === "Yesterday" ? "Yesterday" : w.ago;
}

/** A thread title from its first message: about 46 characters, then an ellipsis. */
export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 48 ? `${t.slice(0, 46)}…` : t;
}

/** Seconds rounded up to 5 under a minute ("about 25 s"), whole minutes from there. */
function timeLeft(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds));
  const s = whole < 10 ? whole : Math.ceil(whole / 5) * 5;
  return s < 60 ? `${s} s` : `${Math.ceil(seconds / 60)} min`;
}

/**
 * The line under a download bar: bytes, speed, time left. Once every byte
 * is in, Ollama is verifying or writing the model, so the line names that
 * phase instead of a time worked out from download speed (G7-03).
 */
export function etaText(p: PullProgress): string {
  if (p.state === "verifying") return "Verifying the download";
  const total = p.totalBytes;
  if (total && p.completedBytes >= total) return "Finishing the download";
  const parts = [total ? `${(p.completedBytes / 1024 ** 3).toFixed(1)} of ${gb(total)}` : "Starting"];
  if (p.bytesPerSecond) {
    parts.push(`${Math.round(p.bytesPerSecond / 1e6)} MB/s`);
    if (total) parts.push(`about ${timeLeft((total - p.completedBytes) / p.bytesPerSecond)} left`);
  }
  return parts.join(" · ");
}
