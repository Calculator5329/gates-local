import { type KeyboardEvent, type ReactNode, useCallback, useState } from "react";
import { useDismiss } from "./kit/events.ts";
import { handleKey } from "./handles.ts";
import type { ActionResult } from "../session/index.ts";

export function Head({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="set-h">
      <h1>{title}</h1>
      {children === undefined ? null : <p>{children}</p>}
    </div>
  );
}

export { Skel } from "./ui.tsx";


export function Grp({ title, action, busy = false, children }: { title?: string; action?: ReactNode; busy?: boolean; children: ReactNode }) {
  return (
    <div className="grp" aria-busy={busy || undefined}>
      {title ? (
        <div className="grp-h">
          <div>
            <div className="grp-t">{title}</div>
          </div>
          {action === undefined ? null : <div className="grp-a">{action}</div>}
        </div>
      ) : null}
      <div className="box">{children}</div>
    </div>
  );
}

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

export const Fail = ({ err, line = false }: { err: string | null; line?: boolean }) =>
  err === null ? null : (
    <span className={line ? "act-err line" : "act-err"} role="alert">
      {err}
    </span>
  );

export function Row({ label, desc, err = null, busy = false, children }: { label: ReactNode; desc?: ReactNode; err?: string | null; busy?: boolean; children?: ReactNode }) {
  return (
    <div className="srow" aria-busy={busy || undefined}>
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

export const COMPUTER_ONLY = "Available on the computer.";

export const useOutside = useDismiss;

export function Seg2<T extends string | number>({ value, options, onPick, label, handle, disabled = false }: { value: T | undefined; options: readonly (readonly [T, string])[]; onPick: (v: T) => void; label: string; handle: string; disabled?: boolean }) {
  return (
    <span className="seg2" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={String(v)} type="button" className={v === value ? "on" : ""} data-testid={`settings.segment.${handle}-${handleKey(v)}`} aria-pressed={v === value} disabled={disabled} onClick={() => onPick(v)}>
          {text}
        </button>
      ))}
    </span>
  );
}

const typed = { text: "", at: 0 };
const nameOf = (el: HTMLElement) => (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().toLowerCase();
function find(items: HTMLElement[], at: number, key: string): HTMLElement | undefined {
  const now = Date.now();
  typed.text = now - typed.at < 800 ? typed.text + key.toLowerCase() : key.toLowerCase();
  typed.at = now;
  const from = typed.text.length === 1 ? at + 1 : Math.max(at, 0);
  return [...items.slice(from), ...items.slice(0, from)].find((el) => nameOf(el).startsWith(typed.text));
}

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
