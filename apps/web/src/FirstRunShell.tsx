import type { ReactNode } from "react";
import { Icon } from "./icons.tsx";

/** Shared eager frame: setup and connection errors always cover an inert app. */
export function Shell({ st, title, sub, children }: { st: ReactNode; title: string; sub: ReactNode; children?: ReactNode }) {
  return (
    <div className="fr">
      <div className="fr-brand">
        <svg className="mark" aria-hidden="true"><use href="#i-mark" /></svg>
        Gates Local
      </div>
      <div className="fr-st">{st}</div>
      <h1>{title}</h1>
      <p className="sub">{sub}</p>
      {children}
      <div className="fr-foot">
        <Icon id="lock" cls="s14" />
        Runs on your computer. Nothing leaves your own network.
      </div>
    </div>
  );
}

export function FirstRunLoading() {
  return (
    <Shell
      st={<><span className="dot run" />Looking for Ollama</>}
      title="Starting up"
      sub="Checking for Ollama and your models."
    />
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
