import type { ReactNode } from "react";

/**
 * Shared eager frame: setup and connection errors always cover an inert app.
 * A line under the title shows only when it says what the title and the
 * status line do not and the person needs it to act: a cause, a step, a
 * number. Without one there is no paragraph and no space for it.
 * `wait` marks a title that changes as a long check answers (docs/design.md).
 */
export function Shell({ st, title, sub, wait = false, children }: { st: ReactNode; title: string; sub?: ReactNode; wait?: boolean; children?: ReactNode }) {
  return (
    <div className="fr">
      <div className="fr-brand">
        <svg className="mark" aria-hidden="true"><use href="#i-mark" /></svg>
        Gates Local
      </div>
      <div className="fr-st">{st}</div>
      <h1 {...(wait ? { "data-wait": "", "data-watch": "title" } : {})}>{title}</h1>
      {sub === undefined ? null : <p className="sub">{sub}</p>}
      {children}
    </div>
  );
}

/**
 * First run before it knows what it will say: the brand as it will be,
 * placeholders where the status, the heading, the model card and the button
 * go (docs/design.md). The usual screen is the found model, so the
 * placeholders take its shape.
 */
export function FirstRunLoading() {
  return (
    <div className="fr" aria-busy="true">
      <div className="fr-brand">
        <svg className="mark" aria-hidden="true"><use href="#i-mark" /></svg>
        Gates Local
      </div>
      <div className="fr-skel" data-skel="" aria-hidden="true">
        <div className="fr-st"><span className="skel" style={{ width: "11em" }} /></div>
        <div className="fr-h"><span className="skel" style={{ width: "7em" }} /></div>
        <div className="fr-card">
          <div className="fr-m"><span className="nm"><span className="skel" style={{ width: "13em" }} /></span></div>
          <div className="think"><span className="skel" style={{ width: "4em" }} /></div>
        </div>
        <div className="fr-cta"><span className="skel fr-btn-skel" /></div>
      </div>
    </div>
  );
}

/** Browser configuration is known before render; this screen needs no import. */
export function NoServer() {
  return (
    <Shell
      st={<><span className="dot err" />No server address</>}
      title="Gates Local can't find its server"
      sub={
        <>
          Start it from the desktop app, or open this page with <span className="mono">?server=</span> set to the server's encoded address,{" "}
          <span className="mono">ws://127.0.0.1:PORT/?token=…</span>
        </>
      }
    />
  );
}
