import { expect, it, vi } from "vitest";
import { useActionPress } from "./composer-press.ts";

vi.mock("react", () => ({ useRef: (current: unknown) => ({ current }) }));

function click(detail: number): Parameters<ReturnType<typeof useActionPress>["onClick"]>[0] {
  return { detail, preventDefault: vi.fn() } as unknown as Parameters<ReturnType<typeof useActionPress>["onClick"]>[0];
}

for (const action of ["queue:1", "edit:queued-1"]) {
  it(`a fresh ${action} press works even when the browser counts it as a second click`, () => {
    const activate = vi.fn();
    const press = useActionPress(action, activate);
    press.onPointerDown();
    press.onClick(click(2));
    expect(activate).toHaveBeenCalledOnce();
  });
}

it("Stop ignores a double-click's second click but accepts a fresh click", () => {
  const activate = vi.fn();
  const press = useActionPress("stop:1", activate, { ignoreRepeatedClicks: true });
  press.onPointerDown();
  press.onClick(click(2));
  expect(activate).not.toHaveBeenCalled();
  press.onPointerDown();
  press.onClick(click(1));
  expect(activate).toHaveBeenCalledOnce();
});

it("a cancelled pointer cannot queue, while a standalone accessible click can", () => {
  const activate = vi.fn();
  const press = useActionPress("queue:1", activate);
  press.onPointerDown();
  press.onPointerCancel();
  press.onClick(click(2));
  expect(activate).not.toHaveBeenCalled();
  press.onClick(click(0));
  expect(activate).toHaveBeenCalledOnce();
});

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
