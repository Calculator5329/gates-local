import type { RefObject } from "react";
import { type State, chatReady, getState, setState } from "../lib/store/store.ts";
import { watch } from "../lib/ui/kit/watch.ts";
import { isTouch } from "../lib/ui/ui.tsx";

// why: focus goes in as the picker's root is drawn; touch with no keyboard starts on Close
export function pickerEntry(ref: RefObject<HTMLDivElement | null>, first: (root: HTMLDivElement) => HTMLElement | null | undefined) {
  return (root: HTMLDivElement | null): void => {
    ref.current = root;
    if (root === null) return;
    const target = isTouch() && getState().pop?.kb !== true ? root.querySelector<HTMLElement>(".pk-close") : first(root);
    target?.focus({ preventScroll: true });
  };
}

const pickerPending = (s: State): boolean =>
  s.pop?.id === "picker" && s.pop.ready !== true && (!chatReady(s) || s.models !== undefined || s.hydrationSettled);

function markReady(pending: boolean): void {
  const pop = getState().pop;
  if (pending && pop?.id === "picker" && pop.ready !== true) setState({ pop: { ...pop, ready: true } });
}

// why: the picker opens in the store once its first view's data is in, as App reads that pop
export function watchPickerReady(): () => void {
  markReady(pickerPending(getState()));
  return watch(pickerPending, markReady);
}
