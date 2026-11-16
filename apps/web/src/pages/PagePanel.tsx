import { useEffect, useMemo, useState } from "react";
import { Icon, type IconId } from "../lib/ui/icons.tsx";
import { useStore } from "../lib/store/store.ts";
import { useMedia } from "../lib/ui/ui.tsx";
import { COVER, setCovering } from "./cover.ts";
import { PAGE_MAX, PAGE_SANDBOX, type PageAddress, openPageWindow, pageAddress, pageBytes, pageMb, savePage } from "./page-doc.ts";
import { closePanel, follow, showVersion, shownOf, usePages, useView } from "./pages.ts";
import { useSandboxOff } from "./sandbox.ts";
import "./pages.css";

function HeadButton({ icon, tip, testid, onClick, pressed, disabled, xs, cls }: { icon: IconId; tip: string; testid: string; onClick: () => void; pressed?: boolean; disabled?: boolean; xs?: boolean; cls?: string }) {
  return (
    <button
      type="button"
      className={`${xs ? "ibtn xs" : "ibtn"}${cls ? ` ${cls}` : ""}`}
      data-testid={testid}
      aria-label={tip}
      data-tip={tip}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon id={icon} cls={xs ? "s14" : undefined} />
    </button>
  );
}

export function PagePanel({ threadId }: { threadId: string }) {
  const { versions, loaded } = usePages(threadId);
  const view = useView(threadId);
  const [code, setCode] = useState(false);
  const cover = useMedia(COVER);
  const origin = useStore((s) => s.serverOrigin);
  const token = useStore((s) => s.fileToken);
  const sandboxOff = useSandboxOff();
  const [ran, setRan] = useState<string | null>(null);
  // oxlint-disable-next-line gates/effect-needs-reason -- a new version arrives by the reply stream, not a handler here; the panel's own store follows it
  useEffect(() => { if (loaded) follow(threadId, versions, !cover); }, [threadId, versions, cover, loaded]);
  const shown = shownOf(view, versions);
  const visible = loaded && view?.open === true && shown !== undefined;
  // oxlint-disable-next-line gates/effect-needs-reason -- tells App the panel covers the chat for exactly as long as it is drawn over it, and clears it on unmount
  useEffect(() => {
    setCovering(cover && visible);
    return () => setCovering(false);
  }, [cover, visible]);
  const big = useMemo(() => shown !== undefined && pageBytes(shown.code) > PAGE_MAX, [shown]);
  const held = sandboxOff === true && ran !== shown?.code;
  const runs = visible && !code && !big && sandboxOff !== undefined && !held;
  const [address, setAddress] = useState<{ readonly code: string; readonly a: PageAddress } | null>(null);
  const shownCode = shown?.code;
  // oxlint-disable-next-line gates/effect-needs-reason -- fetches a one-time address for the version on show, and drops an answer that lands after it changed
  useEffect(() => {
    if (!runs || shownCode === undefined) return;
    let live = true;
    void pageAddress(shownCode, { origin, token }).then((a) => { if (live) setAddress({ code: shownCode, a }); });
    return () => { live = false; setAddress(null); };
  }, [runs, shownCode, origin, token]);
  if (!visible) return null;
  const a = address?.code === shown.code ? address.a : undefined;
  const failed = a !== undefined && "error" in a ? a.error : big ? "too-big" : undefined;
  const source = code || held || failed !== undefined;
  const step = (n: number) => showVersion(threadId, n, versions);
  return (
    <aside className="pg-panel" aria-label="Page" data-testid="pages.panel">
      <div className="pg-head">
        <Icon id="page" />
        <span className="pg-name" data-testid="pages.panel.title">{shown.title}</span>
        <span className="pg-step">
          <HeadButton xs icon="left" tip="Older version" testid="pages.panel.older" disabled={shown.n === 1} onClick={() => step(shown.n - 1)} />
          <span data-testid="pages.panel.step">{shown.n} of {versions.length}</span>
          <HeadButton xs icon="right" tip="Newer version" testid="pages.panel.newer" disabled={shown.n === versions.length} onClick={() => step(shown.n + 1)} />
        </span>
        <span className="pg-sep" />
        <HeadButton icon="code" tip="Code" testid="pages.panel.code" pressed={source} disabled={big || held || failed !== undefined} onClick={() => setCode(!code)} />
        <HeadButton cls="pg-wide" icon="external" tip="Open in window" testid="pages.panel.open-window" disabled={big || held || sandboxOff === undefined} onClick={() => openPageWindow(shown.code, shown.title, { origin, token })} />
        <HeadButton icon="download" tip="Save file" testid="pages.panel.save" onClick={() => savePage(shown.code, shown.title)} />
        <HeadButton icon="x" tip="Close" testid="pages.panel.close" onClick={() => closePanel(threadId)} />
      </div>
      {held ? (
        <div className="pg-big pg-held" data-testid="pages.held">
          <Icon id="lock" cls="s14" />
          <span>Chromium&apos;s sandbox is off in this copy, so pages run only on Run</span>
          <button type="button" className="btn outline" data-testid="pages.run" onClick={() => { setRan(shown.code); setCode(false); }}>Run</button>
        </div>
      ) : failed === "too-big" ? (
        <div className="pg-big" data-testid="pages.too-big">Too big to run here · {pageMb(shown.code)} MB</div>
      ) : failed !== undefined ? (
        <div className="pg-big" data-testid="pages.not-run">The server did not take this page, so it cannot run</div>
      ) : null}
      {source ? (
        <pre className="pg-code" data-testid="pages.panel.source"><code>{shown.code}</code></pre>
      ) : a !== undefined && "url" in a ? (
        <iframe key={a.url} className="pg-frame" data-testid="pages.frame" title={shown.title} sandbox={PAGE_SANDBOX} referrerPolicy="no-referrer" allow="" src={a.url} />
      ) : (
        <div className="pg-frame" aria-hidden="true" />
      )}
    </aside>
  );
}
