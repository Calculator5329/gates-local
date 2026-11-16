import { useState } from "react";

interface Load {
  readonly since: number | undefined;
  readonly ms: number | undefined;
}

export function LoadRing({ since, ms, ask = false }: Load & { readonly ask?: boolean }) {
  const [delay] = useState(() => (since === undefined ? 0 : Math.min(0, since - Date.now())));
  return (
    <svg className={ms === undefined ? `ldring wait${ask ? " ask" : ""}` : "ldring"} viewBox="0 0 40 40" aria-hidden="true">
      <circle className="ldring-t" cx="20" cy="20" r="18.75" />
      <circle className="ldring-f" cx="20" cy="20" r="18.75" pathLength="100" style={ms === undefined ? undefined : { animationDuration: `${ms}ms`, animationDelay: `${delay}ms` }} />
    </svg>
  );
}

export function DownloadBar({ pct }: { pct: number }) {
  return <span className="ldbar dl" aria-hidden="true" style={{ transform: `scaleX(${Math.min(100, Math.max(0, pct)) / 100})` }} />;
}
