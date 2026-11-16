import type { ReactNode } from "react";

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
