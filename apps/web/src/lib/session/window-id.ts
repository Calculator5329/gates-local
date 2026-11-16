const KEY = "gates-local-window";

export interface Locks {
  request(name: string, options: { ifAvailable: true }, held: (lock: unknown) => Promise<unknown> | undefined): Promise<unknown>;
}

function hold(locks: Locks | undefined, id: string): Promise<boolean> {
  // external: a browser offers Web Locks only to a secure page
  if (locks === undefined) return Promise.resolve(true);
  return new Promise((answered) => {
    locks.request(`${KEY}:${id}`, { ifAvailable: true }, (lock) => {
      answered(lock !== null);
      // why: never released while the page lives, so a duplicated tab finds this window taken
      return lock === null ? undefined : new Promise(() => {});
    }).catch(() => answered(true));
  });
}

export async function claimWindow(storage: Pick<Storage, "getItem" | "setItem"> | undefined, locks: Locks | undefined, make: () => string = () => crypto.randomUUID()): Promise<string> {
  let kept: string | null = null;
  try { kept = storage?.getItem(KEY) ?? null; } catch {}
  let id = kept !== null && await hold(locks, kept) ? kept : make();
  if (id !== kept && !await hold(locks, id)) id = make();
  try { storage?.setItem(KEY, id); } catch {}
  return id;
}
