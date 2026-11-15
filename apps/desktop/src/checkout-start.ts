// A source checkout's start, before any window or server: what main does
// with the decision in @gates-local/update/checkout-start. The acts are
// passed in, so this is tested without Electron; routeCheckout
// (installed-update/desktop.ts) gives it the real ones.
//
// An ordinary start looks, takes the app's single-instance lock and writes
// its pid file, then looks once more. An updater takes the checkout's lock
// first and reads the pid file second, so of a start and an updater that
// begin together at least one sees the other, and no server starts beside a
// checkout that is being changed.
//
// Every other start shows pages only. It never holds the single-instance
// lock, so the app the updater opens is not turned away by it, and once the
// checkout is whole it starts the app again as a new process.
import { DID_NOT_START, type CheckoutStart } from "@gates-local/update/checkout-start";
import type { Words } from "@gates-local/update/installed/words";

/** How often a waiting start looks at the checkout again. */
export const LOOK_AGAIN_MS = 500;

export type Started = { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface CheckoutStartActs {
  /** Reads the checkout's lock and saved update, and decides. `tried`: an attempt to finish it was made for this start. */
  look(tried: boolean): CheckoutStart;
  /** Takes the single-instance lock and writes the pid file. False when another instance has it; this process then quits. */
  claim(): boolean;
  /** Gives both back: this process will not be the app. */
  unclaim(): void;
  /** Starts the app: its window and its server. */
  start(): void;
  /** Called once, before the first page: this process shows pages only from here on. */
  pagesOnly(): void;
  /** Shows this in the one window, in place of what it showed before. */
  show(words: Words): void;
  /** Shows these lines and stays until the window is closed. Starts nothing. */
  say(lines: readonly string[]): void;
  /** Runs the updater to finish or take back the saved update; settles once that process has ended. */
  finish(): Promise<Started>;
  /** Starts the same updater told to wait for this process to exit and open the app after, then quits. */
  handOver(): Promise<Started>;
  /** Starts the app again as a new process and ends this one. */
  again(): void;
  sleep(ms: number): Promise<void>;
}

export interface CheckoutStartOptions {
  /** This launch follows a finish attempt made for it (FINISH_TRIED_FLAG). */
  readonly tried: boolean;
  /** This process must exit before the updater can replace files: a running electron.exe is locked on Windows. */
  readonly quitsToFinish: boolean;
}

export type CheckoutStartEnd = "started" | "second-instance" | "started-again" | "handed-over" | "said";

export async function startCheckout(acts: CheckoutStartActs, o: CheckoutStartOptions): Promise<CheckoutStartEnd> {
  let tried = o.tried;
  let kind = acts.look(tried);
  if (kind.kind === "start") {
    if (!acts.claim()) return "second-instance";
    kind = acts.look(tried);
    if (kind.kind === "start") {
      acts.start();
      return "started";
    }
    acts.unclaim();
  }
  acts.pagesOnly();
  let shown: string | null = null;
  const show = (words: Words) => {
    if (shown === words.text) return;
    shown = words.text;
    acts.show(words);
  };
  for (;;) {
    switch (kind.kind) {
      case "start":
        acts.again();
        return "started-again";
      case "say":
        acts.say(kind.lines);
        return "said";
      case "wait":
        show(kind.words);
        await acts.sleep(LOOK_AGAIN_MS);
        kind = acts.look(tried);
        break;
      case "finish": {
        if (o.quitsToFinish) {
          const handed = await acts.handOver();
          if (handed.ok) return "handed-over";
          acts.say(notStarted(acts.look(true), handed.message));
          return "said";
        }
        show(kind.words);
        const ran = await acts.finish();
        tried = true;
        kind = acts.look(tried);
        if (!ran.ok && kind.kind === "say") {
          acts.say(notStarted(kind, ran.message));
          return "said";
        }
        break;
      }
    }
  }
}

/** The lines for an updater that could not be started: why, then where the checkout stands. */
function notStarted(now: CheckoutStart, message: string): readonly string[] {
  const rest = now.kind === "say" ? now.lines.filter((line) => line !== DID_NOT_START) : [];
  return [DID_NOT_START, message, ...rest];
}
