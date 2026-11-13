// Deferred Settings controls live apart from the primitives the startup update notice shares.
import { type ReactNode, useState } from "react";
import { copyText } from "./copy.ts";
import { handleKey } from "./handles.ts";
import { homeTilde } from "./settings-rules.ts";
import { splitTail } from "./models-rules.ts";
import { esc } from "./ui.tsx";

/** One status: a dot carries the colour, the words stay body colour. */
export const Status = ({ dot, children }: { dot: string; children: ReactNode }) => (
  <span className="stat">
    <span className={`dot ${dot}`} />
    {children}
  </span>
);

/** A path on one line, home as ~, cut in the middle; the whole path on hover. */
export function PathText({ path, shown = homeTilde(path) }: { path: string; shown?: string }) {
  const [head, tail] = splitTail(shown);
  return (
    <span className="path mono" tabIndex={0} data-tip={esc(path)} data-testid={`ui.path.${handleKey(path)}`}>
      <span className="mp-h">{head}</span>
      {tail ? <span className="mp-t">{tail}</span> : null}
    </span>
  );
}

/** A Copy button that says what happened until focus leaves it. */
export function CopyButton({ text, label, handle }: { text: string; label: string; handle: string }) {
  const [done, setDone] = useState<boolean | null>(null);
  return (
    <button type="button" className="btn outline copy" data-testid={`settings.copy.${handle}`} aria-label={done === null ? label : undefined} onBlur={() => setDone(null)} onClick={() => void copyText(text).then(setDone)}>
      <span>{done === null ? "Copy" : done ? "Copied" : "Couldn't copy"}</span>
    </button>
  );
}
