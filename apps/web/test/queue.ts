// The messages that wait, for tests. A window holds one map of the server's records; a test names
// what it expects of a waiting message in a few flags (on hold, going next, open in a composer),
// read here from that map, and seeds the map from rows written the same way.
import type { AttachedFile, ImageChoice, Reply } from "@gates-local/contracts";
import type { FakeServer } from "./harness.ts";

/** Every turn.start is answered with a turn of its own, and its question saved under the id the send named, as the app's server does. */
export function answerSends(server: Pick<FakeServer, "answer">): void {
  let turn = 0;
  server.answer("turn.start", (p) => ({ turnId: `sent-${++turn}`, userMessage: { id: p.messageId ?? `asked-${turn}`, threadId: p.threadId, role: "user", content: p.content, createdAt: 1 } }));
}

/** A message the server holds for a chat, once this window's records show its row. */
export async function heldOnServer(server: Pick<FakeServer, "queue">, shown: () => { readonly replies: ReadonlyMap<string, Reply> }, row: { readonly id: string; readonly threadId: string; readonly text: string; readonly messageId?: string }): Promise<void> {
  server.queue.add({ messageId: `m-${row.id}`, ...row, at: 1, held: true, waitFor: "reply" });
  for (let i = 0; i < 200 && !shown().replies.has(row.id); i++) await new Promise((r) => setTimeout(r, 0));
  if (!shown().replies.has(row.id)) throw new Error(`the server's row ${row.id} never came`);
}

type Waiting = Extract<Reply, { readonly stage: "queued" | "held" | "next" | "editing" }>;

/** One waiting message as a test names it. */
export interface QueuedRow {
  readonly id: string;
  readonly threadId: string;
  readonly text: string;
  readonly at: number;
  readonly messageId?: string;
  readonly images?: readonly string[];
  readonly files?: readonly AttachedFile[];
  readonly model?: string;
  readonly draw?: ImageChoice;
  /** What it was typed behind: setup, the first download, or a reply. */
  readonly waitFor: "setup" | "download" | "reply";
  /** It goes only when the person says so. */
  readonly held?: true;
  /** Held behind a failed reply the server runs once more ("running"), or whose second try failed too ("failed"). */
  readonly retry?: "running" | "failed";
  /** Send now was pressed: it goes first. */
  readonly now?: true;
  /** Open in a composer, in this window or another. */
  readonly editing?: true;
  /** The server's refusal that put it on hold. */
  readonly why?: { readonly code: string; readonly message: string };
}

type Flags = Pick<QueuedRow, "waitFor" | "held" | "retry" | "now" | "why">;

function flags(r: Waiting | Extract<Waiting, { readonly stage: "editing" }>["back"], wait: Extract<Waiting, { readonly stage: "queued" }>["waitFor"]): Flags {
  if (r.stage === "next") return { waitFor: "reply", now: true };
  if (r.stage === "held") {
    const why = r.held.why === "refused" ? { why: { code: r.held.code, message: r.held.message } } : {};
    return { waitFor: "reply", held: true, ...(r.held.why === "failed" ? { retry: "failed" as const } : {}), ...why };
  }
  if (wait?.what === "setup" || wait?.what === "download") return { waitFor: wait.what };
  return wait?.what === "retry" ? { waitFor: "reply", held: true, retry: "running" } : { waitFor: "reply" };
}

const WAITING: ReadonlySet<string> = new Set(["queued", "held", "next", "editing"]);

/** The waiting messages in the order the tray shows them: one going next first. */
export function queuedOf(s: { readonly replies: ReadonlyMap<string, Reply> }): QueuedRow[] {
  const rows = [...s.replies.values()].filter((r): r is Waiting => WAITING.has(r.stage));
  return [...rows.filter((r) => r.stage === "next"), ...rows.filter((r) => r.stage !== "next")].map((r) => ({
    id: r.id, threadId: r.threadId, text: r.text, at: r.at, messageId: r.messageId,
    ...(r.images === undefined ? {} : { images: r.images }),
    ...(r.files === undefined ? {} : { files: r.files }),
    ...(r.model === undefined ? {} : { model: r.model }),
    ...(r.draw === undefined ? {} : { draw: r.draw }),
    ...(r.stage === "editing" ? { ...flags(r.back, undefined), editing: true as const } : flags(r, r.stage === "queued" ? r.waitFor : undefined)),
  }));
}

/** The record map a window would hold for these rows, numbered in order from `rev`. */
export function repliesOf(rows: readonly (Omit<QueuedRow, "messageId" | "at"> & { readonly messageId?: string; readonly at?: number })[], rev = 1): Map<string, Reply> {
  const out = new Map<string, Reply>();
  for (const [i, q] of rows.entries()) {
    const common = {
      id: q.id, threadId: q.threadId, rev: rev + i, messageId: q.messageId ?? `m-${q.id}`, text: q.text, at: q.at ?? 0,
      ...(q.images === undefined ? {} : { images: [...q.images] }),
      ...(q.files === undefined ? {} : { files: [...q.files] }),
      ...(q.model === undefined ? {} : { model: q.model }),
      ...(q.draw === undefined ? {} : { draw: q.draw }),
    };
    const held = q.why !== undefined ? { why: "refused" as const, ...q.why } : { why: q.retry === "failed" ? "failed" as const : "stopped" as const };
    const record: Waiting = q.now === true ? { ...common, stage: "next" }
      : q.retry === "running" ? { ...common, stage: "queued", waitFor: { what: "retry", reply: "t-retry" } }
      : q.held === true ? { ...common, stage: "held", held }
      : { ...common, stage: "queued", ...(q.waitFor === "reply" ? {} : { waitFor: { what: q.waitFor } }) };
    out.set(q.id, q.editing !== true ? record
      : { ...common, stage: "editing", by: "elsewhere", back: record.stage === "held" ? { stage: "held", held: record.held } : record.stage === "next" ? { stage: "next" } : { stage: "queued" } });
  }
  return out;
}
