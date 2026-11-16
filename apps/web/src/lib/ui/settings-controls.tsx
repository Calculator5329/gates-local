// why: the startup update notice must not load the deferred Settings controls
import { type ReactNode, useState } from "react";
import { copyText } from "./copy.ts";
import { handleKey } from "./handles.ts";
import { homeTilde } from "../words/settings-rules.ts";
import { splitTail } from "../../models/models-rules.ts";

export const Status = ({ dot, children }: { dot: string; children: ReactNode }) => (
  <span className="stat">
    <span className={`dot ${dot}`} />
    {children}
  </span>
);

export function PathText({ path, shown = homeTilde(path) }: { path: string; shown?: string }) {
  const [head, tail] = splitTail(shown);
  return (
    <span className="path mono" tabIndex={0} data-tipt={path} data-testid={`ui.path.${handleKey(path)}`}>
      <span className="mp-h t">{head}</span>
      {tail ? <span className="mp-t">{tail}</span> : null}
    </span>
  );
}

export function CopyButton({ text, label, handle }: { text: string; label: string; handle: string }) {
  const [done, setDone] = useState<boolean | null>(null);
  return (
    <button type="button" className="btn outline copy" data-testid={`settings.copy.${handle}`} aria-label={done === null ? label : undefined} onBlur={() => setDone(null)} onClick={() => void copyText(text).then(setDone)}>
      <span>{done === null ? "Copy" : done ? "Copied" : "Couldn't copy"}</span>
    </button>
  );
}
