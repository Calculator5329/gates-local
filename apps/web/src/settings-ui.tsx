// The building blocks every Settings section uses: the section head, a
// group, a row with its failure line, and the keyboard rules of a popover.
import { type KeyboardEvent, type ReactNode, type RefObject, useCallback, useEffect, useState } from "react";
import type { ActionResult } from "./session.ts";
import { esc } from "./ui.tsx";

export function Head({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="set-h">
      <h1>{title}</h1>
      {children === undefined ? null : <p>{children}</p>}
    </div>
  );
}

export { Skel } from "./ui.tsx";

/**
 * A label that explains itself on hover or keyboard focus: mechanism, timings
 * and caveats live here, not in a grey paragraph (docs/design.md). The tip is
 * plain text, also given to screen readers as the label's description;
 * `data-tipt` would show only when the label is cut off.
 */
export const Tipped = ({ tip, children }: { tip: string | undefined; children: ReactNode }) =>
  tip === undefined ? <>{children}</> : <span className="tipped" tabIndex={0} aria-description={tip} data-tip={esc(tip)}>{children}</span>;

/** A group is a title and a card, never a line under the title (docs/design.md); `tip` explains the title. `busy` while a placeholder in it shows. */
export function Grp({ title, tip, action, busy = false, children }: { title?: string; tip?: string; action?: ReactNode; busy?: boolean; children: ReactNode }) {
  return (
    <div className="grp" aria-busy={busy || undefined}>
      {title ? (
        <div className="grp-h">
          <div className="grp-l">
            <div className="grp-t"><Tipped tip={tip}>{title}</Tipped></div>
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

/** A row: its label, at most one short grey line that the label and control do not already say, and `tip` for the rest. */
export function Row({ label, desc, tip, err = null, busy = false, children }: { label: ReactNode; desc?: ReactNode; tip?: string; err?: string | null; busy?: boolean; children?: ReactNode }) {
  return (
    <div className="srow" aria-busy={busy || undefined}>
      <div className="sl">
        <b><Tipped tip={tip}>{label}</Tipped></b>
        {desc !== undefined ? <span className="d">{desc}</span> : null}
        <Fail err={err} />
      </div>
      <div className="sv">{children}</div>
    </div>
  );
}

export const Na = ({ children }: { children: ReactNode }) => <span className="na">{children}</span>;

/** Stands in for a control the phone listener refuses. */
export const COMPUTER_ONLY = "Available on the computer.";

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

/** Two choices side by side; the app's control for a short fixed set, never a native select. */
export function Seg2<T extends string | number>({ value, options, onPick, label, disabled = false }: { value: T | undefined; options: readonly (readonly [T, string])[]; onPick: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <span className="seg2" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" className={v === value ? "on" : ""} aria-pressed={v === value} disabled={disabled} onClick={() => onPick(v)}>
          {text}
        </button>
      ))}
    </span>
  );
}

const typed = { text: "", at: 0 };
const nameOf = (el: HTMLElement) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().toLowerCase();
/** Letters typed within a moment of each other find the next item whose name starts with them. */
function find(items: HTMLElement[], at: number, key: string): HTMLElement | undefined {
  const now = Date.now();
  typed.text = now - typed.at < 800 ? typed.text + key.toLowerCase() : key.toLowerCase();
  typed.at = now;
  const from = typed.text.length === 1 ? at + 1 : Math.max(at, 0);
  return [...items.slice(from), ...items.slice(0, from)].find((el) => nameOf(el).startsWith(typed.text));
}

/** Arrow keys walk the items of a menu or list, skipping disabled ones; letters find one by name; Escape closes it. */
export function walk(e: KeyboardEvent<HTMLElement>, box: HTMLElement | null, selector: string, close: () => void): void {
  if (e.key.length !== 1) typed.text = "";
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    close();
    return;
  }
  if (e.key === "Tab") return close();
  const items = [...(box?.querySelectorAll<HTMLElement>(selector) ?? [])].filter((el) => el.getAttribute("aria-disabled") !== "true");
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const hit = find(items, at, e.key);
    if (hit) { e.preventDefault(); hit.focus(); }
    return;
  }
  const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
  if (step === 0 && e.key !== "Home" && e.key !== "End") return;
  e.preventDefault();
  const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + step + items.length) % items.length;
  items[next]?.focus();
}
