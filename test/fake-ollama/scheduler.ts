// Deliberately explicit assumptions, not an emulation of Ollama's internals.
// Different contexts replace one runner only after all its requests finish.
import type { LoadedEntry } from "./fake-ollama.ts";

interface Waiting {
  readonly entry: LoadedEntry;
  readonly signal: AbortSignal;
  readonly limit: number;
  readonly capacity: number;
  readonly resolve: (release: (() => void) | undefined) => void;
}

export function createScheduler(resident: () => readonly LoadedEntry[], evict: (names: readonly string[]) => void) {
  const active = new Map<string, { ctx: number; count: number; entry: LoadedEntry }>();
  const waiting: Waiting[] = [];
  const drain = () => {
    for (const w of waiting.slice()) {
      if (w.signal.aborted) {
        waiting.splice(waiting.indexOf(w), 1);
        w.resolve(undefined);
        continue;
      }
      const current = active.get(w.entry.name);
      if (current && (current.ctx !== w.entry.numCtx || current.count >= w.limit)) continue;
      // A context reload in front must not starve behind newer requests.
      if (waiting.slice(0, waiting.indexOf(w)).some((p) => p.entry.name === w.entry.name)) continue;
      // Account for admissions before their caller has started filling memory.
      const memory = new Map(resident().map((r) => [r.name, r]));
      for (const [name, a] of active) memory.set(name, a.entry);
      const others = [...memory.values()].filter((r) => r.name !== w.entry.name);
      let used = others.reduce((sum, r) => sum + r.sizeBytes, w.entry.sizeBytes);
      const gone: string[] = [];
      for (const r of others) {
        if (used <= w.capacity) break;
        if (active.has(r.name)) continue;
        gone.push(r.name);
        used -= r.sizeBytes;
      }
      if (used > w.capacity && active.size > (active.has(w.entry.name) ? 1 : 0)) continue;
      evict(gone);
      active.set(w.entry.name, { ctx: w.entry.numCtx, count: (current?.count ?? 0) + 1, entry: w.entry });
      waiting.splice(waiting.indexOf(w), 1);
      let released = false;
      w.resolve(() => {
        if (released) return;
        released = true;
        const a = active.get(w.entry.name);
        if (a && a.count > 1) a.count--;
        else active.delete(w.entry.name);
        drain();
      });
    }
  };
  return {
    acquire(entry: LoadedEntry, signal: AbortSignal, limit: number, capacity: number): Promise<(() => void) | undefined> {
      return new Promise((resolve) => {
        const wake = () => drain();
        const finish = (release: (() => void) | undefined) => {
          signal.removeEventListener("abort", wake);
          resolve(release);
        };
        waiting.push({ entry, signal, limit, capacity, resolve: finish });
        signal.addEventListener("abort", wake, { once: true });
        drain();
      });
    },
  };
}
