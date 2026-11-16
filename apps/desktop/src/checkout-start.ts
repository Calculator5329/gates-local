import { DID_NOT_START, type CheckoutStart } from "@gates-local/update/checkout-start";
import type { Words } from "@gates-local/update/installed/words";

export const LOOK_AGAIN_MS = 500;

export type Started = { readonly ok: true } | { readonly ok: false; readonly message: string };

export interface CheckoutStartActs {
  look(tried: boolean): CheckoutStart;
  claim(): boolean;
  unclaim(): void;
  start(): void;
  pagesOnly(): void;
  show(words: Words): void;
  say(lines: readonly string[]): void;
  finish(): Promise<Started>;
  handOver(): Promise<Started>;
  again(): void;
  sleep(ms: number): Promise<void>;
}

export interface CheckoutStartOptions {
  readonly tried: boolean;
  // external: Windows locks a running electron.exe, so this process must exit before files are replaced.
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

function notStarted(now: CheckoutStart, message: string): readonly string[] {
  const rest = now.kind === "say" ? now.lines.filter((line) => line !== DID_NOT_START) : [];
  return [DID_NOT_START, message, ...rest];
}
