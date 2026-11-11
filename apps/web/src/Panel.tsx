// The footer's pop-up: one box centred over the chat area (never the
// sidebar) on a flat dim layer, with its own scroll. A click on the dim layer
// closes it; App's Escape and Tab rules close it and hold focus inside.
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { Icon } from "./icons.tsx";
import "./panel.css";

export function PopPanel({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  // focus moves in with the first paint, so a key pressed next lands here
  useLayoutEffect(() => box.current?.focus({ preventScroll: true }), []);
  return (
    <>
      <div className="panel-dim" aria-hidden="true" onClick={onClose} />
      <div ref={box} className="panel" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {children}
      </div>
    </>
  );
}

/** A phone has no footer icon in sight and a thin dim edge: its close button. Hidden on wider screens. */
export function PanelClose({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="ibtn panel-x" aria-label="Close" onClick={onClose}>
      <Icon id="x" />
    </button>
  );
}
