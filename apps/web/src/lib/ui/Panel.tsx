import type { ReactNode } from "react";
import { Icon } from "./icons.tsx";
import "./panel.css";

function footIconAt(x: number, y: number): HTMLElement | null {
  for (const b of document.querySelectorAll<HTMLElement>(".sb-foot .ibtn")) {
    const r = b.getBoundingClientRect();
    if (x >= r.left && x < r.right && y >= r.top && y < r.bottom) return b;
  }
  return null;
}

function focusBox(el: HTMLDivElement | null): void {
  el?.focus({ preventScroll: true });
}

export function Dialog({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div className="dlg-dim" data-testid="ui.dialog.scrim" aria-hidden="true" onClick={(e) => { const icon = footIconAt(e.clientX, e.clientY); if (icon === null) onClose(); else icon.click(); }} />
      <div ref={focusBox} className="dlg" role="dialog" aria-modal="true" aria-label={label} data-testid="ui.dialog.panel" tabIndex={-1}>
        {children}
      </div>
    </>
  );
}

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
