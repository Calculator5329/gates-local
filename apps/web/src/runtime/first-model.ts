import { phaseOf, rowOf } from "../fit/fit-table.ts";
import { firstChatPull } from "../models/pick.ts";
import type { State } from "../lib/store/store.ts";
import { firstModelOffer } from "./first-offer.ts";

interface Deps {
  readonly getState: () => State;
  readonly subscribe: (listener: () => void) => () => void;
  readonly pull: (name: string) => Promise<unknown>;
}

// external: Ollama takes /api/pull only once running, so the model can't download beside the engine
export function watchFirstModel({ getState, subscribe, pull }: Deps): () => void {
  let sawInstall = false, started = false;
  const check = () => {
    if (started) return;
    const s = getState();
    if (s.runtime?.state === "installing" && s.runtime.owner === "app") sawInstall = true;
    if (!sawInstall) return;
    const entry = firstModelOffer(s);
    if (entry === undefined || firstChatPull(s.models, s.pulls) !== undefined) return;
    // why: an unread fit check could still turn the pick to a smaller model
    if (phaseOf(s.fitTable, rowOf(s, entry.name)) === "checking") return;
    started = true;
    void pull(entry.name);
  };
  check();
  return subscribe(check);
}
