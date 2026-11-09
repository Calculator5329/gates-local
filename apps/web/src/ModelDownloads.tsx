// How a model downloads: the bar and its detail line, the catalog rows with
// their fit and Download or Cancel download, and any other name typed in. The
// Models page's Download tab shows these as they are, and first run and the
// Installed tab share the progress bar and timing words.
import { useEffect, useState } from "react";
import type { CatalogEntry, FitReport, PullProgress } from "@gates-local/contracts";
import { shortGpu } from "./FitPanel.tsx";
import { etaText, gb, k, noGpu, verdictOf } from "./format.ts";
import { Icon } from "./icons.tsx";
import { nameOf, sizeText, splitTail } from "./models-rules.ts";
import { awaitingInstall, pendingDownload } from "./pick.ts";
import { cancelPull, ensureFit, pull } from "./session.ts";
import { Fail, Grp, Row, useAct } from "./settings-ui.tsx";
import { NA, type State, fitKey, useStore } from "./store.ts";
import { VLabel, closeTip, esc } from "./ui.tsx";

function Progress({ p, name }: { p: PullProgress; name: string }) {
  const pct = p.totalBytes ? Math.round((p.completedBytes / p.totalBytes) * 100) : 0;
  return (
    <div className="prog" role="progressbar" aria-label={`${name} download`} aria-valuenow={pct}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

/** First-run detail: bar, bytes, speed, time left, Cancel download. */
export function DlDetail({ p, name, cancel = true }: { p: PullProgress; name: string; cancel?: boolean }) {
  const [err, run] = useAct();
  return (
    <>
      <Progress p={p} name={name} />
      <div className="prog-l">
        <span>{etaText(p)}</span>
        {cancel ? (
          <button
            type="button"
            className="qa"
            onClick={() => {
              closeTip();
              void run(cancelPull(p.name));
            }}
          >
            Cancel download
          </button>
        ) : null}
      </div>
      <Fail err={err} />
    </>
  );
}

const catalogOf = (s: State) => (s.catalog === NA ? undefined : s.catalog);

/** Completed pulls bridge the interval until the installed list arrives. */
export function usePendingDownloads() {
  const pulls = useStore((s) => s.pulls);
  const models = useStore((s) => s.models);
  // A completed pull stays here until the installed list arrives. Otherwise
  // the row briefly vanishes between the two independent push messages.
  return Object.values(pulls).filter((p) => pendingDownload(p, models));
}

export function DownloadingRows() {
  return usePendingDownloads().map((p) => <DownloadingRow key={p.name} p={p} />);
}

export function DownloadingRow({ p }: { p: PullProgress }) {
  const catalog = useStore(catalogOf);
  const n = nameOf(p.name, catalog);
  const [head, tail] = splitTail(n.text);
  const bytes = p.totalBytes ?? catalog?.find((c) => c.name === p.name)?.downloadBytes;
  const size = bytes === undefined ? "Size pending" : sizeText(bytes);
  const state = p.state === "done" ? "Finishing download" : "Downloading";
  const [err, run] = useAct();
  const detail = <span className="prog-l dl-status"><span role={err ? "alert" : undefined} className={err ? "dl-error" : undefined}>{err ?? etaText(p)}</span></span>;
  return (
    <div className="mp-row mp-dling" data-pull={p.name}>
      <div className="mp-nm" data-tip={`${esc(p.name)}${n.purpose ? `<br>${esc(n.purpose)}` : ""}<br>${err ? `${esc(err)}<br>` : ""}${esc(etaText(p))}`}>
        <div className="mp-l1">
          {n.mono ? <span className="mp-tag"><span className="mp-h">{head}</span>{tail ? <span className="mp-t">{tail}</span> : null}</span> : <span className="mp-nmn">{n.text}</span>}
        </div>
        {n.purpose ? <div className="mp-p">{detail}</div> : null}
        <div className="mp-meta">
          <span>{size}</span><span aria-hidden="true">·</span>{n.purpose ? <span>{state}</span> : detail}
        </div>
      </div>
      <span className="mp-sz">{size}</span>
      <span className="mp-fitc"><span className="mp-fit none">{n.purpose ? state : detail}</span></span>
      <div className="mp-acts">
        <button
          type="button"
          className="mp-kebab"
          aria-label="Cancel download"
          data-tip="Cancel download"
          disabled={p.state === "done"}
          onClick={() => {
            closeTip();
            void run(cancelPull(p.name));
          }}
        >
          <Icon id="x" />
        </button>
      </div>
      <Progress p={p} name={n.text} />
    </div>
  );
}

function DlRow({ c, numCtx, report }: { c: CatalogEntry; numCtx: number; report: FitReport | undefined }) {
  const p = useStore((s) => s.pulls[c.name]);
  const installed = useStore((s) => c.installed || (s.models ?? []).some((m) => m.name === c.name));
  const v = report ? verdictOf(report) : undefined;
  const context = report?.numCtx ?? numCtx;
  const basis = v?.measured ? "Measured" : "Estimated";
  const note = v?.measured ? "From the current load." : "Measured after the first load.";
  const cpu = useStore((s) => noGpu(s.gpu));
  const dling = p !== undefined && awaitingInstall(p) && !installed;
  const [err, run] = useAct();
  const action = installed ? (
    <span className="badge">Installed</span>
  ) : dling ? (
    <button type="button" className="qa" disabled={p.state === "done"} onClick={() => void run(cancelPull(c.name))}>
      Cancel download
    </button>
  ) : (
    <button type="button" className="qa" disabled={v?.k === "no"} onClick={() => void run(pull(c.name))}>
      Download
    </button>
  );
  return (
    <div className="dlrow" data-cat={c.name}>
      <div className="sl" data-tip={`<b>${esc(c.label)}</b> · <span class="mono">${esc(c.name)}</span>`}>
        <b>{c.label}</b>
        <span className="d">{c.purpose}</span>
        <div className="prog-l dl-status" data-tip={err ? esc(err) : dling ? esc(etaText(p)) : undefined}>
          <span role={err ? "alert" : undefined} className={err ? "dl-error" : undefined}>{err ?? (dling ? etaText(p) : `${gb(c.downloadBytes)} download`)}</span>
        </div>
      </div>
      {v ? (
        <div className="dl-v" data-tip={cpu ? `${basis} ${gb(v.need)} at ${k(context)}, all in system memory (no supported GPU). ${note}` : `${basis} ${gb(v.need)} at ${k(context)}, of ${gb(v.avail)} available on the GPU. ${note}`}>
          <VLabel v={v} />
          <small>
            {v.measured ? "measured" : "est."} {gb(v.need)} at {k(context)}
          </small>
        </div>
      ) : (
        <div className="dl-v"><small>Checking at {k(numCtx)}…</small></div>
      )}
      <div className="dl-a">{action}</div>
      {dling ? <Progress p={p} name={c.label} /> : null}
    </div>
  );
}

function CustomPull() {
  const [name, setName] = useState("");
  const [err, run] = useAct();
  return (
    <Row
      err={err}
      label="Any model from the Ollama library"
      desc={
        <>
          Type its name as it appears in the library.
          <span className="d" style={{ display: "block" }}>
            <a className="link" href="https://ollama.com/library" target="_blank" rel="noreferrer noopener" aria-label="Browse the Ollama library at ollama.com/library (opens your browser)">
              Browse the Ollama library ↗
            </a>
          </span>
        </>
      }
    >
      <input className="inp" placeholder="Model name, e.g. phi5:14b" aria-label="Model name" value={name} onChange={(e) => setName(e.target.value)} />
      <button
        type="button"
        className="qa"
        disabled={name.trim() === ""}
        onClick={() => {
          // the typed name stays until the download starts (W-07)
          void run(pull(name)).then((ok) => ok && setName(""));
        }}
      >
        Download
      </button>
    </Row>
  );
}

/** The Download tab. */
export function DownloadTab() {
  const catalog = useStore((s) => s.catalog);
  const numCtx = useStore((s) => s.numCtx);
  const gpu = useStore((s) => s.gpu);
  const fits = useStore((s) => s.fits);
  const pullNA = useStore((s) => s.unavailable["models.pull"] === true);
  const gpuName = gpu === NA || gpu === undefined || gpu.vendor !== "nvidia" ? "computer" : shortGpu(gpu.name);
  const list = catalog === NA || catalog === undefined ? [] : catalog;
  const report = (c: CatalogEntry) => {
    const r = fits[fitKey(c.name, numCtx)];
    return r === "error" ? undefined : r ?? (c.fit?.numCtx === numCtx ? c.fit : undefined);
  };
  useEffect(() => {
    for (const c of list) ensureFit(c.name, numCtx);
  }, [catalog, numCtx, fits]);
  const rec = list.filter(c => c.recommended && (report(c)?.verdict === "fits" || (noGpu(gpu) && report(c)?.verdict === "spills")));
  const more = list.filter(c => !rec.includes(c));
  const allSpill = more.length > 0 && more.every(c => report(c)?.verdict === "spills");
  return (
    <>
      <p className="mp-quiet">
        Picked for your {gpuName}. Memory at your current context, {k(numCtx)}.
      </p>
      {catalog === NA ? (
        <p className="na">The model list is not available in this build. You can still type a model name below.</p>
      ) : null}
      {rec.length > 0 ? (
        <Grp title="Recommended">
          {rec.map((c) => (
            <DlRow key={c.name} c={c} numCtx={numCtx} report={report(c)} />
          ))}
        </Grp>
      ) : null}
      {more.length > 0 ? (
        <Grp title={allSpill ? "Also available · uses system memory" : "Also available"}>
          {more.map((c) => (
            <DlRow key={c.name} c={c} numCtx={numCtx} report={report(c)} />
          ))}
        </Grp>
      ) : null}
      <Grp title="Something else">{pullNA ? <Row label="Any model from the Ollama library" desc="Downloads are not available in this build." /> : <CustomPull />}</Grp>
    </>
  );
}
