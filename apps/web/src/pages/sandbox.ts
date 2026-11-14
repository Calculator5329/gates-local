// Whether this desktop app started with Chromium's own sandbox off. The
// Linux AppImage's launcher adds --no-sandbox on systems that refuse it
// (Ubuntu 23.10 and later), and main says so in its bridge state
// (apps/desktop/src/bridge.ts, sandboxOff). With the sandbox off a page runs
// only when the person asks (PagePanel.tsx) and Measure runs no pages
// (measure-pages.ts). A browser or a phone has no bridge: its own sandbox is on.
import { useSyncExternalStore } from "react";

interface StateBridge {
  getState?(): Promise<{ readonly status: string; readonly sandboxOff?: boolean }>;
  onState?(listener: (state: { readonly status: string; readonly sandboxOff?: boolean }) => void): () => void;
}

const bridge = (): StateBridge | undefined => (typeof window === "undefined" ? undefined : (window.gatesLocal as StateBridge | undefined));

/** undefined until the desktop bridge has said; false at once where there is no bridge. */
let off: boolean | undefined;
const listeners = new Set<() => void>();
let asked: Promise<boolean> | undefined;

function learn(value: boolean): void {
  if (off === value) return;
  off = value;
  for (const l of listeners) l();
}

/** Asks the bridge once; the switch is fixed for the life of the process. */
export function sandboxOff(): Promise<boolean> {
  const b = bridge();
  if (b === undefined) {
    learn(false);
    return Promise.resolve(false);
  }
  asked ??= new Promise<boolean>((resolve) => {
    // a bridge from before this field existed: its pages ran by themselves, so they still do
    if (b.getState === undefined) { learn(false); resolve(false); return; }
    const settle = (s: { readonly status: string; readonly sandboxOff?: boolean }) => {
      if (s.status !== "ready") return false;
      learn(s.sandboxOff === true);
      resolve(s.sandboxOff === true);
      return true;
    };
    let stop: (() => void) | undefined;
    stop = b.onState?.((s) => { if (settle(s)) stop?.(); });
    void b.getState().then((s) => { if (settle(s)) stop?.(); }, () => undefined);
  });
  return asked;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  void sandboxOff();
  return () => { listeners.delete(l); };
};

/** The switch as the panel draws it: undefined while the desktop bridge has not said. */
export const useSandboxOff = (): boolean | undefined => useSyncExternalStore(subscribe, () => (bridge() === undefined ? false : off), () => false);
