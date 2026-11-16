import { type KeyboardEvent, type MouseEvent, useRef } from "react";

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
      if (event.detail === 0 && keyboard.current !== null) return;
      const started = event.detail === 0 ? action : pointer.current;
      pointer.current = null;
      if ((options.ignoreRepeatedClicks && event.detail > 1) || started === null) return;
      run(started);
    },
  };
}
