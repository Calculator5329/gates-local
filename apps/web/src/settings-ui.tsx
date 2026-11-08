// The building blocks every Settings section uses: the section head, a
// group, a row with its failure line, and the keyboard rules of a popover.
import { type KeyboardEvent, type ReactNode, type RefObject, useCallback, useEffect, useState } from "react";
import type { ActionResult } from "./session.ts";

export function Head({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="set-h">
      <h1>{title}</h1>
      {children === undefined ? null : <p>{children}</p>}
    </div>
  );
}

/** A group: its label above its helper line, any Add buttons on the right. */
export function Grp({ title, desc, action, children }: { title?: string; desc?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="grp">
      {title ? (
        <div className="grp-h">
          <div className="grp-l">
            <div className="grp-t">{title}</div>
            {desc === undefined ? null : <div className="grp-d">{desc}</div>}
          </div>
          {action === undefined ? null : <div className="grp-a">{action}</div>}
        </div>
      ) : null}
      <div className="box">{children}</div>
    </div>
  );
}

/**
 * The failure of the last action a control ran (W-07): null until one fails,
 * cleared when the next try starts. run resolves true on success.
 */
export function useAct(): [string | null, (action: Promise<ActionResult>) => Promise<boolean>] {
  const [err, setErr] = useState<string | null>(null);
  const run = useCallback(async (action: Promise<ActionResult>) => {
    setErr(null);
    const r = await action;
    setErr(r);
    return r === null;
  }, []);
  return [err, run];
}

/** One calm sentence beside the control that failed. */
export const Fail = ({ err, line = false }: { err: string | null; line?: boolean }) =>
  err === null ? null : (
    <span className={line ? "act-err line" : "act-err"} role="alert">
      {err}
    </span>
  );

export function Row({ label, desc, err = null, children }: { label: ReactNode; desc?: ReactNode; err?: string | null; children?: ReactNode }) {
  return (
    <div className="srow">
      <div className="sl">
        <b>{label}</b>
        {desc !== undefined ? <span className="d">{desc}</span> : null}
        <Fail err={err} />
      </div>
      <div className="sv">{children}</div>
    </div>
  );
}

export const Na = ({ children }: { children: ReactNode }) => <span className="na">{children}</span>;

/** Close a popover on a press outside it. */
export function useOutside(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [ref, open, close]);
}

/** Arrow keys walk the items of a menu or list, skipping disabled ones; Escape closes it. */
export function walk(e: KeyboardEvent<HTMLElement>, box: HTMLElement | null, selector: string, close: () => void): void {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    close();
    return;
  }
  if (e.key === "Tab") return close();
  const items = [...(box?.querySelectorAll<HTMLElement>(selector) ?? [])].filter((el) => el.getAttribute("aria-disabled") !== "true");
  const at = items.indexOf(document.activeElement as HTMLElement);
  const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
  if (step === 0 && e.key !== "Home" && e.key !== "End") return;
  e.preventDefault();
  const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + step + items.length) % items.length;
  items[next]?.focus();
}
