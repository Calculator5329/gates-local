// The startup note stays eager; Settings update controls load with Settings.
import type { UpdateResult } from "@gates-local/contracts";
import { Icon } from "./icons.tsx";
import { dismissUpdateResult } from "./session.ts";
import { NA, useStore } from "./store.ts";

/** Keep unsuccessful update results visible until dismissed; successful updates stay silent. */
export function UpdateNoteView({ result, onDismiss }: { result: UpdateResult; onDismiss: () => void }) {
  if (result.outcome === "updated") return null;
  return (
    <div className="banner upd-note" role="alert">
      <Icon id="alert" cls="warn" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="bt">The update did not finish</div>
        <div className="bm">{result.line}</div>
        {result.commands !== undefined && result.commands.length > 0 ? (
          <div className="bm upd-lines mono">
            {result.commands.map((c, i) => (
              <div key={i}>{c}</div>
            ))}
          </div>
        ) : null}
        {result.logPath !== undefined ? (
          <div className="bm">
            The full log is in <span className="mono">{result.logPath}</span>.
          </div>
        ) : null}
        <div className="ba">
          <button type="button" className="btn outline" data-testid="ui.update-note.dismiss" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

export function UpdateNote() {
  const status = useStore((s) => s.update);
  if (status !== undefined && status !== NA && status.installing === true) return <div className="banner" role="status">Gates Local is preparing an update. New replies, image jobs, model downloads and imports are paused until it opens again.</div>;
  const result = status === undefined || status === NA ? null : status.result;
  return result === null ? null : <UpdateNoteView result={result} onDismiss={() => void dismissUpdateResult()} />;
}
