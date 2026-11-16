import { useSyncExternalStore } from "react";

interface StateBridge {
  getState?(): Promise<{ readonly status: string; readonly sandboxOff?: boolean }>;
  onState?(listener: (state: { readonly status: string; readonly sandboxOff?: boolean }) => void): () => void;
}

const bridge = (): StateBridge | undefined => (typeof window === "undefined" ? undefined : (window.gatesLocal as StateBridge | undefined));

let off: boolean | undefined;
const listeners = new Set<() => void>();
let asked: Promise<boolean> | undefined;

function learn(value: boolean): void {
  if (off === value) return;
  off = value;
  for (const l of listeners) l();
}

export function sandboxOff(): Promise<boolean> {
  const b = bridge();
  if (b === undefined) {
    learn(false);
    return Promise.resolve(false);
  }
  asked ??= new Promise<boolean>((resolve) => {
    if (b.getState === undefined) { learn(false); resolve(false); return; }
    const settle = (s: { readonly status: string; readonly sandboxOff?: boolean }) => {
      if (s.status !== "ready") return false;
      learn(s.sandboxOff === true);
      resolve(s.sandboxOff === true);
      return true;
    };
    let stop: (() => void) | undefined;
    stop = b.onState?.((s) => { if (settle(s)) stop?.(); });
    void b.getState().then((s) => { if (settle(s)) stop?.(); }, () => { stop?.(); learn(true); resolve(true); });
  });
  return asked;
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  void sandboxOff();
  return () => { listeners.delete(l); };
};

export const useSandboxOff = (): boolean | undefined => useSyncExternalStore(subscribe, () => (bridge() === undefined ? false : off), () => false);
