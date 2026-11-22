// The Update model's two tables, read from the real code in packages/update/src:
// what a start does (`decideCheckoutStart()` in checkout-start.ts) and how admission answers
// (`createUpdateAdmission()` in admission.ts, driven with a clock this file moves).
import { mock } from "node:test";
import { HANDOFF_GRACE_MS, createUpdateAdmission, type UpdateAdmission } from "../../packages/update/src/admission.ts";
import { decideCheckoutStart } from "../../packages/update/src/checkout-start.ts";
import { INSTALLED_APPROVAL_MS } from "../../packages/update/src/installed/transaction.ts";
import type { Transaction } from "../../packages/update/src/transaction.ts";
import { bool, moduleText, record, set, text } from "../tla.ts";

const TOKEN = "this-launch";
const MOVE = {
  channel: "main", branch: "main", changes: 1,
  from: { commit: "a".repeat(40), label: "the old version" },
  to: { commit: "b".repeat(40), label: "the new version" },
} as const;

/** The saved update a start can find, under the names the model uses for it. */
const SAVED: Readonly<Record<string, Transaction | null>> = {
  none: null,
  forward: { ...MOVE, phase: "forward" },
  launch_token: { ...MOVE, phase: "launch", startupToken: TOKEN },
  launch_plain: { ...MOVE, phase: "launch" },
  back: { ...MOVE, phase: "back", step: "build-web", reason: "the build failed" },
};

/** `StartCode[saved][lock][tried][token]`: the kind `decideCheckoutStart()` answers with. */
function startTable(): { readonly text: string; readonly starts: number } {
  let starts = 0;
  const saved: Record<string, string> = {};
  for (const [name, transaction] of Object.entries(SAVED)) {
    const lock: Record<string, string> = {};
    for (const [lockName, updating] of [["updating", true], ["idle", false]] as const) {
      const tried: Record<string, string> = {};
      for (const [triedName, wasTried] of [["tried", true], ["fresh", false]] as const) {
        const token: Record<string, string> = {};
        for (const [tokenName, carried] of [["none", undefined], ["match", TOKEN]] as const) {
          token[tokenName] = text(decideCheckoutStart({ updating, transaction, token: carried, tried: wasTried, left: null }).kind);
          starts += 1;
        }
        tried[triedName] = record(token);
      }
      lock[lockName] = record(tried);
    }
    saved[name] = record(lock);
  }
  return { text: record(saved, ",\n    "), starts };
}

const EVENTS = ["reserve", "commit_default", "commit_long", "cancel_window", "cancel_main", "disconnect", "timer", "close"] as const;
type Event = typeof EVENTS[number];
/** One step of a replay: the event, and for `timer` how far the clock moves. */
interface Step { readonly event: Event; readonly ms: number }

const TARGET = "c".repeat(40);
const MAINS_KEY = "the-key-main-asked-for";
/** How far ahead a wait is looked for, and in what steps. Longer than any wait the code sets. */
const LOOK_AHEAD_MS = 120_000;
const LOOK_STEP_MS = 1_000;

interface Run { readonly admission: UpdateAdmission; window: string | undefined; connection: AbortController | undefined }

function apply(run: Run, step: Step): boolean {
  const a = run.admission;
  switch (step.event) {
    case "reserve":
      try { run.window = a.reserve(TARGET); return true; } catch { return false; }
    case "commit_default":
    case "commit_long": {
      if (run.window === undefined) return false;
      const connection = new AbortController();
      const key = step.event === "commit_long"
        ? a.commit(run.window, TARGET, MAINS_KEY, connection.signal, INSTALLED_APPROVAL_MS)
        : a.commit(run.window, TARGET, MAINS_KEY, connection.signal);
      if (key !== null) run.connection = connection;
      return key !== null;
    }
    case "cancel_window":
      return run.window !== undefined && a.cancel(run.window);
    case "cancel_main":
      return a.cancel(MAINS_KEY);
    case "disconnect":
      if (run.connection === undefined || run.connection.signal.aborted) return false;
      run.connection.abort();
      return true;
    case "timer":
      if (step.ms === 0) return false;
      mock.timers.tick(step.ms);
      return true;
    case "close":
      a.close();
      return true;
  }
}

/** Plays the steps on a fresh admission with the clock stopped, and says whether the last one was taken. */
function play(path: readonly Step[]): { readonly run: Run; readonly ok: boolean } {
  mock.timers.reset();
  mock.timers.enable({ apis: ["setTimeout"] });
  const run: Run = { admission: createUpdateAdmission(), window: undefined, connection: undefined };
  let ok = true;
  for (const step of path) ok = apply(run, step);
  return { run, ok };
}

