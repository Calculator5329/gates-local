// Pop-ups over the app. Dialog is T3's: a box centred on the window, about two-thirds of
// its width and as tall as what is in it, over a backdrop that blurs the whole window; its
// content brings the header row (DialogHead) and a body that scrolls (.dlg-body). PopPanel
// is the footer's older pop-up centred over the chat area (Usage, until it moves to Dialog).
// A click on the dim layer closes either; App's Escape and Tab rules close them and hold
// focus inside.
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { Icon } from "./icons.tsx";
import "./panel.css";

export function Dialog({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  // focus moves in with the first paint, so a key pressed next lands here
  useLayoutEffect(() => box.current?.focus({ preventScroll: true }), []);
  return (
    <>
      <div className="dlg-dim" aria-hidden="true" onClick={onClose} />
      <div ref={box} className="dlg" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {children}
      </div>
    </>
  );
}

/** A Dialog's header row: the title at the left, the controls and Close at the right. */
export function DialogHead({ title, onClose, children }: { title: string; onClose: () => void; children?: ReactNode }) {
  return (
    <div className="dlg-head">
      <h2>{title}</h2>
      {children}
      <button type="button" className="ibtn dlg-x" aria-label="Close" data-tip="Close · Esc" onClick={onClose}>
        <Icon id="x" />
      </button>
    </div>
  );
}

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

/** The pop-up's X, last in its header row: the top right corner. */
export function PanelClose({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="ibtn panel-x" aria-label="Close" data-tip="Close · Esc" onClick={onClose}>
      <Icon id="x" />
    </button>
  );
}
