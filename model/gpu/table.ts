// The GPU model's lease, read from the real createGpuLease() in apps/server/src/gpu/lease.ts.
// Two chats and one picture ask, let go and give up waiting in every order; each result is one row.
import { createGpuLease, isSharedKind, type GpuJobKind } from "../../apps/server/src/gpu/lease.ts";
import { moduleText, record, set, text, tuple } from "../tla.ts";

const ACTORS = { c1: "chat", c2: "chat", p: "image" } as const satisfies Readonly<Record<string, GpuJobKind>>;
type Actor = keyof typeof ACTORS;
const NAMES = Object.keys(ACTORS) as readonly Actor[];

/** Every kind of job the lease takes. `false` is one the model leaves out; a new kind fails the typecheck here until it is placed. */
const MODELLED: Readonly<Record<GpuJobKind, boolean>> = { chat: true, image: true, bench: false, dream: false };

type Op = "ask" | "release" | "abort";
interface Step { readonly op: Op; readonly actor: Actor }
interface State { readonly holds: readonly Actor[]; readonly waits: readonly Actor[] }

const keyOf = (s: State): string => `h_${s.holds.join("_") || "0"}_w_${s.waits.join("_") || "0"}`;

// The lease settles a claim through promises, so its answer is read a turn of the event loop later.
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Plays the steps on a fresh lease and says who holds it and who waits, in the order they asked. */
async function play(path: readonly Step[]): Promise<State> {
  const lease = createGpuLease();
  const release = new Map<Actor, () => void>();
  const waiting = new Map<Actor, AbortController>();
  const said = (): string => path.map((s) => `${s.op} ${s.actor}`).join(", ");
  for (const { op, actor } of path) {
    if (op === "ask") {
      const gaveUp = new AbortController();
      waiting.set(actor, gaveUp);
      lease.acquire(ACTORS[actor], gaveUp.signal).then(
        (letGo) => { waiting.delete(actor); release.set(actor, letGo); },
        () => { waiting.delete(actor); },
      );
    } else if (op === "release") {
      const letGo = release.get(actor);
      if (letGo === undefined) throw new Error(`model/gpu/table.ts: ${actor} cannot let go of a lease it does not hold (${said()})`);
      release.delete(actor);
      letGo();
    } else {
      const gaveUp = waiting.get(actor);
      if (gaveUp === undefined) throw new Error(`model/gpu/table.ts: ${actor} cannot give up a wait it is not in (${said()})`);
      gaveUp.abort(new Error("gave up"));
    }
    await settled();
  }
  const state: State = { holds: NAMES.filter((a) => release.has(a)), waits: [...waiting.keys()] };
  const status = lease.status();
  const kinds = state.waits.map((a) => ACTORS[a]).join(",");
  if (status.holders !== state.holds.length || status.waiting.join(",") !== kinds) {
    throw new Error(
      `apps/server/src/gpu/lease.ts: after ${said()}, status() counts ${status.holders} holding and [${status.waiting.join(",")}] waiting, `
      + `but the claims it settled say ${state.holds.length} holding and [${kinds}] waiting. The model reads the lease through both.`,
    );
  }
  return state;
}

const opsOf = (s: State, actor: Actor): Op => (s.holds.includes(actor) ? "release" : s.waits.includes(actor) ? "abort" : "ask");

export interface LeaseTable { readonly module: string; readonly states: number; readonly steps: number }

/** The module `LeaseCode` the Gpu model extends. */
export async function leaseTable(): Promise<LeaseTable> {
  // The kinds left out stand behind the picture only while they are exclusive, as the picture is.
  for (const [kind, modelled] of Object.entries(MODELLED)) {
    if (!modelled && isSharedKind(kind as GpuJobKind)) {
      throw new Error(`apps/server/src/gpu/lease.ts: ${kind} claims are shared now. The model has only chats sharing the card; see model/gpu/README.md.`);
    }
  }
  const start = await play([]);
  const paths = new Map<string, readonly Step[]>([[keyOf(start), []]]);
  const states = new Map<string, State>([[keyOf(start), start]]);
  const steps = new Map<string, Record<Op, Record<string, string>>>();
  const todo = [keyOf(start)];
  let count = 0;
  while (todo.length > 0) {
    const key = todo.shift()!;
    const at = states.get(key)!;
    const row: Record<Op, Record<string, string>> = { ask: {}, release: {}, abort: {} };
    for (const actor of NAMES) {
      const op = opsOf(at, actor);
      const path = [...paths.get(key)!, { op, actor }];
      const next = await play(path);
      const to = keyOf(next);
      row[op][actor] = text(to);
      count += 1;
      if (!states.has(to)) {
        states.set(to, next);
        paths.set(to, path);
        todo.push(to);
      }
    }
    steps.set(key, row);
  }
  const each = (value: (s: State) => string): string =>
    record(Object.fromEntries([...states].toSorted(([a], [b]) => a.localeCompare(b)).map(([k, s]) => [k, value(s)])), ",\n    ");
  const module = moduleText("LeaseCode", "model/gpu/table.ts", [], {
    LeaseFree: text(keyOf(start)),
    LeaseStates: set([...states.keys()].map(text)),
    LeaseHolds: each((s) => set(s.holds.map(text))),
    LeaseWaits: each((s) => tuple(s.waits.map(text))),
    LeaseStep: record(Object.fromEntries([...steps].toSorted(([a], [b]) => a.localeCompare(b)).map(([k, row]) =>
      [k, record({ ask: record(row.ask), release: record(row.release), abort: record(row.abort) })])), ",\n    "),
  });
  return { module, states: states.size, steps: count };
}
