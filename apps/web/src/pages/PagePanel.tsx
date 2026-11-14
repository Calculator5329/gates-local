// The panel right of the chat that runs the chat's pages. Its header names
// the page, steps through every version in the chat, and holds the code view,
// its own window, save and close; the page runs in a locked frame below.
// A narrow window or a phone gets the same panel over the chat.
import { useEffect, useState } from "react";
import { Icon, type IconId } from "../icons.tsx";
import { PAGE_SANDBOX, openPageWindow, pageUrl, savePage } from "./page-doc.ts";
import { closePanel, follow, showVersion, shownOf, usePages, useView } from "./pages.ts";
import "./pages.css";

function HeadButton({ icon, tip, testid, onClick, pressed, disabled, xs }: { icon: IconId; tip: string; testid: string; onClick: () => void; pressed?: boolean; disabled?: boolean; xs?: boolean }) {
  return (
    <button
      type="button"
      className={xs ? "ibtn xs" : "ibtn"}
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
  useEffect(() => follow(threadId, versions), [threadId, versions]);
  const shown = shownOf(view, versions);
  if (view?.open !== true || shown === undefined) return null;
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
        <HeadButton icon="code" tip="Code" testid="pages.panel.code" pressed={code} onClick={() => setCode(!code)} />
        <HeadButton icon="external" tip="Open in window" testid="pages.panel.open-window" onClick={() => openPageWindow(shown.code, shown.title)} />
        <HeadButton icon="download" tip="Save file" testid="pages.panel.save" onClick={() => savePage(shown.code, shown.title)} />
        <HeadButton icon="x" tip="Close" testid="pages.panel.close" onClick={() => closePanel(threadId)} />
      </div>
      {code ? (
        <pre className="pg-code" data-testid="pages.panel.source"><code>{shown.code}</code></pre>
      ) : (
        // a new document per version: nothing one version did carries to the next
        <iframe key={shown.code} className="pg-frame" data-testid="pages.frame" title={shown.title} sandbox={PAGE_SANDBOX} referrerPolicy="no-referrer" src={pageUrl(shown.code)} />
      )}
    </aside>
  );
}
