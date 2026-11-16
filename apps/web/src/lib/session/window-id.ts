const KEY = "gates-local-window";
const ASK_MS = 50;

export interface Locks {
  request(name: string, options: { ifAvailable: true }, held: (lock: unknown) => Promise<unknown> | undefined): Promise<unknown>;
}

export type Tabs = Pick<BroadcastChannel, "postMessage" | "addEventListener" | "removeEventListener">;

type Said = { readonly ask?: string; readonly taken?: string };
const said = (data: unknown): Said => (typeof data === "object" && data !== null ? data : {});

function hold(locks: Locks, id: string): Promise<boolean | undefined> {
  return new Promise((answered) => {
    locks.request(`${KEY}:${id}`, { ifAvailable: true }, (lock) => {
      answered(lock !== null);
      // why: never released while the page lives, so a duplicated tab finds this window taken
      return lock === null ? undefined : new Promise(() => {});
    }).catch(() => answered(undefined));
  });
}

// why: without a lock, a tab that holds the window answers when asked
function unclaimed(tabs: Tabs | undefined, id: string): Promise<boolean> {
  if (tabs === undefined) return Promise.resolve(true);
  return new Promise((answered) => {
    const heard = (e: MessageEvent) => { if (said(e.data).taken === id) done(false); };
    const done = (open: boolean) => { clearTimeout(timer); tabs.removeEventListener("message", heard); answered(open); };
    // oxlint-disable-next-line gates/timer-needs-reason -- a limit on a real wait: an open tab answers within a few ms, silence means none holds it
    const timer = setTimeout(() => done(true), ASK_MS);
    tabs.addEventListener("message", heard);
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel reaches only this origin and takes no target
    tabs.postMessage({ ask: id });
  });
}

async function free(locks: Locks | undefined, tabs: Tabs | undefined, id: string): Promise<boolean> {
  // external: a browser offers Web Locks only to a secure page
  const held = locks === undefined ? undefined : await hold(locks, id);
  return held ?? unclaimed(tabs, id);
}

export async function claimWindow(storage: Pick<Storage, "getItem" | "setItem"> | undefined, locks: Locks | undefined, tabs: Tabs | undefined, make: () => string = () => crypto.randomUUID()): Promise<string> {
  let kept: string | null = null;
  try { kept = storage?.getItem(KEY) ?? null; } catch {}
  let id = kept !== null && await free(locks, tabs, kept) ? kept : make();
  // why: no other tab can hold a new id, so only its lock is taken
  if (id !== kept && !await free(locks, undefined, id)) id = make();
  const mine = id;
  tabs?.addEventListener("message", (e) => {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel reaches only this origin and takes no target
    if (said(e.data).ask === mine) tabs.postMessage({ taken: mine });
  });
  try { storage?.setItem(KEY, id); } catch {}
  return id;
}

export function windowTabs(): Tabs | undefined {
  return typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(KEY);
}
