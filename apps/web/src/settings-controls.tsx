// Deferred Settings controls live apart from the primitives the startup update notice shares.
import { type ReactNode, useState } from "react";
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
    <span className="path mono" tabIndex={0} data-tip={esc(path)}>
      <span className="mp-h">{head}</span>
      {tail ? <span className="mp-t">{tail}</span> : null}
    </span>
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // a browser without clipboard access: the old way
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** A Copy button that says what happened until focus leaves it. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState<boolean | null>(null);
  return (
    <button type="button" className="btn outline copy" aria-label={done === null ? label : undefined} onBlur={() => setDone(null)} onClick={() => void copyText(text).then(setDone)}>
      <span>{done === null ? "Copy" : done ? "Copied" : "Couldn't copy"}</span>
    </button>
  );
}
