import type { UsageRead } from "./usage-data.ts";
import { usageScreen } from "../app/screen-loaders.ts";
import { getState, setState } from "../lib/store/store.ts";
import { withTimeout } from "../lib/ui/kit/async.ts";
import { requestFocus } from "../lib/ui/kit/focus.ts";

export interface UsageData {
  readonly read: UsageRead | null;
  readonly failed: boolean;
}

export const FIRST_READ_WAIT_MS = 250;

interface UsageEffects {
  readonly read: () => Promise<UsageRead>;
  readonly beforeOpen: () => void;
  readonly asked: () => void;
  readonly enter: () => void;
  readonly exit: () => void;
}

export function createUsage({ read, beforeOpen, asked, enter, exit }: UsageEffects) {
  let data: UsageData = { read: null, failed: false };
  const listeners = new Set<() => void>();
  let reading: Promise<void> | null = null;
  let again = false;
  let gen = 0;

  const publish = (next: UsageData) => {
    data = next;
    for (const listener of listeners) listener();
  };

  function refresh(): Promise<void> {
    if (reading !== null) {
      again = true;
      return reading;
    }
    reading = read()
      .then(
        (next) => publish({ read: next, failed: false }),
        () => { if (data.read === null) publish({ read: null, failed: true }); },
      )
      .finally(() => {
        reading = null;
        if (again) {
          again = false;
          void refresh();
        }
      });
    return reading;
  }

  async function openUsage(): Promise<void> {
    const mine = ++gen;
    asked();
    const first = refresh();
    await Promise.all([usageScreen.load(), withTimeout(first, FIRST_READ_WAIT_MS, () => undefined)]);
    if (mine !== gen) return;
    beforeOpen();
    setState({ panel: "usage", pop: null });
    enter();
  }

  function closeUsage(refocus = true, keepEntry = false): void {
    gen++;
    if (getState().panel === null) return;
    setState({ panel: null });
    if (!keepEntry) exit();
    if (!refocus) return;
    requestFocus(() => {
      const icon = document.querySelector<HTMLElement>(".sb-foot .usage");
      return icon !== null && icon.getClientRects().length > 0 ? icon : null;
    });
  }

  function dropPendingOpen(): void {
    gen++;
  }

  function toggleUsage(): void {
    if (getState().panel === "usage") closeUsage();
    else void openUsage();
  }

  function usageChanged(): void {
    if (getState().panel === "usage") void refresh();
  }

  return {
    openUsage, closeUsage, toggleUsage, usageChanged, refresh, dropPendingOpen,
    usageData: {
      get: () => data,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
  };
}
