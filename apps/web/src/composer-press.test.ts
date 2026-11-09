import { expect, it, vi } from "vitest";
import { useActionPress } from "./composer-press.ts";

vi.mock("react", () => ({ useRef: (current: unknown) => ({ current }) }));

// Event-handler probe: Voice's capture listener handles Ctrl+Shift+Space before
// the focused button receives its React key event. No DOM or microphone needed.
function space(handled: boolean): Parameters<ReturnType<typeof useActionPress>["onKeyDown"]>[0] {
  return {
    key: " ", code: "Space", repeat: false,
    ctrlKey: handled, shiftKey: handled, defaultPrevented: handled,
    preventDefault: vi.fn(),
  } as unknown as Parameters<ReturnType<typeof useActionPress>["onKeyDown"]>[0];
}

for (const action of ["send", "stop:1"]) {
  it(`a handled shortcut clears a missed Space release on ${action}`, () => {
    const activate = vi.fn();
    const press = useActionPress(action, activate);
    press.onKeyDown(space(false));
    // The first keyup went to another window; Voice consumes the next keydown.
    press.onKeyDown(space(true));
    press.onKeyUp(space(false));
    expect(activate).not.toHaveBeenCalled();
    press.onKeyDown(space(false));
    press.onKeyUp(space(false));
    expect(activate).toHaveBeenCalledOnce();
  });

  it(`a handled dictation shortcut cannot activate ${action}; plain Space still can`, () => {
    const activate = vi.fn();
    const press = useActionPress(action, activate);
    press.onKeyDown(space(true));
    press.onKeyUp(space(false));
    expect(activate).not.toHaveBeenCalled();

    press.onKeyDown(space(false));
    press.onKeyUp(space(false));
    expect(activate).toHaveBeenCalledOnce();
  });
}
