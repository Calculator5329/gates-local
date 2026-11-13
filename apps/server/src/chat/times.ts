// A turn's times, kept by the server as it sends the turn's events (chat row 32), and saved on
// the reply's row: every window and every reload shows the same seconds. The rules are the ones
// each window used to keep for itself (apps/web/src/session/turn.ts readyOn and clockOn).
import type { ReplyTimes, TurnEnded } from "@gates-local/contracts";

/** An event the turn sends before its end. */
export type TurnStep =
  | { readonly type: "thinking" | "delta"; readonly text: string }
  | { readonly type: "tool"; readonly step: { readonly callId: string } };

export interface TurnClock {
  /** The model is ready for this reply: called at the start of a turn whose model was resident. */
  ready(now: number): void;
  /** `event` was sent at `now`; `thought` is the thinking sent before it. Nothing after a Stop counts. */
  see(event: TurnStep, now: number, thought: string): void;
  /** The person pressed Stop at `now`: the times end there, whatever words were already on their way. */
  stop(now: number, thought: string): void;
  /** The times once the turn ended; `thought` is all the thinking it sent; `why` the error of a turn that did not finish. */
  end(ended: TurnEnded, thought: string, why?: ReplyTimes["why"]): ReplyTimes;
}

/**
 * The model is ready at the start of a warm turn, else at its first token or call. A span of
 * thinking opens with its first words and closes when a call, the answer or the end comes.
 * "Thought for" runs from ready to the first answer word after thinking, or to the end of a
 * reply that thought and never answered.
 */
export function turnClock(startedAt: number): TurnClock {
  let readyAt: number | undefined;
  let firstTokenAt: number | undefined;
  let thoughtMs: number | undefined;
  let stopped = false;
  let open: { readonly since: number; readonly from: number } | undefined;
  const spans: { from: number; ms: number }[] = [];
  const callsAt: Record<string, number> = {};
  const close = (now: number) => {
    if (open === undefined) return;
    spans.push({ from: open.from, ms: Math.max(0, now - open.since) });
    open = undefined;
  };
  const thoughtUntil = (now: number) => Math.max(0, now - (readyAt ?? startedAt));
  /** The times stop at `now`: an open round closes, and a reply that thought and never answered thought until then. */
  const finish = (now: number, thought: string) => {
    close(now);
    if (thought !== "" && thoughtMs === undefined && firstTokenAt === undefined) thoughtMs = thoughtUntil(now);
  };
  return {
    ready(now) {
      readyAt ??= now;
    },
    stop(now, thought) {
      if (stopped) return;
      finish(now, thought);
      stopped = true;
    },
    see(event, now, thought) {
      if (stopped) return;
      if (event.type === "tool") {
        readyAt ??= now;
        close(now);
        callsAt[event.step.callId] ??= thought.length;
        return;
      }
      if (event.text === "") return;
      readyAt ??= now;
      if (event.type === "thinking") {
        open ??= { since: now, from: thought.length };
        return;
      }
      close(now);
      firstTokenAt ??= now;
      if (thought !== "" && thoughtMs === undefined) thoughtMs = thoughtUntil(now);
    },
    end(ended, thought, why) {
      if (!stopped) finish(ended.at, thought);
      return {
        startedAt,
        ...(firstTokenAt === undefined ? {} : { firstTokenAt }),
        ...(thoughtMs === undefined ? {} : { thoughtMs }),
        spans: [...spans],
        callsAt: { ...callsAt },
        ended,
        ...(why === undefined || ended.reason === "done" || ended.reason === "stopped" ? {} : { why }),
      };
    },
  };
}
