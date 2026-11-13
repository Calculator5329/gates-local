// The model button while its model loads into memory (chat row 16): a 2 px
// bar on the button's bottom edge and the time beside the name. A model this
// machine has loaded before fills over its last load and holds at 90% until
// the server says ready; a first load has no end to aim at, so its line moves
// without a percentage and the seconds count up. Nothing here changes size.
import { useEffect, useState } from "react";
import { loadGuess } from "./load-times.ts";

interface Load {
  /** When this client saw the load start; undefined when it never did. */
  readonly since: number | undefined;
  /** The model's last load on this machine, in milliseconds. */
  readonly ms: number | undefined;
}

export function LoadBar({ since, ms }: Load) {
  // started before this mounted (another screen, a remount): the fill is already that far along
  const [delay] = useState(() => (since === undefined ? 0 : Math.min(0, since - Date.now())));
  if (ms === undefined) return <span className="ldbar wait" aria-hidden="true" />;
  return <span className="ldbar" aria-hidden="true" style={{ animationDuration: `${ms}ms`, animationDelay: `${delay}ms` }} />;
}

/** The model's download on the same edge (chat row 29): filled to its percent, which the button's tip says in numbers. */
export function DownloadBar({ pct }: { pct: number }) {
  return <span className="ldbar dl" aria-hidden="true" style={{ transform: `scaleX(${Math.min(100, Math.max(0, pct)) / 100})` }} />;
}

/** "~4 s" for a model loaded before; seconds so far for a first load. */
export function LoadTime({ since, ms }: Load) {
  const [start] = useState(() => since ?? Date.now());
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (ms !== undefined) return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ms]);
  return <>{ms === undefined ? `${Math.max(0, Math.floor((now - start) / 1000))} s` : loadGuess(ms)}</>;
}
