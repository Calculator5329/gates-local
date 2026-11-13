// Images not set up: no ComfyUI answered and the app has none to start. The Image button (and the
// menus' Image rows) open this in place of Image mode, whose Send could not work: one line of why,
// Settings, and Check again, which turns Image on once a ComfyUI answers.
import { useLayoutEffect, useRef, useState } from "react";
import { imagesUnset } from "./image-choice.ts";
import { checkImageStatus, openSettings } from "./session.ts";
import { NA, getState, setState, useStore } from "./store.ts";
import { SheetHead, closePop, place } from "./ui.tsx";

export function ImageUnset() {
  const open = useStore((s) => s.pop?.id === "unset");
  const kb = useStore((s) => s.pop?.id === "unset" && s.pop.kb);
  const address = useStore((s) => (s.imageStatus === NA ? undefined : s.imageStatus?.baseUrl));
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open) { setNote(null); return; }
    const anchor = document.getElementById("imageBtn");
    if (ref.current && anchor) place(ref.current, anchor, "start");
    if (kb) ref.current?.querySelector<HTMLElement>("button.btn")?.focus();
  }, [open, kb]);
  const check = async () => {
    setChecking(true);
    setNote(null);
    const error = await checkImageStatus();
    setChecking(false);
    if (error !== null) setNote(error);
    else if (imagesUnset(getState())) setNote("Still no answer.");
    else { closePop(); setState({ image: true }); }
  };
  return (
    <div className={`pop unset-pop${open ? " open" : ""}`} id="imageUnset" role="dialog" aria-labelledby="imageUnsetT" ref={ref}>
      <SheetHead title="Image" />
      <p className="unset-t" id="imageUnsetT">Images are not set up on this computer.</p>
      <p className="unset-d">Image mode needs ComfyUI, and none answered{address === undefined ? "" : <> at <code>{address}</code></>}.</p>
      {note === null ? null : <p className="unset-d unset-note" role="status">{note}</p>}
      <div className="unset-acts">
        <button type="button" className="btn" onClick={() => { closePop(); openSettings("images"); }}>Open Settings</button>
        <button type="button" className="btn outline" disabled={checking} onClick={() => void check()}>{checking ? "Checking…" : "Check again"}</button>
      </div>
    </div>
  );
}
