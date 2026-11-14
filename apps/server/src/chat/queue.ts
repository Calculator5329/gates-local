// The messages waiting to be sent, kept by the server: every window and the phone see one queue,
// a reload keeps it, and the server sends it (app.ts pumps it). This file is the queue's rules and
// its file on disk; it starts nothing itself. The rules are the ones the window's queue had:
// oldest first, one reply at a time, never past a message on hold or open in a composer unless
// Send now asked for it, and a stopped or failed reply holds what waited behind it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as Result from "effect/Result";
import * as S from "effect/Schema";
import { QueuedMessage } from "@gates-local/contracts";

export type Entry = QueuedMessage;
export type QueuePatch = Partial<Pick<Entry, "text" | "images" | "files" | "messageId" | "model">> & {
  readonly editing?: boolean;
  readonly now?: true;
  readonly stopOthers?: true;
  readonly stopTurns?: readonly string[];
  readonly held?: true;
};
export type Why = NonNullable<Entry["why"]>;

/** How the reply a thread's queue waited behind ended. */
export type ThreadEnd = "done" | "stopped" | "failed-again";

/** What the server has now, for the next send. */
export interface Ready {
  /** Ollama is ready and a chat model is installed: a chat message can go (a picture needs neither). */
  readonly chat: boolean;
  /** A reply is running, or starting, in some chat. */
  readonly anyTurn: boolean;
  /** The chats with a reply running or starting. */
  readonly busy: ReadonlySet<string>;
}

export interface Queue {
  list(): readonly Entry[];
  /** Appended; an id already queued changes nothing. */
  add(entry: Entry): void;
  /** Undefined when there is no such entry; "sending" when its turn has started. */
  change(id: string, patch: QueuePatch): "ok" | "sending" | undefined;
  remove(id: string): boolean;
  /** The entry to send now, if any. */
  next(ready: Ready): Entry | undefined;
  /** The server started a turn for it. */
  sending(id: string, turnId: string): void;
  /** A turn's start saved this message: its entry has gone out. */
  started(messageId: string): void;
  /** The turn started for an entry ended before its start: it goes back to its place, on hold, with why; what waited behind it in its chat holds too. */
  refused(turnId: string, why: Why): boolean;
  /** Refused before any turn was taken for it: the same, in one change. */
  turnless(id: string, why: Why): void;
  /** A reply in this chat ended: what waited behind it goes on, or holds. */
  ended(threadId: string, how: ThreadEnd): void;
  /** The reply failed and the server is running it once more: what waits behind it holds until that attempt ends. */
  retrying(threadId: string): void;
  dropThread(threadId: string): void;
}

const decodeEntry = S.decodeUnknownResult(QueuedMessage);

/** Without the keys: the entry as it is with those fields unset. */
function without(e: Entry, ...keys: (keyof Entry)[]): Entry {
  const out: Record<string, unknown> = { ...e };
  for (const k of keys) delete out[k];
  return out as Entry;
}

/** Not open in a composer and not on its way. */
const free = (x: Entry) => x.editing !== true && x.sending === undefined;

/** A queued message that goes out on its own once this chat's reply ends. */
const waitsBehind = (threadId: string) => (q: Entry) => q.threadId === threadId && q.waitFor === "reply" && q.now !== true && q.sending === undefined;

/**
 * `file`: where it is kept; undefined keeps it in memory only (tests, a server with no data
 * folder). `changed` hears the whole list after every change. A queue read from disk is the one a
 * closed app left: nothing in it goes on its own, as the window's restored queue did.
 */
