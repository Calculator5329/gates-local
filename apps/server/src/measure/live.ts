import type { MeasureChat, MeasureTurn } from "@gates-local/contracts";

// why: about four redraws a second reads as live text and costs the run next to nothing.
export const PUSH_MS = 250;

export interface LiveChat {
  turn(index: number, turn: MeasureTurn): void;
  end(): void;
  chat(): MeasureChat;
}

const copy = (t: MeasureTurn): MeasureTurn => ({ ...t, steps: [...t.steps] });

// why: a change only marks its turn, so a turn loop that reports every token never waits on a send
export function liveChat(model: string, at: number, send: (index: number, turn: MeasureTurn) => void, ms = PUSH_MS): LiveChat {
  const turns: MeasureTurn[] = [];
  const marked = new Set<number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    for (const i of marked) send(i, copy(turns[i]!));
    marked.clear();
  };
  return {
    turn(index, turn) {
      turns[index] = turn;
      marked.add(index);
      // why: a macrotask, so the send never runs inside the turn loop or between a read and its reply
      timer ??= setTimeout(flush, ms);
    },
    end() {
      clearTimeout(timer);
      flush();
    },
    chat: () => ({ model, at, turns: turns.filter((t) => t !== undefined).map(copy) }),
  };
}
