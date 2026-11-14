// The panel right of the chat that runs the chat's pages. Its header names
// the page, steps through every version in the chat, and holds the code view,
// its own window, save and close; the page runs in a locked frame below.
// A narrow window or a phone gets the same panel over the chat, without the
// own-window button, and there a chat's first page waits for its chip.
import { useEffect, useMemo, useState } from "react";
import { Icon, type IconId } from "../icons.tsx";
import { useMedia } from "../ui.tsx";
import { COVER, setCovering } from "./cover.ts";
import { PAGE_SANDBOX, PAGE_URL_MAX, openPageWindow, pageMb, pageUrl, savePage } from "./page-doc.ts";
import { closePanel, follow, showVersion, shownOf, usePages, useView } from "./pages.ts";
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
  const { versions } = usePages(threadId);
  const view = useView(threadId);
  const [code, setCode] = useState(false);
  const cover = useMedia(COVER);
  useEffect(() => follow(threadId, versions, !cover), [threadId, versions, cover]);
  const shown = shownOf(view, versions);
  const visible = view?.open === true && shown !== undefined;
  // over the chat, the chat under it takes no keys (App reads this)
  useEffect(() => {
    setCovering(cover && visible);
    return () => setCovering(false);
  }, [cover, visible]);
  const url = useMemo(() => (shown === undefined ? "" : pageUrl(shown.code)), [shown]);
  if (!visible) return null;
  // a page whose address is past what a frame loads cannot run: its code, and why
  const big = url.length > PAGE_URL_MAX;
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
        <HeadButton icon="code" tip="Code" testid="pages.panel.code" pressed={code || big} disabled={big} onClick={() => setCode(!code)} />
        <HeadButton cls="pg-wide" icon="external" tip="Open in window" testid="pages.panel.open-window" disabled={big} onClick={() => openPageWindow(shown.code, shown.title)} />
        <HeadButton icon="download" tip="Save file" testid="pages.panel.save" onClick={() => savePage(shown.code, shown.title)} />
        <HeadButton icon="x" tip="Close" testid="pages.panel.close" onClick={() => closePanel(threadId)} />
      </div>
      {big ? <div className="pg-big" data-testid="pages.too-big">Too big to run here · {pageMb(shown.code)} MB</div> : null}
      {code || big ? (
        <pre className="pg-code" data-testid="pages.panel.source"><code>{shown.code}</code></pre>
      ) : (
        // a new document per version: nothing one version did carries to the next
        <iframe key={shown.code} className="pg-frame" data-testid="pages.frame" title={shown.title} sandbox={PAGE_SANDBOX} referrerPolicy="no-referrer" src={url} />
      )}
    </aside>
  );
}
