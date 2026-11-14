// Pop-ups over the app: Settings, Models and Usage. Dialog is T3 Code's Settings dialog: one
// box of one size for all three, centred on the window, over a backdrop that blurs the whole
// window; its content brings the header row (DialogHead) and a body that scrolls (.dlg-body).
// A click on the dim layer closes it (press and release both on it, as a click is); App's
// Escape and Tab rules close it and hold focus inside.
import { type ReactNode, useLayoutEffect, useRef } from "react";
import { Icon } from "./icons.tsx";
import "./panel.css";

/**
 * The footer icon drawn at this point, under the dim. The icons stay in view beside the box
 * and are toggles (settings row 25), so a click on one does what it does: Settings, Models
 * and Usage switch straight to each other, and the lit one closes its own.
 */
function footIconAt(x: number, y: number): HTMLElement | null {
  for (const b of document.querySelectorAll<HTMLElement>(".sb-foot .ibtn")) {
    const r = b.getBoundingClientRect();
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return b;
  }
  return null;
}

export function Dialog({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  // focus moves in with the first paint, so a key pressed next lands here
  useLayoutEffect(() => box.current?.focus({ preventScroll: true }), []);
  return (
    <>
      <div className="dlg-dim" data-testid="ui.dialog.scrim" aria-hidden="true" onClick={(e) => { const icon = footIconAt(e.clientX, e.clientY); if (icon === null) onClose(); else icon.click(); }} />
      <div ref={box} className="dlg" role="dialog" aria-modal="true" aria-label={label} data-testid="ui.dialog.panel" tabIndex={-1}>
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
      <button type="button" className="ibtn dlg-x" data-testid="ui.dialog.close" aria-label="Close" data-tip="Close · Esc" onClick={onClose}>
        <Icon id="x" />
      </button>
    </div>
  );
}
