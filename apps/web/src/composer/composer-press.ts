import { type KeyboardEvent, type MouseEvent, useRef } from "react";

/** Bind a button press to its starting action identity, including its turn. */
export function useActionPress(action: string, activate: () => void, options: { ignoreRepeatedClicks?: boolean } = {}) {
  const pointer = useRef<string | null>(null);
  const keyboard = useRef<{ key: "Enter" | " "; action: string } | null>(null);
  const run = (from: string) => {
    if (from === action) activate();
  };
  return {
    onPointerDown: () => { pointer.current = action; },
    onPointerCancel: () => { pointer.current = null; },
    onBlur: () => { pointer.current = null; keyboard.current = null; },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.defaultPrevented) {
        if (keyboard.current?.key === event.key) keyboard.current = null;
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      // A fresh press also recovers a keyup delivered to another window.
      if (event.repeat) return;
      keyboard.current = { key: event.key, action };
      if (event.key === "Enter") run(action);
    },
    onKeyUp: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      const started = keyboard.current;
      if (started?.key !== event.key) return;
      keyboard.current = null;
      if (event.key === " ") run(started.action);
    },
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      // Keyboard activation is handled explicitly; a standalone accessible click still works.
      if (event.detail === 0 && keyboard.current !== null) return;
      const started = event.detail === 0 ? action : pointer.current;
      pointer.current = null;
      // Stop rejects Send's second click. Queue/Update still accept a fresh
      // press when the browser carries a click count across a draft edit.
      if ((options.ignoreRepeatedClicks && event.detail > 1) || started === null) return;
      run(started);
    },
  };
}
