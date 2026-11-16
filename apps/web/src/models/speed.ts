import type { ModelSpeed, Payload } from "@gates-local/contracts";
import { NA, type State } from "../lib/store/store.ts";

export function speedTable(previous: State["speeds"], list: readonly ModelSpeed[]): Readonly<Record<string, ModelSpeed>> {
  const old = previous === NA ? undefined : previous;
  return Object.fromEntries(list.map((speed) => {
    const kept = old?.[speed.model];
    return [speed.model, kept !== undefined && kept.tokensPerSecond === speed.tokensPerSecond && kept.replies === speed.replies ? kept : speed];
  }));
}

export const speedsRead = (s: State, read: readonly ModelSpeed[] | typeof NA | undefined): Partial<State> =>
  read === undefined ? {} : { speeds: read === NA ? NA : speedTable(s.speeds, read) };

export const speedsChanged = (s: State, list: Payload<"models.speed">): Partial<State> => ({ speeds: speedTable(s.speeds, list) });
