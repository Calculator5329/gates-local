// Images not set up: no ComfyUI answered and the app has none to start. The Image button (and the
// menus' Image rows) open this in place of Image mode, whose Send could not work. Where the app can
// set images up here, it shows the one download (the app's own ComfyUI and the recommended setup)
// and Set up images starts it; where it cannot, one sentence says why. Settings and Check again
// stay for a ComfyUI the person runs.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ImageSetup, ImageSetupProgress } from "@gates-local/contracts";
import { gb } from "./format.ts";
import { imagesUnset } from "./image-choice.ts";
import { checkImageStatus, loadImageSetup, openSettings, startImageSetup } from "./session.ts";
import { NA, getState, setState, useStore } from "./store.ts";
import { SheetHead, closePop, place } from "./ui.tsx";

const STEP: Record<ImageSetupProgress["step"], string> = {
  engine: "Downloading the image engine",
  starting: "Starting the image engine",
  model: "Downloading the image model",
  done: "Images are set up",
  error: "Setup stopped",
};

/** The download, before it starts: one row, its size, and what the drive has. */
function Plan({ s }: { s: ImageSetup }) {
  const engine = s.engine !== undefined && !s.engine.installed ? s.engine.bytes : 0;
  const total = engine + (s.model?.bytes ?? 0);
  return (
    <div className="setup-card" id="imageSetupPlan">
      <div className="setup-m"><span className="nm">{s.model?.name}</span><span className="setup-sz">{gb(total)}</span></div>
      <div className="setup-sub">{engine > 0 ? `With the image engine (ComfyUI ${s.engine!.version}), ${gb(engine)}` : "The image engine is in place"}</div>
      {s.cpu === undefined ? null : <div className="setup-sub">No graphics card for pictures here: each picture takes about {Math.round(s.cpu.low / 60)} to {Math.round(s.cpu.high / 60)} minutes on the processor.</div>}
      {s.freeBytes === undefined || s.needBytes === undefined ? null : <div className="setup-sub">Needs {gb(s.needBytes)} free; {gb(s.freeBytes)} is free.</div>}
    </div>
  );
}

function Running({ p }: { p: ImageSetupProgress }) {
  const pct = p.totalBytes > 0 ? Math.round((p.completedBytes / p.totalBytes) * 100) : 0;
  return (
    <div className="setup-card" id="imageSetupRun">
      <div className="setup-m"><span className="nm">{STEP[p.step]}</span></div>
      {p.step === "error" ? null : (
        <>
          <div className="prog" role="progressbar" aria-label="Image setup" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
          <div className="prog-l"><span>{gb(p.completedBytes)} of {gb(p.totalBytes)}</span></div>
        </>
      )}
      {p.message === undefined ? null : <p className="unset-d unset-note" role="status">{p.message}</p>}
    </div>
  );
}

export function ImageUnset() {
  const open = useStore((s) => s.pop?.id === "unset");
  const kb = useStore((s) => s.pop?.id === "unset" && s.pop.kb);
  const address = useStore((s) => (s.imageStatus === NA ? undefined : s.imageStatus?.baseUrl));
  const setup = useStore((s) => s.imageSetup);
  const canSetUp = useStore((s) => s.unavailable["image.setup"] !== true);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const progress = setup?.progress;
  const running = progress !== undefined && progress.step !== "done" && progress.step !== "error";
  useEffect(() => { if (open) void loadImageSetup(); }, [open]);
  useLayoutEffect(() => {
    if (!open) { setNote(null); return; }
    const anchor = document.getElementById("imageBtn");
    if (ref.current && anchor) place(ref.current, anchor, "start");
    if (kb) ref.current?.querySelector<HTMLElement>("button.btn")?.focus();
  }, [open, kb, setup?.why, setup?.model?.preset]);
  // the setup's end turns Image on, as Check again does once a ComfyUI answers
  useEffect(() => {
    if (open && progress?.step === "done" && !imagesUnset(getState())) { closePop(); setState({ image: true }); }
  });
  const check = async () => {
    setChecking(true);
    setNote(null);
    const error = await checkImageStatus();
    setChecking(false);
    if (error !== null) setNote(error);
    else if (imagesUnset(getState())) setNote("Still no answer.");
    else { closePop(); setState({ image: true }); }
  };
  const go = async () => {
    setNote(null);
    const error = await startImageSetup();
    if (error !== null) setNote(error);
  };
  const offer = canSetUp && setup !== undefined && setup.why === undefined && setup.model !== undefined;
  return (
    <div className={`pop unset-pop${open ? " open" : ""}`} id="imageUnset" role="dialog" aria-labelledby="imageUnsetT" ref={ref}>
      <SheetHead title="Image" />
      <p className="unset-t" id="imageUnsetT">Images are not set up on this computer.</p>
      {setup?.why !== undefined
        ? <p className="unset-d" id="imageSetupWhy">{setup.why}</p>
        : offer ? null : <p className="unset-d">Image mode needs ComfyUI, and none answered{address === undefined ? "" : <> at <code>{address}</code></>}.</p>}
      {offer && progress !== undefined && progress.step !== "done" ? <Running p={progress} /> : offer ? <Plan s={setup} /> : null}
      {note === null ? null : <p className="unset-d unset-note" role="status">{note}</p>}
      <div className="unset-acts">
        {offer ? <button type="button" className="btn" disabled={running} onClick={() => void go()}>{running ? "Setting up…" : progress?.step === "error" ? "Try again" : "Set up images"}</button> : null}
        <button type="button" className={offer ? "btn outline" : "btn"} onClick={() => { closePop(); openSettings("images"); }}>{offer ? "Settings" : "Open Settings"}</button>
        {offer ? null : <button type="button" className="btn outline" disabled={checking} onClick={() => void check()}>{checking ? "Checking…" : "Check again"}</button>}
      </div>
    </div>
  );
}
