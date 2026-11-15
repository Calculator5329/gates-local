// A model loading into memory, shown where the wait is (chat row 34, owner's
// pick D, 2026-11-13): a ring around Send while a message waits for the load,
// and nothing on the model button. A model this machine has loaded before
// fills the ring over its last load and holds at 90% until the server says
// ready; a first load has no end to aim at, so an arc turns without one. The
// time is in the model button's tip.
import { useState } from "react";

interface Load {
  /** When this client saw the load start; undefined when it never did. */
  readonly since: number | undefined;
  /** The model's last load on this machine, in milliseconds. */
  readonly ms: number | undefined;
}

export function LoadRing({ since, ms, ask = false }: Load & { readonly ask?: boolean }) {
  // started before this mounted (another screen, a remount): the fill is already that far along
  const [delay] = useState(() => (since === undefined ? 0 : Math.min(0, since - Date.now())));
  // ask: a send asking the server what it would stop; the turning arc shows only if that takes a moment
  return (
    <svg className={ms === undefined ? `ldring wait${ask ? " ask" : ""}` : "ldring"} viewBox="0 0 40 40" aria-hidden="true">
      <circle className="ldring-t" cx="20" cy="20" r="18.75" />
      <circle className="ldring-f" cx="20" cy="20" r="18.75" pathLength="100" style={ms === undefined ? undefined : { animationDuration: `${ms}ms`, animationDelay: `${delay}ms` }} />
    </svg>
  );
}

/** The model's download, a 2 px bar on the model button's bottom edge (chat row 29): filled to its percent, which the button's tip says in numbers. */
export function DownloadBar({ pct }: { pct: number }) {
  return <span className="ldbar dl" aria-hidden="true" style={{ transform: `scaleX(${Math.min(100, Math.max(0, pct)) / 100})` }} />;
}
