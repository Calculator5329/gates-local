// The engine download's stall, read from the clock: one reading for the first window, the banner,
// the footer gear and Settings › Runtime, so no two of them say different things at one moment.
import type { RuntimeStatus } from "@gates-local/contracts";
import { getState, setState } from "../lib/store/store.ts";

type InstallSize = Pick<NonNullable<RuntimeStatus["install"]>, "receivedBytes" | "totalBytes" | "stalled">;

/**
 * No new bytes of the engine download for this long is a stall: the server's own bound
 * (runtime STALL_MS), after which its speed and time left leave the status and a Retry
 * starts the download again.
 */
export const INSTALL_STALL_MS = 5000;

/** When the download's figures last moved, shared, so every place that reads the download sees one stall. */
const lastMove = { bytes: Number.NaN, at: 0 };

/** Note the figures read at `now` and return when they last moved. A Retry counts as a move: its new attempt gets the whole stall time. */
export function figuresMoved(bytes: number, now: number, retried = false): number {
  if (retried || bytes !== lastMove.bytes) {
    lastMove.bytes = bytes;
    lastMove.at = now;
  }
  return lastMove.at;
}

/** A download (not the unpack) whose figures have not moved since `movedAt` for the stall time. */
export function installStalled(i: InstallSize | undefined, movedAt: number, now: number): boolean {
  return i !== undefined && i.receivedBytes < i.totalBytes && now - movedAt >= INSTALL_STALL_MS;
}

/** The stall right now, for the figures on screen: the server's word when it has said it, else this window's clock. */
export function stalledNow(i: InstallSize | undefined): boolean {
  if (i === undefined) return false;
  const now = Date.now();
  if (i.stalled === true) {
    figuresMoved(i.receivedBytes, now);
    return i.receivedBytes < i.totalBytes;
  }
  return installStalled(i, figuresMoved(i.receivedBytes, now), now);
}

let wake: ReturnType<typeof setTimeout> | undefined;

/**
 * The server sends nothing while a download hangs, so the stall's moment is the clock's: at that
 * moment the install is published again (the same figures) and every place that reads it, the
 * footer gear among them, renders the stall. Call it whenever a runtime status lands, and on Retry.
 */
export function wakeAtStall(): void {
  clearTimeout(wake);
  wake = undefined;
  const runtime = getState().runtime;
  const i = runtime?.state === "installing" ? runtime.install : undefined;
  if (i === undefined || i.receivedBytes >= i.totalBytes) return;
  const left = figuresMoved(i.receivedBytes, Date.now()) + INSTALL_STALL_MS - Date.now();
  if (left <= 0) return;
  // oxlint-disable-next-line gates/timer-needs-reason -- a hung download sends nothing, so the stall's moment comes from the clock
  wake = setTimeout(() => {
    wake = undefined;
    setState((s) => (s.runtime?.install === i ? { runtime: { ...s.runtime, install: { ...i } } } : {}));
  }, left);
}
