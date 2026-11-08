// How a model downloads: the bar and its detail line, the catalog rows with
// their fit and Download or Cancel download, and any other name typed in. The
// Models page's Download tab shows these as they are, and first run and the
// Installed tab share the detail.
import { useState } from "react";
import type { CatalogEntry, PullProgress } from "@gates-local/contracts";
import { shortGpu } from "./FitPanel.tsx";
import { describeModel, etaText, gb, k, noGpu, verdictOf } from "./format.ts";
import { cancelPull, pull } from "./session.ts";
import { Fail, Grp, Row, useAct } from "./settings-ui.tsx";
import { NA, type State, useStore } from "./store.ts";
import { VLabel, closeTip, esc } from "./ui.tsx";

export const isActive = (p: PullProgress) => p.state === "queued" || p.state === "downloading" || p.state === "verifying";

/** One download detail everywhere a download runs (F64): bar, bytes, speed, time left, Cancel download. */
export function DlDetail({ p, name, cancel = true }: { p: PullProgress; name: string; cancel?: boolean }) {
  const pct = p.totalBytes ? Math.round((p.completedBytes / p.totalBytes) * 100) : 0;
  const [err, run] = useAct();
  return (
    <>
      <div className="prog" role="progressbar" aria-label={`${name} download`} aria-valuenow={pct}>
        <i style={{ width: `${pct}%` }} />
      </div>
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

/** The downloads still running for models not installed yet, one row each, under the Installed list. */
export function DownloadingRows() {
  const pulls = useStore((s) => s.pulls);
  const models = useStore((s) => s.models);
  const catalog = useStore(catalogOf);
  const running = Object.values(pulls).filter((p) => isActive(p) && !(models ?? []).some((m) => m.name === p.name));
  return running.map((p) => {
    const d = describeModel(p.name, catalog);
    return (
      <div key={p.name} className="mp-row mp-dling" data-pull={p.name}>
        <div className="mdl">
          <span className="mn">
            {d.name}
            <small>{d.purpose}</small>
          </span>
          <DlDetail p={p} name={d.name} />
        </div>
      </div>
    );
  });
}

function DlRow({ c, numCtx }: { c: CatalogEntry; numCtx: number }) {
  const p = useStore((s) => s.pulls[c.name]);
  const installed = useStore((s) => c.installed || (s.models ?? []).some((m) => m.name === c.name));
  const v = c.fit ? verdictOf(c.fit) : undefined;
  const cpu = useStore((s) => noGpu(s.gpu));
  const dling = p !== undefined && isActive(p) && !installed;
  const [err, run] = useAct();
  const action = installed ? (
    <span className="badge">Installed</span>
  ) : dling ? (
    <button type="button" className="qa" onClick={() => void run(cancelPull(c.name))}>
      Cancel download
    </button>
  ) : (
    <button type="button" className="qa" disabled={v?.k === "no"} onClick={() => void run(pull(c.name))}>
      Download
    </button>
  );
  return (
    <div className={`dlrow${dling ? " dlg" : ""}`} data-cat={c.name}>
      <div className="sl" data-tip={`<b>${esc(c.label)}</b> · <span class="mono">${esc(c.name)}</span>`}>
        <b>{c.label}</b>
        {dling ? (
          <>
            <span className="d">{c.purpose}</span>
            <DlDetail p={p} name={c.label} cancel={false} />
          </>
        ) : (
          <span className="d">
            {c.purpose} · {gb(c.downloadBytes)} download
          </span>
        )}
        <Fail err={err} />
      </div>
      {v ? (
        <div className="dl-v" data-tip={cpu ? `Estimated ${gb(v.need)} at ${k(numCtx)}, all in system memory (no supported GPU). Measured after the first load.` : `Estimated ${gb(v.need)} at ${k(numCtx)}, of ${gb(v.avail)} available on the GPU. Measured after the first load.`}>
          <VLabel v={v} />
          <small>
            est. {gb(v.need)} at {k(numCtx)}
          </small>
        </div>
      ) : (
        <div className="dl-v" />
      )}
      <div className="dl-a">{action}</div>
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
  const pullNA = useStore((s) => s.unavailable["models.pull"] === true);
  const gpuName = gpu === NA || gpu === undefined || gpu.vendor !== "nvidia" ? "computer" : shortGpu(gpu.name);
  const list = catalog === NA || catalog === undefined ? [] : catalog;
  const rec = list.filter((c) => c.recommended);
  const more = list.filter((c) => !c.recommended);
  const allSpill = more.length > 0 && more.every((c) => c.fit?.verdict === "spills");
  return (
    <>
      <p className="mp-quiet">
        Picked for your {gpuName}. Estimated at your default context, {k(numCtx)}.
      </p>
      {catalog === NA ? (
        <p className="na">The model list is not available in this build. You can still type a model name below.</p>
      ) : null}
      {rec.length > 0 ? (
        <Grp title="Recommended">
          {rec.map((c) => (
            <DlRow key={c.name} c={c} numCtx={numCtx} />
          ))}
        </Grp>
      ) : null}
      {more.length > 0 ? (
        <Grp title={allSpill ? "Also available · uses system memory" : "Also available"}>
          {more.map((c) => (
            <DlRow key={c.name} c={c} numCtx={numCtx} />
          ))}
        </Grp>
      ) : null}
      <Grp title="Something else">{pullNA ? <Row label="Any model from the Ollama library" desc="Downloads are not available in this build." /> : <CustomPull />}</Grp>
    </>
  );
}
