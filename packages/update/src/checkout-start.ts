// What a start of a source checkout does while an update of it may be in
// flight. The app's start reads two things before it starts anything: who
// holds the checkout's lock (lock.ts) and the update saved in the checkout
// (transaction.ts). This file is the decision over what it read; the caller
// acts on the answer (apps/desktop/src/checkout-start.ts).
//
// The rule: no server starts on a checkout that an update is changing, or
// left part way. While an updater runs, the start waits for it and says so.
// An update a crash left is handed to the updater to finish or take back, by
// that start. When that attempt leaves it too, the start says where the
// checkout stands and what to do, in the lines the attempt left for it
// (`saveLeft`, transaction.ts), and starts nothing.
import { brokenForTest } from "./break-for-test.ts";
import { refusalLines } from "./cli.ts";
import { secondLaunch, updateStartup, type Words } from "./installed/words.ts";
import { lockHolder, type LockOptions } from "./lock.ts";
import { STARTUP_TOKEN_ENV } from "./startup.ts";
import { readLeft, readTransaction, type Transaction } from "./transaction.ts";

/** On the app a finish attempt opens: that start says what is left instead of trying again. */
export const FINISH_TRIED_FLAG = "--gates-local-update-tried";

export const DID_NOT_START = "Gates Local did not start.";

export interface CheckoutStartFacts {
  /** A live process holds the checkout's lock: an update is running now. */
  readonly updating: boolean;
  /** The update saved in the checkout: one that is running, or one a crash left. */
  readonly transaction: Transaction | null;
  /** The startup token this launch carries: the updater's own first start of the version it built. */
  readonly token: string | undefined;
  /** This launch follows an attempt, made for it, to finish the saved update. */
  readonly tried: boolean;
  /** What that attempt said is in the way of this saved update, in the updater's own lines; null when it left none. */
  readonly left: readonly string[] | null;
}

export type CheckoutStart =
  | { readonly kind: "start" }
  /** An updater is running: show this and wait for it to end, then look again. */
  | { readonly kind: "wait"; readonly words: Words }
  /** A crash left an update: start the updater to finish it or take it back, and show this meanwhile. */
  | { readonly kind: "finish"; readonly words: Words }
  /** The update is still unfinished after the attempt: say this and start nothing. */
  | { readonly kind: "say"; readonly lines: readonly string[] };

export function decideCheckoutStart(f: CheckoutStartFacts): CheckoutStart {
  if (brokenForTest("checkout-start-skips-the-look")) return { kind: "start" };
  const t = f.transaction;
  // The updater's own start of the version it built: it holds the lock and is waiting for this launch's ready server.
  if (t?.phase === "launch" && f.token !== undefined && f.token !== "" && t.startupToken === f.token) return { kind: "start" };
  if (f.updating) return { kind: "wait", words: secondLaunch() };
  if (t === null) return { kind: "start" };
  // Built with nobody to start it: this start is the new version's first, and its ready server finishes the update.
  if (t.phase === "launch" && t.startupToken === undefined) return { kind: "start" };
  // What the attempt found: a copy part way between two versions, a process still at it, a disk that is full.
  // Its lines name the state and the way out. Without them, only that the update did not finish.
  if (f.tried) return { kind: "say", lines: [DID_NOT_START, ...(f.left ?? refusalLines({ reason: "unfinished", target: t.to.label, runningPid: null }))] };
  return { kind: "finish", words: updateStartup() };
}

/** The saved update first, then the lock: an updater clears the first before it lets go of the second. */
export function checkoutStartFacts(root: string, o: { readonly env: Readonly<Record<string, string | undefined>>; readonly tried: boolean }, lock: LockOptions = {}): CheckoutStartFacts {
  const transaction = readTransaction(root);
  const said = transaction === null ? null : readLeft(root);
  return {
    updating: lockHolder(root, lock) !== null, transaction, token: o.env[STARTUP_TOKEN_ENV], tried: o.tried,
    left: said !== null && said.to === transaction?.to.commit ? said.lines : null,
  };
}
