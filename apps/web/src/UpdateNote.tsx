// The startup note stays eager; Settings update controls load with Settings.
import type { UpdateResult } from "@gates-local/contracts";
import { Icon } from "./icons.tsx";
import { dismissUpdateResult } from "./session.ts";
import { NA, useStore } from "./store.ts";

/** The one-time note after an update: shown on the first start after it, until dismissed. */
export function UpdateNoteView({ result, onDismiss }: { result: UpdateResult; onDismiss: () => void }) {
  const ok = result.outcome === "updated";
  return (
    <div className="banner upd-note" role={ok ? "status" : "alert"}>
      <Icon id={ok ? "checkc" : "alert"} cls={ok ? undefined : "warn"} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="bt">{ok ? "Gates Local updated" : "The update did not finish"}</div>
        <div className="bm">{result.line}</div>
        {result.commands !== undefined && result.commands.length > 0 ? (
          <div className="bm upd-lines mono">
            {result.commands.map((c, i) => (
              <div key={i}>{c}</div>
            ))}
          </div>
        ) : null}
        {!ok && result.logPath !== undefined ? (
          <div className="bm">
            The full log is in <span className="mono">{result.logPath}</span>.
          </div>
        ) : null}
        <div className="ba">
          <button type="button" className="btn outline" onClick={onDismiss}>
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
