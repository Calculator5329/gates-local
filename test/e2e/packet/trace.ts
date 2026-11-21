// Reads what a failed test's Playwright trace.zip already holds: the screencast
// frames, browser console errors, page errors and failed requests, all on the
// wall clock so they line up with the test's steps and the server's log.
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

/** One screencast frame: when it reached the screen and its JPEG bytes. */
export type Frame = { readonly at: number; readonly jpeg: () => Buffer };
/** A console error or warning, an uncaught page error, or a request that failed or answered 4xx/5xx. */
export type Note = { readonly at: number; readonly kind: "console" | "page error" | "request"; readonly text: string };
export type Trace = { readonly frames: readonly Frame[]; readonly notes: readonly Note[] };

/** The entries of a zip file by name, each read on demand (stored or deflated, no zip64). */
export function readZip(buf: Buffer): Map<string, () => Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file: no end of central directory");
  const entries = new Map<string, () => Buffer>();
  let at = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`zip central directory entry ${n} is damaged`);
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    entries.set(name, () => {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + size);
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`zip entry ${name} uses compression method ${method}`);
    });
  }
  return entries;
}

function lines(entry: (() => Buffer) | undefined): Record<string, unknown>[] {
  if (!entry) return [];
  return entry().toString("utf8").split("\n").flatMap(line => {
    if (line.trim() === "") return [];
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? [value as Record<string, unknown>] : [];
  });
}

const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const obj = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

/** Everything the reporter uses from one trace.zip; the runner's own test.trace holds no page events. */
export function readTrace(file: string): Trace {
  const zip = readZip(readFileSync(file));
  const frames: Frame[] = [];
  const notes: Note[] = [];
  for (const name of zip.keys()) {
    if (!name.endsWith(".trace") || name === "test.trace") continue;
    const events = lines(zip.get(name));
    const head = events.find(event => event["type"] === "context-options");
    const wall = num(head?.["wallTime"]) ?? 0;
    const mono = num(head?.["monotonicTime"]) ?? 0;
    const toWall = (time: unknown) => wall + ((num(time) ?? mono) - mono);
    for (const event of events) {
      const type = event["type"];
      if (type === "screencast-frame") {
        const resource = zip.get(`resources/${str(event["sha1"])}`);
        if (resource) frames.push({ at: num(event["frameSwapWallTime"]) ?? toWall(event["timestamp"]), jpeg: resource });
      } else if (type === "console" && (event["messageType"] === "error" || event["messageType"] === "warning")) {
        const where = obj(event["location"]);
        notes.push({ at: toWall(event["time"]), kind: "console", text: `${str(event["messageType"])}: ${str(event["text"])}${where["url"] ? ` (${str(where["url"])}:${String(where["lineNumber"] ?? "")})` : ""}` });
      } else if (type === "event" && event["method"] === "pageError") {
        const thrown = obj(obj(event["params"])["error"]);
        const error = obj(thrown["error"]);
        notes.push({ at: toWall(event["time"]), kind: "page error", text: error["message"] === undefined ? String(thrown["value"] ?? "") : `${str(error["name"]) || "Error"}: ${str(error["message"])}` });
      }
    }
  }
  for (const name of zip.keys()) {
    if (!name.endsWith(".network")) continue;
    for (const line of lines(zip.get(name))) {
      const snapshot = obj(line["snapshot"]);
      const request = obj(snapshot["request"]);
      const response = obj(snapshot["response"]);
      const status = num(response["status"]) ?? 0;
      const failure = str(response["_failureText"]);
      if (failure === "" && status > 0 && status < 400) continue;
      notes.push({ at: Date.parse(str(snapshot["startedDateTime"])), kind: "request", text: `${str(request["method"])} ${str(request["url"])}: ${failure || String(status)}` });
    }
  }
  frames.sort((a, b) => a.at - b.at);
  notes.sort((a, b) => a.at - b.at);
  return { frames, notes };
}
