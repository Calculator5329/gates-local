import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { methodSamples } from "@gates-local/contracts/testing";

let store: typeof import("../lib/store/store.ts");
let entry: typeof import("./picker-entry.ts");
let touch = false;
beforeEach(async () => {
  vi.resetModules();
  touch = false;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(hover: none)" && touch, addEventListener() {}, removeEventListener() {} }));
  store = await import("../lib/store/store.ts");
  entry = await import("./picker-entry.ts");
});
afterEach(() => { vi.unstubAllGlobals(); });

/** A drawn picker root: Close and the first control, each recording the focus it is given. */
function drawn() {
  const focused: { name: string; options: unknown }[] = [];
  const control = (name: string) => ({ focus: (options: unknown) => { focused.push({ name, options }); } });
  const close = control("close"), first = control("first");
  const root = { querySelector: (sel: string) => (sel === ".pk-close" ? close : null) } as unknown as HTMLDivElement;
  return { root, first, focused };
}

it("the picker's root takes focus as it is drawn: its first control, or Close on a touch screen with no keyboard, and none as it goes", () => {
  const ref: { current: HTMLDivElement | null } = { current: null };
  const { root, first, focused } = drawn();
  const attach = entry.pickerEntry(ref, () => first as unknown as HTMLElement);
  store.setState({ pop: { id: "picker", kb: false, ready: true } });
  attach(root);
  expect(ref.current).toBe(root);
  expect(focused).toEqual([{ name: "first", options: { preventScroll: true } }]);
  touch = true;
  attach(root);
  expect(focused.at(-1)?.name, "touch with no keyboard starts on Close").toBe("close");
  store.setState({ pop: { id: "picker", kb: true, ready: true } });
  attach(root);
  expect(focused.at(-1)?.name, "a keyboard open on touch starts on the first control").toBe("first");
  attach(null);
  expect(ref.current).toBeNull();
  expect(focused).toHaveLength(3);
});

it("an open picker is marked ready the moment its first view's data is in, with nothing drawn, and a closed or ready one is left alone", () => {
  store.setState({ conn: { kind: "open" }, runtime: { ...methodSamples["runtime.status"].result, state: "ready" }, models: undefined, hydrationSettled: false, pop: { id: "picker", kb: false } });
  const stop = entry.watchPickerReady();
  const ready = () => { const pop = store.getState().pop; return pop?.id === "picker" ? pop.ready : undefined; };
  expect(ready(), "waiting for the model list").toBeFalsy();
  store.setState({ models: [] });
  expect(ready()).toBe(true);
  store.setState({ pop: null, models: undefined });
  store.setState({ models: [] });
  expect(store.getState().pop, "nothing opens a closed picker").toBeNull();
  store.setState({ models: undefined });
  stop();
  store.setState({ pop: { id: "picker", kb: false }, models: [] });
  expect(ready(), "a picker already in hand at the start is marked at once").toBeFalsy();
  entry.watchPickerReady();
  expect(ready()).toBe(true);
});