/** How long until the held admission lets work in by itself; 0 when no clock is running for it. */
function waitOf(run: Run): number {
  if (!run.admission.installing()) return 0;
  for (let ms = LOOK_STEP_MS; ms <= LOOK_AHEAD_MS; ms += LOOK_STEP_MS) {
    mock.timers.tick(LOOK_STEP_MS);
    if (!run.admission.installing()) return ms;
  }
  return 0;
}

interface Seen { readonly key: string; readonly admits: boolean; readonly wait: number }

/** What the code shows of itself after the path. Each question is asked of its own replay, since asking changes the answer. */
function look(path: readonly Step[]): Seen {
  const admits = ((a) => { try { a.admit(); return true; } catch { return false; } })(play(path).run.admission);
  const held = play(path).run.admission.installing();
  const wait = waitOf(play(path).run);
  if (admits) return { key: "open", admits, wait };
  if (!held) return { key: "shut", admits, wait };
  const byWindow = ((r) => r.window !== undefined && r.admission.cancel(r.window))(play(path).run);
  const byMain = play(path).run.admission.cancel(MAINS_KEY);
  const lost = play(path).run;
  lost.connection?.abort();
  // A hold no key opens is what close() leaves; the model asks a closed admission only whether it lets work in.
  if (!byWindow && !byMain) return { key: "shut", admits, wait: 0 };
  return { key: `held_${byWindow ? "window" : "main"}_wait${wait}_lost${waitOf(lost)}`, admits, wait };
}

/** How many different ways into one admission state are each given every event, to show the name decides the answer. */
const KEPT_PER_STATE = 3;

interface Cell { readonly next: string; readonly ok: boolean }

export interface UpdateTable { readonly module: string; readonly starts: number; readonly states: number; readonly steps: number }

/** The module `UpdateCode` the Update model extends. Throws when two ways into one admission state answer an event differently. */
export function updateTable(): UpdateTable {
  const start = look([]);
  const seen = new Map<string, Seen>([[start.key, start]]);
  const rows = new Map<string, Map<Event, Cell>>();
  const kept = new Map<string, number>();
  const todo: (readonly Step[])[] = [[]];
  let steps = 0;
  try {
    while (todo.length > 0) {
      const path = todo.shift()!;
      const at = look(path);
      const reps = kept.get(at.key) ?? 0;
      if (reps >= KEPT_PER_STATE) continue;
      kept.set(at.key, reps + 1);
      const row = rows.get(at.key) ?? new Map<Event, Cell>();
      rows.set(at.key, row);
      for (const event of EVENTS) {
        const next = [...path, { event, ms: event === "timer" ? at.wait : 0 }];
        const to = look(next);
        if (at.key === "shut" && to.key !== "shut") {
          throw new Error(`packages/update/src/admission.ts: after close(), ${event} left the closed state (after ${path.map((s) => s.event).join(", ")}). The model takes close() as final.`);
        }
        const cell: Cell = { next: to.key, ok: at.key !== "shut" && play(next).ok };
        const earlier = row.get(event);
        if (earlier !== undefined && (earlier.next !== cell.next || earlier.ok !== cell.ok)) {
          throw new Error(
            `packages/update/src/admission.ts: two ways into the state the model calls ${at.key} answer ${event} differently `
            + `(${JSON.stringify(earlier)} and ${JSON.stringify(cell)}, the second after ${path.map((s) => s.event).join(", ")}). `
            + "look() in model/update/table.ts no longer tells apart what the code tells apart.",
          );
        }
        if (earlier === undefined) steps += 1;
        row.set(event, cell);
        if (!seen.has(to.key)) seen.set(to.key, to);
        todo.push(next);
      }
    }
  } finally {
    mock.timers.reset();
  }
  const sorted = [...seen].toSorted(([a], [b]) => a.localeCompare(b));
  const each = (value: (s: Seen) => string): string => record(Object.fromEntries(sorted.map(([k, s]) => [k, value(s)])), ",\n    ");
  const started = startTable();
  const module = moduleText("UpdateCode", "model/update/table.ts", ["Naturals"], {
    StartCode: started.text,
    AdmFree: text(start.key),
    AdmStates: set(sorted.map(([k]) => text(k))),
    AdmAdmits: each((s) => bool(s.admits)),
    AdmWait: each((s) => String(s.wait)),
    AdmStep: record(Object.fromEntries(sorted.map(([k]) => [k, record(Object.fromEntries(
      EVENTS.map((e) => { const c = rows.get(k)!.get(e)!; return [e, record({ next: text(c.next), ok: bool(c.ok) })]; }),
    ), ",\n      ")])), ",\n    "),
    Deadline: record({ checkout: String(HANDOFF_GRACE_MS), installed: String(INSTALLED_APPROVAL_MS) }),
  });
  return { module, starts: started.starts, states: seen.size, steps };
}
