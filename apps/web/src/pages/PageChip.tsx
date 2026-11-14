// What a page in a reply becomes: one chip naming the page and its version.
// Clicking it shows that version in the panel.
import { pageTitle } from "@gates-local/contracts";
import { Icon } from "../icons.tsx";
import { useStore } from "../store.ts";
import { showVersion, shownOf, usePages, useView } from "./pages.ts";
import "./pages.css";

export function PageChip({ code }: { code: string }) {
  const threadId = useStore((s) => s.threadId);
  const { versions } = usePages(threadId);
  const view = useView(threadId);
  const version = versions.find((v) => v.code === code);
  const on = view?.open === true && version !== undefined && shownOf(view, versions) === version;
  return (
    <button
      type="button"
      className={`pg-chip${on ? " on" : ""}`}
      data-testid="pages.chip"
      aria-pressed={on}
      onClick={() => { if (threadId !== null && version !== undefined) showVersion(threadId, version.n, versions); }}
    >
      <Icon id="page" />
      <span className="pg-t">{version?.title ?? pageTitle(code)}</span>
      {version === undefined ? null : <span className="pg-v">v{version.n}</span>}
    </button>
  );
}

/** A page still arriving: no code and no counter; the panel keeps the version before it. */
export function WritingChip() {
  return (
    <div className="pg-chip writing" data-testid="pages.writing">
      <Icon id="page" />
      Writing page…
    </div>
  );
}
