import { brokenForTest } from "./break-for-test.ts";
import { refusalLines } from "./cli.ts";
import { secondLaunch, updateStartup, type Words } from "./installed/words.ts";
import { lockHolder, type LockOptions } from "./lock.ts";
import { STARTUP_TOKEN_ENV } from "./startup.ts";
import { readLeft, readTransaction, type Transaction } from "./transaction.ts";

/** On the app a finish attempt opens: that start says what is left instead of trying again. */
export const FINISH_TRIED_FLAG = "--gates-local-update-tried";

export const DID_NOT_START = "Gates Local did not start.";

/**
 * `updating`: a live process holds the checkout's lock. `token`: the startup
 * token this launch carries. `tried`: this launch follows an attempt, made for
 * it, to finish the saved update; `left` is what that attempt said is in the
 * way, in the updater's own lines.
 */
export interface CheckoutStartFacts {
  readonly updating: boolean;
  readonly transaction: Transaction | null;
  readonly token: string | undefined;
  readonly tried: boolean;
  readonly left: readonly string[] | null;
}

/**
 * `wait`: an updater is running; show the words, wait for it to end, look
 * again. `finish`: a crash left an update; start the updater to finish it or
 * take it back. `say`: still unfinished after that attempt; start nothing.
 */
export type CheckoutStart =
  | { readonly kind: "start" }
  | { readonly kind: "wait"; readonly words: Words }
  | { readonly kind: "finish"; readonly words: Words }
  | { readonly kind: "say"; readonly lines: readonly string[] };

export function decideCheckoutStart(f: CheckoutStartFacts): CheckoutStart {
  if (brokenForTest("checkout-start-skips-the-look")) return { kind: "start" };
  const t = f.transaction;
  if (t?.phase === "launch" && f.token !== undefined && f.token !== "" && t.startupToken === f.token) return { kind: "start" };
  if (f.updating) return { kind: "wait", words: secondLaunch() };
  if (t === null) return { kind: "start" };
  if (t.phase === "launch" && t.startupToken === undefined) return { kind: "start" };
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
