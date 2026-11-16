import { beforeEach, expect, it, vi } from "vitest";
import { useActionPress } from "./composer-press.ts";

const hooks = vi.hoisted(() => ({ refs: [] as { current: unknown }[], next: 0 }));
vi.mock("react", () => ({
  useRef: (current: unknown) => {
    const ref = hooks.refs[hooks.next] ?? { current };
    hooks.refs[hooks.next] = ref;
    hooks.next += 1;
    return ref;
  },
}));
beforeEach(() => { hooks.refs = []; hooks.next = 0; });

function rerender(action: string, activate: () => void): ReturnType<typeof useActionPress> {
  hooks.next = 0;
  return useActionPress(action, activate);
}

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

function key(name: "Enter" | " "): Parameters<ReturnType<typeof useActionPress>["onKeyDown"]>[0] {
  return { key: name, repeat: false, defaultPrevented: false, preventDefault: vi.fn() } as unknown as Parameters<ReturnType<typeof useActionPress>["onKeyDown"]>[0];
}

it("a press that starts on one action and is released after the button changed activates nothing", () => {
  const activate = vi.fn();
  rerender("stop:1", activate).onPointerDown();
  rerender("stop:2", activate).onClick(click(1));
  rerender("queue:1", activate).onKeyDown(key(" "));
  rerender("send", activate).onKeyUp(key(" "));
  expect(activate).not.toHaveBeenCalled();
  rerender("send", activate).onPointerDown();
  rerender("send", activate).onClick(click(1));
  expect(activate).toHaveBeenCalledOnce();
});

it("a Space whose release went to another window does not stall the next Space press, which activates once", () => {
  const same = vi.fn();
  rerender("send", same).onKeyDown(key(" "));
  rerender("send", same).onKeyDown(key(" "));
  rerender("send", same).onKeyUp(key(" "));
  expect(same).toHaveBeenCalledOnce();
  const changed = vi.fn();
  rerender("stop:1", changed).onKeyDown(key(" "));
  rerender("send", changed).onKeyDown(key(" "));
  rerender("send", changed).onKeyUp(key(" "));
  expect(changed).toHaveBeenCalledOnce();
});

it("Enter or Space followed by the browser's own click activates once, and a lone accessible click still works", () => {
  for (const name of ["Enter", " "] as const) {
    const activate = vi.fn();
    const press = rerender("queue:1", activate);
    press.onKeyDown(key(name));
    press.onClick(click(0));
    press.onKeyUp(key(name));
    expect(activate, name).toHaveBeenCalledOnce();
    press.onClick(click(0));
    expect(activate, name).toHaveBeenCalledTimes(2);
  }
});