export function createQueue({ file, changed, log }: { file?: string | undefined; changed: (list: readonly Entry[]) => void; log: (line: string) => void }): Queue {
  let entries: Entry[] = file === undefined ? [] : read(file, log);

  const set = (next: Entry[]) => {
    if (next.length === entries.length && next.every((e, i) => e === entries[i])) return;
    entries = next;
    if (file !== undefined) {
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, JSON.stringify({ version: 1, entries }));
        renameSync(tmp, file);
      } catch (e) {
        log(`queue not saved: ${(e as Error).message}`);
      }
    }
    changed(entries);
  };
  const map = (f: (q: Entry) => Entry) => set(entries.map((q) => {
    const n = f(q);
    return JSON.stringify(n) === JSON.stringify(q) ? q : n;
  }));
  const putBack = (q: Entry, why: Why) => {
    const waiting = waitsBehind(q.threadId);
    // a reply, even if it waited for setup: that wait is over, and Send now on this row is how it goes
    map((x) => (x === q ? { ...without(x, "sending", "now", "stopOthers", "stopTurns"), waitFor: "reply", held: true, why } : waiting(x) ? { ...x, held: true } : x));
  };

  return {
    list: () => entries,
    add(entry) {
      if (entries.some((q) => q.id === entry.id || q.messageId === entry.messageId)) return;
      set([...entries, without(entry, "sending", "editing")]);
    },
    change(id, patch) {
      const q = entries.find((x) => x.id === id);
      if (q === undefined) return undefined;
      if (q.sending !== undefined) return "sending";
      const { editing, now, stopOthers, stopTurns, held, ...words } = patch;
      let n: Entry = { ...q, ...words };
      if (editing === true) n = { ...n, editing: true };
      if (editing === false) n = without(n, "editing");
      // the person stopped the reply it waited behind
      if (held === true && n.now !== true) n = { ...without(n, "retry"), held: true };
      // Send now: its hold lifted, it goes first, as soon as its chat has no reply running; its place is kept for a refusal
      if (now === true) n = { ...without(n, "held", "retry", "why", "editing", "stopOthers", "stopTurns"), now: true, ...(stopOthers === true ? { stopOthers, ...(stopTurns === undefined ? {} : { stopTurns }) } : {}) };
      set(entries.map((x) => (x.id === id ? n : x)));
      return "ok";
    },
    remove(id) {
      const q = entries.find((x) => x.id === id);
      if (q === undefined || q.sending !== undefined) return false;
      set(entries.filter((x) => x.id !== id));
      return true;
    },
    next({ chat, anyTurn, busy }) {
      // a Send now first, and nothing overtakes it while it waits for its chat
      const q = entries.find((x) => free(x) && x.now === true) ?? entries.find((x) => free(x) && x.held !== true);
      if (q === undefined) return undefined;
      if (q.draw === undefined && !chat) return undefined;
      // Send now waits only for its own chat; the rest go one reply at a time
      if (q.now === true) return busy.has(q.threadId) ? undefined : q;
      return anyTurn ? undefined : q;
    },
    sending(id, turnId) {
      map((q) => (q.id === id ? { ...without(q, "why"), sending: turnId } : q));
    },
    started(messageId) {
      if (entries.some((q) => q.messageId === messageId)) set(entries.filter((q) => q.messageId !== messageId));
    },
    refused(turnId, why) {
      const q = entries.find((x) => x.sending === turnId);
      if (q === undefined) return false;
      putBack(q, why);
      return true;
    },
    turnless(id, why) {
      const q = entries.find((x) => x.id === id && x.sending === undefined);
      if (q !== undefined) putBack(q, why);
    },
    ended(threadId, how) {
      const waiting = waitsBehind(threadId);
      map((q) => {
        if (!waiting(q)) return q;
        if (how === "done") return q.retry === "running" ? without(q, "held", "retry") : q;
        if (how === "failed-again") return { ...q, held: true, retry: "failed" };
        return { ...without(q, "retry"), held: true };
      });
    },
    retrying(threadId) {
      const waiting = waitsBehind(threadId);
      map((q) => (waiting(q) ? { ...q, held: true, retry: "running" } : q));
    },
    dropThread(threadId) {
      if (entries.some((q) => q.threadId === threadId && q.sending === undefined)) set(entries.filter((q) => q.threadId !== threadId || q.sending !== undefined));
    },
  };
}

/** The queue a closed app left: every entry on hold, none open in a composer or on its way. */
function read(file: string, log: (line: string) => void): Entry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as { code?: unknown }).code !== "ENOENT") log(`queue not read: ${(e as Error).message}`);
    return [];
  }
  const list = typeof raw === "object" && raw !== null && Array.isArray((raw as { entries?: unknown }).entries) ? (raw as { entries: unknown[] }).entries : [];
  const out: Entry[] = [];
  for (const item of list) {
    const r = decodeEntry(item);
    if (Result.isFailure(r)) {
      log("queue: an unreadable entry was left out");
      continue;
    }
    const q = r.success;
    out.push({ ...without(q, "sending", "editing", "now", "stopOthers", "stopTurns", "retry"), ...(q.waitFor === "reply" ? {} : { waitFor: "reply" }), held: true });
  }
  return out;
}
