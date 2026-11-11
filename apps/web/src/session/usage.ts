// The Usage pop-up's data and its open and close. The first read gets a
// short wait so the panel opens complete; a slower read shows the panel's
// placeholders in the same boxes. While open, each usage.changed reads again
// and the figures change in place; reads never overlap.
import type { UsageRead } from "../usage-data.ts";
import { usageScreen } from "../screen-loaders.ts";
import { getState, setState } from "../store.ts";

export interface UsageData {
  readonly read: UsageRead | null;
  /** The last read failed and there is nothing older to show. */
  readonly failed: boolean;
}

/** How long opening waits for the first read before it shows placeholders. */
export const FIRST_READ_WAIT_MS = 250;

interface UsageEffects {
  readonly read: () => Promise<UsageRead>;
  /** Called just before the panel shows: leaves Settings, which the pop-up replaces, keeping its history entry. */
  readonly beforeOpen: () => void;
  /** Called as soon as the open is asked for: a Settings still waiting for its chunk must not land on top later. */
  readonly asked: () => void;
  /** The history entry a screen opens on, and its plain close (navigation.ts). */
  readonly enter: () => void;
  readonly exit: () => void;
}

export function createUsage({ read, beforeOpen, asked, enter, exit }: UsageEffects) {
  let data: UsageData = { read: null, failed: false };
  const listeners = new Set<() => void>();
  let reading: Promise<void> | null = null;
  let again = false;
  /** Bumped by every open and close: an open that a close overtook while it waited does nothing. */
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
    await Promise.all([usageScreen.load(), Promise.race([first, new Promise((r) => setTimeout(r, FIRST_READ_WAIT_MS))])]);
    if (mine !== gen) return;
    beforeOpen();
    setState({ panel: "usage", pop: null });
    enter();
  }

  /** Close the pop-up; focus goes back to the footer icon when it is on screen. keepEntry: Back has already taken the history entry, or the drawer takes it over. */
  function closeUsage(refocus = true, keepEntry = false): void {
    gen++;
    if (getState().panel === null) return;
    setState({ panel: null });
    if (!keepEntry) exit();
    if (!refocus) return;
    requestAnimationFrame(() => {
      const icon = document.querySelector<HTMLElement>(".sb-foot .usage");
      if (icon !== null && icon.getClientRects().length > 0) icon.focus();
    });
  }

  /** Somewhere else was picked while the pop-up still waited to open: it must not pop in over it. */
  function dropPendingOpen(): void {
    gen++;
  }

  function toggleUsage(): void {
    if (getState().panel === "usage") closeUsage();
    else void openUsage();
  }

  /** A turn ended somewhere: read again only while someone is looking. */
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
