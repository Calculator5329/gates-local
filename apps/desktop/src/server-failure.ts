// Kept diagnostics: at most five 64 KiB reports, including escaped JSON bytes.
// Only this feature's generated, single-link regular files are rotated.
import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { CrashReason } from "./supervisor-state.ts";

const MAX_BYTES = 64 * 1024;
const MAX_REPORTS = 5;
const FORMAT = "gates-local-server-failure-v1";
const NAME = /^server-failure-\d{13}-[a-f0-9]{12}\.json$/;
const REDACTED = "[redacted]";
const TRUNCATED = "[...TRUNCATED...] ";
const lines = (text: string) => text === "" ? [] : text.split("\n");

/** Redact before cutting, including any token that crosses the eventual cut. */
function boundedText(text: string, token: string | undefined, limit: number, encode: (value: string) => string = JSON.stringify): string {
  const clean = token ? text.replaceAll(token, REDACTED) : text;
  const fits = (value: string) => Buffer.byteLength(encode(value), "utf8") <= limit;
  if (fits(clean)) return clean;
  const tail = (offset: number) => {
    // Neither UTF-16 pairs nor replacement markers should be cut in half.
    const unit = clean.charCodeAt(offset);
    if (unit >= 0xdc00 && unit <= 0xdfff) offset++;
    const marker = clean.lastIndexOf(REDACTED, offset);
    if (marker >= 0 && offset > marker && offset < marker + REDACTED.length) offset = marker + REDACTED.length;
    return TRUNCATED + clean.slice(offset);
  };
  let low = 0;
  let high = clean.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (fits(tail(mid))) high = mid;
    else low = mid + 1;
  }
  return tail(low);
}

/** Also cap retained in-memory lines and console forwarding, before reporting. */
export function boundedServerOutput(line: string, token: string): string {
  return boundedText(line, token, MAX_BYTES);
}

type Exit = { readonly code: number | null; readonly signal: string | null };
interface Failure {
  readonly entry: string;
  readonly execPath: string;
  readonly pid: number | null;
  readonly reason: CrashReason;
  readonly exit: Exit | null;
  readonly stderrTail: readonly string[];
  readonly stdoutTail: readonly string[];
}

function boundedReason(reason: CrashReason, token: string | undefined): CrashReason {
  if (reason.kind === "bad-ready") return { ...reason, line: boundedText(reason.line, token, 2048) };
  if (reason.kind === "spawn-error") return { ...reason, message: boundedText(reason.message, token, 2048) };
  return reason;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const regular = (stat: Stats) => stat.isFile() && stat.nlink === 1;

/** Recognize new reports and the previous writer's header without reading a huge legacy payload. */
function ownReport(file: string, stat: Stats): boolean {
  const fd = openSync(file, "r");
  try {
    const opened = fstatSync(fd);
    if (!regular(opened) || !same(opened, stat)) return false;
    // Long enough to reach execPath after any real entry path.
    const prefix = Buffer.alloc(8 * 1024);
    const bytes = readSync(fd, prefix, 0, prefix.length, 0);
    const text = prefix.toString("utf8", 0, bytes);
    return text.startsWith(`{\n  "format": "${FORMAT}",\n`)
      || /^\{\n  "time": "\d{4}-\d{2}-\d{2}T[\d:.]+Z",\n  "entry": "(?:[^"\\]|\\.)*",\n  "execPath": "/.test(text);
  } finally {
    closeSync(fd);
  }
}

function reserveReportSlot(dataDir: string): void {
  const reports = readdirSync(dataDir).flatMap(name => {
    if (!NAME.test(name)) return [];
    const file = join(dataDir, name);
    try {
      const stat = lstatSync(file);
      return regular(stat) && ownReport(file, stat) ? [{ file, name, stat }] : [];
    } catch (error) {
      if (missing(error)) return [];
      throw error;
    }
  }).toSorted((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || b.name.localeCompare(a.name));
  let kept = 0;
  for (const report of reports) {
    if (report.stat.size <= MAX_BYTES && kept < MAX_REPORTS - 1) {
      kept++;
      continue;
    }
    try {
      const current = lstatSync(report.file);
      if (regular(current) && same(current, report.stat)) unlinkSync(report.file);
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
}

export function writeServerFailureReport(dataDir: string, failure: Failure, token?: string): string {
  const fields = {
    format: FORMAT,
    time: new Date().toISOString(),
    entry: boundedText(failure.entry, token, 2048),
    execPath: boundedText(failure.execPath, token, 2048),
    pid: failure.pid,
    reason: boundedReason(failure.reason, token),
    exit: failure.exit,
  };
  const stdoutTail = lines(boundedText(failure.stdoutTail.join("\n"), token, 8 * 1024, text => JSON.stringify(lines(text), null, 2)));
  const encode = (text: string) => JSON.stringify({ ...fields, stderrTail: lines(text), stdoutTail }, null, 2) + "\n";
  const stderr = boundedText(failure.stderrTail.join("\n"), token, MAX_BYTES, encode);
  const report = encode(stderr);
  if (Buffer.byteLength(report, "utf8") > MAX_BYTES) throw new Error("server failure metadata exceeds the report byte limit");
  const file = join(dataDir, `server-failure-${Date.now()}-${randomBytes(6).toString("hex")}.json`);
  // Rotate first: if deletion is refused, do not grow storage with a new file.
  // Oversized legacy reports are removed too, so old output cannot evade the cap.
  reserveReportSlot(dataDir);
  writeFileSync(file, report, { flag: "wx", mode: 0o600 });
  return file;
}
