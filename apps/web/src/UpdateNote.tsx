// The startup note stays eager; Settings update controls load with Settings.
import type { UpdateResult } from "@gates-local/contracts";
import { Icon } from "./icons.tsx";
import { dismissUpdateResult } from "./session.ts";
import { NA, useStore } from "./store.ts";

/** The one-time note after an update: shown on the first start after it, until dismissed. */
export function UpdateNoteView({ result, onDismiss }: { result: UpdateResult; onDismiss: () => void }) {
  const ok = result.outcome === "updated";
  return (
    <div className="banner" role={ok ? "status" : "alert"}>
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
  const result = useStore((s) => (s.update === undefined || s.update === NA ? null : s.update.result));
  return result === null ? null : <UpdateNoteView result={result} onDismiss={() => void dismissUpdateResult()} />;
}
