import { pageTitle } from "@gates-local/contracts";
import { Icon } from "../lib/ui/icons.tsx";
import { useStore } from "../lib/store/store.ts";
import { showVersion, shownOf, usePages, useView } from "./pages.ts";
import "./pages.css";

export function PageChip({ code }: { code: string }) {
  const threadId = useStore((s) => s.threadId);
  const { versions, loaded } = usePages(threadId);
  const view = useView(threadId);
  const version = loaded ? versions.find((v) => v.code === code) : undefined;
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
      {!loaded ? <span className="pg-v" aria-hidden="true" style={{ visibility: "hidden" }}>v1</span> : version === undefined ? null : <span className="pg-v">v{version.n}</span>}
    </button>
  );
}

export function WritingChip({ code }: { code: string }) {
  return (
    <div className="pg-chip writing" data-testid="pages.writing" aria-busy="true">
      <Icon id="page" />
      <span className="pg-t">{pageTitle(code)}</span>
      <span className="run-dot" aria-hidden="true" />
    </div>
  );
}
