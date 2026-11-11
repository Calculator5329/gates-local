// Measured model speeds: one read after the first frame, then the server's
// models.speed push whenever a finished reply or a deletion changes them.
import type { ModelSpeed, Payload } from "@gates-local/contracts";
import { NA, type State } from "../store.ts";

/** The list by model name; an entry whose numbers did not change keeps its identity, so its row does not redraw. */
export function speedTable(previous: State["speeds"], list: readonly ModelSpeed[]): Readonly<Record<string, ModelSpeed>> {
  const old = previous === NA ? undefined : previous;
  return Object.fromEntries(list.map((speed) => {
    const kept = old?.[speed.model];
    return [speed.model, kept !== undefined && kept.tokensPerSecond === speed.tokensPerSecond && kept.replies === speed.replies ? kept : speed];
  }));
}

/** The second hydrate batch's read: NA from a server without it, unchanged when the read failed. */
export const speedsRead = (s: State, read: readonly ModelSpeed[] | typeof NA | undefined): Partial<State> =>
  read === undefined ? {} : { speeds: read === NA ? NA : speedTable(s.speeds, read) };

export const speedsChanged = (s: State, list: Payload<"models.speed">): Partial<State> => ({ speeds: speedTable(s.speeds, list) });
