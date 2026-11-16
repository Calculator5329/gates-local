import { useRef, useState } from "react";
import { usePopover } from "../lib/ui/kit/popover.ts";
import type { ImageSetup, ImageSetupProgress } from "@gates-local/contracts";
import { gb } from "../lib/words/format.ts";
import { imagesUnset } from "./image-choice.ts";
import { checkImageStatus, loadImageSetup, openSettings, startImageSetup, updateSettings } from "../lib/session/index.ts";
import { NA, getState, setState, useStore } from "../lib/store/store.ts";
import { SheetHead, closePop, place } from "../lib/ui/ui.tsx";

const STEP: Record<ImageSetupProgress["step"], string> = {
  engine: "Downloading the image engine",
  starting: "Starting the image engine",
  model: "Downloading the image model",
  done: "Images are set up",
  error: "Setup stopped",
};

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
  const canSave = useStore((s) => s.unavailable["settings.update"] !== true);
  const notRunning = useStore((s) => s.imageStatus !== NA && s.imageStatus?.addressSet === true && s.imageStatus.state === "missing");
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const progress = setup?.progress;
  const running = progress !== undefined && progress.step !== "done" && progress.step !== "error";
  if (!open && note !== null) setNote(null);
  usePopover(ref, open, (el) => {
    const anchor = document.getElementById("imageBtn");
    if (anchor) place(el, anchor, "start");
    if (kb) el.querySelector<HTMLElement>("button.btn")?.focus();
  }, [kb, setup?.why, setup?.model?.preset]);
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
  const useOwn = async () => {
    setNote(null);
    const error = await updateSettings({ comfyUrl: null });
    if (error !== null) { setNote(error); return; }
    await Promise.all([checkImageStatus(), loadImageSetup()]);
  };
  const offer = canSetUp && setup !== undefined && setup.why === undefined && setup.model !== undefined;
  if (notRunning) {
    return (
      <div className={`pop unset-pop${open ? " open" : ""}`} id="imageUnset" role="dialog" aria-labelledby="imageUnsetT" ref={ref} data-state="not-running">
        <SheetHead title="Image" />
        <p className="unset-t" id="imageUnsetT">ComfyUI is not running</p>
        <p className="unset-d" id="imageUnsetAddress"><code>{address}</code></p>
        {note === null ? null : <p className="unset-d unset-note" role="status">{note}</p>}
        <div className="unset-acts">
          <button type="button" className="btn" data-testid="image.unset.check-again" disabled={checking} onClick={() => void check()}>{checking ? "Checking…" : "Check again"}</button>
          {canSetUp && canSave ? <button type="button" className="btn outline" data-testid="image.unset.use-own" onClick={() => void useOwn()}>Set up here instead</button> : null}
        </div>
      </div>
    );
  }
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
        {offer ? <button type="button" className="btn" data-testid="image.unset.set-up" disabled={running} onClick={() => void go()}>{running ? "Setting up…" : progress?.step === "error" ? "Try again" : "Set up images"}</button> : null}
        <button type="button" className={offer ? "btn outline" : "btn"} data-testid="image.unset.settings" onClick={() => { closePop(); openSettings("images"); }}>{offer ? "Settings" : "Open Settings"}</button>
        {offer ? null : <button type="button" className="btn outline" data-testid="image.unset.check-again-missing" disabled={checking} onClick={() => void check()}>{checking ? "Checking…" : "Check again"}</button>}
      </div>
    </div>
  );
}
