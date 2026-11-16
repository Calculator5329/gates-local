import { NBSP, gb, k, type CatalogEntry, type ContextSize, type FitReport, type FitWords, type GpuOccupant, type Message, type ModelInfo, type PullProgress, type Source } from "@gates-local/contracts";

export { NBSP, gb, k };

export const CONTEXT_SIZES: readonly ContextSize[] = [8192, 16384, 32768, 65536];

const GIB = 1024 ** 3;

export function cardGb(bytes: number): string {
  return `${Math.round(bytes / GIB)}${NBSP}GB`;
}

export function shortAge(ms: number, now: number): string {
  const s = Math.floor((now - ms) / 1000);
  if (s < 60) return "now";
  const min = Math.floor(s / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 30) return `${Math.floor(d / 7)}w`;
  if (d < 365) return `${Math.floor(d / 30)}mo`;
  return `${Math.floor(d / 365)}y`;
}

export function fileSize(bytes: number): string {
  if (Math.round(bytes / 1024 ** 2) >= 1024) return gb(bytes);
  if (Math.round(bytes / 1024) >= 1024) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
}

export function sourceDetail(src: Source): string {
  if (src.state === "refreshing") return "Refreshing…";
  if (src.state === "error") return src.detail ?? "Couldn't read it.";
  const parts: string[] = [];
  if (src.sizeBytes !== undefined && src.kind !== "folder") parts.push(fileSize(src.sizeBytes));
  if (src.snapshotAt !== undefined) parts.push(`copied ${new Date(src.snapshotAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`);
  return parts.join(" · ");
}

export function ctxFor(numCtx: number, models: readonly { readonly name: string; readonly maxContext?: number }[] | undefined, tag: string | undefined): number {
  const max = models?.find((m) => m.name === tag)?.maxContext;
  return max === undefined ? numCtx : Math.min(numCtx, max);
}

export function noGpu(gpu: { readonly vendor: string } | undefined | "na"): boolean {
  return gpu !== undefined && gpu !== "na" && gpu.vendor === "none";
}

export function folderWords(userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent): { models: string; appCopy: string; appModels: string } {
  return /\bWindows\b/.test(userAgent)
    ? { models: "%USERPROFILE%\\.ollama\\models", appCopy: "%LOCALAPPDATA%\\GatesLocal\\runtime\\ollama", appModels: "%LOCALAPPDATA%\\GatesLocal\\models" }
    : { models: "~/.ollama/models", appCopy: "~/.local/share/gates-local/runtime/ollama", appModels: "~/.local/share/gates-local/models" };
}

export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const NO_GPU_TEXT = "No supported GPU was found (Gates Local reads NVIDIA cards). Replies are slower than on a GPU.";

export type VerdictKind = FitWords["k"];

export interface Verdict extends FitWords {
  readonly need: number;
  readonly avail: number;
  readonly measured: boolean;
}

const UNSAID: Record<FitReport["verdict"], VerdictKind> = { fits: "gpu", spills: "spill", refuse: "no" };

export function verdictOf(r: FitReport): Verdict {
  const words = r.words ?? { basis: "now", k: UNSAID[r.verdict], label: "", word: "", chip: "", detail: "", mark: "", short: "", amt: 0 };
  return { ...words, need: r.needVramBytes, avail: r.freeVramBytes, measured: r.source === "measured" };
}

export function holderName(o: Pick<GpuOccupant, "kind" | "label">): string {
  return o.kind === "whisper" ? "Whisper" : o.kind === "unknown" ? "Other" : o.label;
}

export interface SlowReason {
  readonly short: string;
  readonly sentence: string;
}

export function slowReason(slow: { readonly inTheWay: readonly GpuOccupant[]; readonly spillRamBytes: number } | undefined, tps?: string, said: readonly string[] = []): SlowReason | undefined {
  if (slow === undefined || slow.inTheWay.length === 0) return undefined;
  const first = slow.inTheWay.find((o) => o.kind !== "unknown");
  const restBytes = slow.inTheWay.reduce((n, o) => (o === first ? n : n + o.bytes), 0);
  const who = first === undefined ? "other programs" : holderName(first);
  const off = first === undefined ? `other programs (${gb(restBytes)})` : restBytes > 0 ? `${who} (${gb(first.bytes)}) and others (${gb(restBytes)})` : `${who} (${gb(first.bytes)})`;
  const slower = tps === undefined ? "Slower now" : `Slower now, ${tps}`;
  return {
    short: first !== undefined && said.includes(first.label) ? slower : `${slower} · ${who} in the way`,
    sentence: `Fits this card with ${off} off it. ${gb(slow.spillRamBytes)} is in system memory now.`,
  };
}

const AFTER_SIZE = new Set(["abliterated", "uncensored", "instruct", "chat", "coder"]);

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

export function describeModel(tag: string, catalog: readonly CatalogEntry[] | undefined): { name: string; purpose: string } {
  const c = catalog?.find((e) => e.name === tag);
  return { name: c?.label ?? friendlyName(tag), purpose: c?.purpose ?? "" };
}

export function modelFacts(m: ModelInfo | undefined): { quant: string; disk: string } {
  return { quant: m?.quantization ?? "", disk: m ? `${gb(m.sizeBytes)} on disk` : "" };
}

export function replyWait(waitMs: number | undefined): string | undefined {
  return waitMs === undefined || waitMs < 1000 ? undefined : `${(waitMs / 1000).toFixed(1)} s`;
}

export function replyMeta(msg: Pick<Message, "stats">, workMs?: number): string {
  const parts: string[] = [];
  if (workMs !== undefined && workMs >= 50) parts.push(`${(workMs / 1000).toFixed(1)} s`);
  const speed = decodeSpeed(msg.stats);
  if (speed !== undefined) parts.push(`${speed} tok/s`);
  return parts.join(" · ");
}

export function decodeSpeed(s: { completionTokens?: number; durationMs?: number; evalDurationMs?: number } | undefined): number | undefined {
  if (s?.completionTokens === undefined) return undefined;
  const ms = s.evalDurationMs ?? s.durationMs;
  return ms !== undefined && ms > 0 ? Math.round(s.completionTokens / (ms / 1000)) : undefined;
}

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

export function turnTime(ms: number, now = Date.now()): string {
  const w = when(ms, now);
  return w.group === "Today" ? clock(ms) : w.group === "Yesterday" ? "Yesterday" : w.ago;
}

export function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 48 ? `${t.slice(0, 46)}…` : t;
}

export function timeLeft(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds));
  const s = whole < 10 ? whole : Math.ceil(whole / 5) * 5;
  return s < 60 ? `${s} s` : `${Math.ceil(seconds / 60)} min`;
}

export function etaText(p: PullProgress, { speed = true }: { speed?: boolean } = {}): string {
  if (p.state === "verifying") return "Verifying the download";
  const total = p.totalBytes;
  if (total && p.completedBytes >= total) return "Finishing the download";
  // external: Ollama names a pull's files one by one; the total is unknown till then
  const parts = [total ? `${(p.completedBytes / 1024 ** 3).toFixed(1)} of ${gb(total)}` : p.completedBytes > 0 ? `${gb(p.completedBytes)} so far` : "Starting"];
  if (p.bytesPerSecond) {
    if (speed) parts.push(`${Math.round(p.bytesPerSecond / 1e6)} MB/s`);
    if (total) parts.push(`about ${timeLeft((total - p.completedBytes) / p.bytesPerSecond)} left`);
  }
  return parts.join(" · ");
}
