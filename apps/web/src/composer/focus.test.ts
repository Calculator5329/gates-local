import { afterEach, expect, it, vi } from "vitest";

const focusing = vi.hoisted(() => ({ requestFocus: vi.fn() }));
vi.mock("../lib/ui/kit/focus.ts", () => focusing);
import { focusComposer } from "./focus.ts";

function screen(touch: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: touch && query === "(hover: none)" }));
}

afterEach(() => { vi.unstubAllGlobals(); focusing.requestFocus.mockClear(); });

it("on a touch screen the message box takes focus only when asked to, so the keyboard does not pop up by itself", () => {
  screen(true);
  focusComposer();
  expect(focusing.requestFocus).not.toHaveBeenCalled();
  focusComposer(true);
  expect(focusing.requestFocus).toHaveBeenCalledExactlyOnceWith("#ta");
});

it("with a mouse the message box takes focus whether or not it is asked to", () => {
  screen(false);
  focusComposer();
  focusComposer(true);
  expect(focusing.requestFocus).toHaveBeenCalledTimes(2);
  expect(focusing.requestFocus).toHaveBeenCalledWith("#ta");
});
