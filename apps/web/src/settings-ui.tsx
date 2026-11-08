// The building blocks every Settings section uses: the section head, a
// group, a row with its failure line, and the not-available note.
import { type ReactNode, useCallback, useState } from "react";
import type { ActionResult } from "./session.ts";

export const NOT_HERE = "Not available in this build.";

export function Head({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="set-h">
      <h1>{title}</h1>
      <p>{children}</p>
    </div>
  );
}

export function Grp({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="grp">
      {title ? <div className="grp-t">{title}</div> : null}
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

export const Na = ({ children = NOT_HERE }: { children?: ReactNode }) => <span className="na">{children}</span>;
