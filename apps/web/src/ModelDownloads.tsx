// How a model downloads: the bar and its detail line, the catalog rows with
// their fit and Download or Cancel download, and any other name typed in. The
// Models page's Download tab shows these as they are, and first run and the
// Installed tab share the progress bar and timing words.
import { useEffect, useState } from "react";
import type { CatalogEntry, FitReport, PullProgress } from "@gates-local/contracts";
import { shortGpu } from "./FitPanel.tsx";
import { etaText, gb, k, noGpu, verdictOf } from "./format.ts";
import { Icon } from "./icons.tsx";
import { MakerMark } from "./MakerMark.tsx";
import { fitPendingWord, fitReading } from "./fit-state.ts";
import { nameOf, shortTag, sizeText, splitTail } from "./models-rules.ts";
import { awaitingInstall, modelNameKey, pendingDownload } from "./pick.ts";
import { type ActionResult, cancelPull, ensureFit, pull } from "./session.ts";
import { PathText } from "./settings-controls.tsx";
import { Fail, Grp, Row, useAct } from "./settings-ui.tsx";
import { NA, type State, fitKey, getState, useStore } from "./store.ts";
import { Skel, VLabel, closeTip, esc } from "./ui.tsx";

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
  const canCancel = useStore(canCancelPull);
  return (
    <>
      <Progress p={p} name={name} />
      <div className="prog-l">
        <span>{etaText(p)}</span>
        {cancel && canCancel ? (
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

/** The phone watches a download; only the computer can cancel one. */
export const canCancelPull = (s: State): boolean => s.unavailable["models.cancelPull"] !== true;

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
  const canCancel = useStore(canCancelPull);
  const detail = <span className="prog-l dl-status"><span role={err ? "alert" : undefined} className={err ? "dl-error" : undefined}>{err ?? etaText(p)}</span></span>;
  return (
    <div className="mp-row mp-dling" data-pull={p.name}>
      <div className="mp-nm" data-tip={`${esc(p.name)}${n.purpose ? `<br>${esc(n.purpose)}` : ""}<br>${err ? `${esc(err)}<br>` : ""}${esc(etaText(p))}`}>
        <div className="mp-l1">
          <MakerMark tag={p.name} />
          {n.id ? <span className="mp-tag"><span className="mp-h">{head}</span>{tail ? <span className="mp-t">{tail}</span> : null}</span> : <span className="mp-nmn">{n.text}</span>}
        </div>
        {n.purpose ? <div className="mp-p">{detail}</div> : n.id === undefined ? null : <div className="mp-p"><PathText path={n.id} shown={shortTag(n.id)} /></div>}
        <div className="mp-meta">
          <span>{size}</span><span aria-hidden="true">·</span>{n.purpose ? <span>{state}</span> : detail}
        </div>
      </div>
      <span className="mp-sz">{size}</span>
      <span className="mp-fitc"><span className="mp-fit none">{n.purpose ? state : detail}</span></span>
      <div className="mp-acts">
        {canCancel ? (
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
        ) : null}
      </div>
      <Progress p={p} name={n.text} />
    </div>
  );
}

const downloadKey = (name: string) => modelNameKey(name.trim().toLowerCase());
interface DownloadActions {
  start(name: string): Promise<boolean>;
  cancel(name: string): void;
  error(name: string): ActionResult;
}

function DlRow({ c, numCtx, report, actions }: { c: CatalogEntry; numCtx: number; report: FitReport | undefined; actions: DownloadActions }) {
  const p = useStore(s => Object.values(s.pulls).findLast(progress => downloadKey(progress.name) === downloadKey(c.name) && awaitingInstall(progress)));
  const installed = useStore((s) => c.installed || (s.models ?? []).some((m) => downloadKey(m.name) === downloadKey(c.name)));
  const phase = useStore(s => fitReading(s, c.name, numCtx).phase);
  const v = report && phase === "fresh" ? verdictOf(report) : undefined;
  const context = report?.numCtx ?? numCtx;
  const basis = v?.measured ? "Measured" : "Estimated";
  const note = v?.measured ? "From the current load." : "Measured after the first load.";
  const cpu = useStore((s) => noGpu(s.gpu));
  const dling = p !== undefined && awaitingInstall(p) && !installed;
  const err = installed ? null : actions.error(c.name);
  const action = installed ? (
    <span className="badge">Installed</span>
  ) : dling ? (
    <button type="button" className="qa" disabled={p.state === "done"} onClick={() => actions.cancel(p.name)}>
      Cancel download
    </button>
  ) : (
    <button type="button" className="qa" disabled={v?.k === "no"} onClick={() => void actions.start(c.name)}>
      Download
    </button>
  );
  return (
    <div className="dlrow" data-cat={c.name}>
      <MakerMark tag={c.name} />
      <div className="sl" data-tip={`<b>${esc(c.label)}</b> · <span class="mono">${esc(c.name)}</span>`}>
        <b>{c.label}</b>
        <span className="d">{c.purpose}</span>
        <div className="prog-l dl-status" data-tip={err ? esc(err) : dling ? esc(etaText(p)) : undefined}>
          <span role={err ? "alert" : undefined} className={err ? "dl-error" : undefined}>{err ?? (dling ? etaText(p) : `${gb(c.downloadBytes)} download`)}</span>
        </div>
      </div>
      {/* A fit check is long by nature: the slot keeps its box while its words change (docs/design.md). */}
      {v ? (
        <div className="dl-v" data-wait="" data-tip={cpu ? `${basis} ${gb(v.need)} at ${k(context)}, all in system memory (no supported GPU). ${note}` : `${basis} ${gb(v.need)} at ${k(context)}, of ${gb(v.avail)} available on the GPU. ${note}`}>
          <VLabel v={v} />
          <small>
            {v.measured ? "measured" : "est."} {gb(v.need)} at {k(context)}
          </small>
        </div>
      ) : (
        <div className="dl-v" data-wait=""><small>{fitPendingWord(phase, report !== undefined)} at {k(numCtx)}</small></div>
      )}
      <div className="dl-a">{action}</div>
      {dling ? <Progress p={p} name={c.label} /> : null}
    </div>
  );
}

function CustomPull({ actions }: { actions: DownloadActions }) {
  const [name, setName] = useState("");
  return (
    <Row
      err={actions.error(name)}
      label="Any model from the Ollama library"
      desc={
        <a className="link" href="https://ollama.com/library" target="_blank" rel="noreferrer noopener" aria-label="Browse the Ollama library at ollama.com/library (opens your browser)">
          Browse the Ollama library ↗
        </a>
      }
    >
      <input className="inp" placeholder="Model name, e.g. phi5:14b" aria-label="Model name" value={name} onChange={(e) => setName(e.target.value)} />
      <button
        type="button"
        className="qa"
        disabled={name.trim() === ""}
        onClick={() => {
          // the typed name stays until the download starts (W-07)
          void actions.start(name).then(ok => { if (ok) setName(current => current === name ? "" : current); });
        }}
      >
        Download
      </button>
    </Row>
  );
}

const installation = (s: State, key: string) => (s.models ?? []).find(m => downloadKey(m.name) === key) ??
  (s.catalog !== NA && s.catalog?.some(c => c.installed && downloadKey(c.name) === key) ? true : undefined);

/**
 * While the groups wait for fit answers: one placeholder over the place both
 * groups will take, split as the server recommends, with rows shaped like
 * DlRow, so the groups land inside it and what is below stays put.
 */
function GroupsPlaceholder({ rows, first }: { rows: number; first: number }) {
  const sizes = [first, rows - first].filter(n => n > 0);
  return (
    <div className="grp-skel" aria-busy="true">
      <div data-skel="" aria-hidden="true">
        {sizes.map((n, g) => (
          <div className="grp" key={g}>
            <div className="grp-h"><div className="grp-l"><div className="grp-t"><Skel w={g === 0 ? "7em" : "8em"} /></div></div></div>
            <div className="box">
              {Array.from({ length: n }, (_, i) => (
                <div className="dlrow" key={i}>
                  <span className="maker-mark" />
                  <div className="sl"><b><Skel w="8em" /></b><span className="d"><Skel w="12em" /></span><div className="prog-l dl-status"><Skel w="7em" /></div></div>
                  <div className="dl-v"><small><Skel w="8em" /></small></div>
                  <div className="dl-a"><Skel w="88px" /></div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The Download tab. */
export function DownloadTab() {
  const [attempts, setAttempts] = useState<Record<string, { error: ActionResult | undefined; pulls: State["pulls"]; installed: ReturnType<typeof installation>; start: boolean }>>({});
  const run = async (name: string, action: Promise<ActionResult>, start = false) => {
    // Only the newest attempt may publish an answer, including when Cancel
    // follows an unresolved pull.
    const key = downloadKey(name), snapshot = getState();
    const attempt: (typeof attempts)[string] = { error: undefined, pulls: snapshot.pulls, installed: installation(snapshot, key), start };
    setAttempts(s => ({ ...s, [key]: attempt }));
    const error = await action;
    setAttempts(s => s[key] === attempt ? { ...s, [key]: { ...attempt, error, pulls: getState().pulls } } : s);
    return error === null;
  };
  const catalog = useStore((s) => s.catalog);
  const models = useStore(s => s.models), pulls = useStore(s => s.pulls);
  const numCtx = useStore((s) => s.numCtx);
  const gpu = useStore((s) => s.gpu);
  const fits = useStore((s) => s.fits);
  const gpuName = gpu === NA || gpu === undefined || gpu.vendor !== "nvidia" ? "computer" : shortGpu(gpu.name);
  const list = catalog === NA || catalog === undefined ? [] : catalog;
  // Only a changed installation or successful progress confirms a start.
  // Existing files and late terminal/queued pushes do not retire a new error.
  // A failed cancel still matters while that download continues.
  const retired = (key: string, attempt: (typeof attempts)[string]) => {
    if (attempt.error === undefined) return false; // Its RPC still owns the answer; prior progress cannot settle it.
    const s = getState(), now = installation(s, key), before = attempt.installed;
    return (now !== undefined && (before === undefined || (now !== true && before !== true && (now.digest !== before.digest || now.modifiedAt !== before.modifiedAt)))) ||
      (attempt.start && Object.entries(s.pulls).some(([name, p]) => downloadKey(name) === key && attempt.pulls[name] !== p &&
        (p.state === "downloading" || p.state === "verifying" || p.state === "done")));
  };
  useEffect(() => {
    setAttempts(previous => {
      const next = Object.fromEntries(Object.entries(previous).filter(([key, attempt]) => !retired(key, attempt)));
      return Object.keys(next).length === Object.keys(previous).length ? previous : next;
    });
  }, [models, pulls, catalog]);
  const actions: DownloadActions = {
    start: name => {
      const tag = list.find(c => downloadKey(c.name) === downloadKey(name))?.name ?? name.trim();
      return run(tag, pull(tag), true);
    },
    cancel: name => {
      void run(name, cancelPull(name));
    },
    error: name => {
      const key = downloadKey(name), attempt = attempts[key];
      return attempt && !retired(key, attempt) ? attempt.error ?? null : null;
    },
  };
  const report = (c: CatalogEntry) => {
    const r = fits[fitKey(c.name, numCtx)];
    return r === "error" ? undefined : r ?? (c.fit?.numCtx === numCtx ? c.fit : undefined);
  };
  useEffect(() => {
    for (const c of list) ensureFit(c.name, numCtx);
  }, [catalog, numCtx, fits]);
  const fitStatus = useStore(s => s.fitStatus), staleFits = useStore(s => s.staleFits);
  // What this context has answered for a row: a report that is not waiting on
  // changed memory (the catalog's own estimate counts when it was made at this
  // context), "none" when the check failed, undefined while nothing has.
  const answer = (c: CatalogEntry): FitReport | "none" | undefined => {
    const key = fitKey(c.name, numCtx), raw = fits[key], phase = fitStatus?.[key];
    if (raw === "error" || phase === "error") return "none";
    if (phase === "stale" || staleFits?.[key]) return undefined;
    return raw ?? (c.fit?.numCtx === numCtx ? c.fit : undefined);
  };
  const verdict = (c: CatalogEntry) => { const a = answer(c); return a === "none" ? undefined : a?.verdict; };
  // Grouped once per visit and context, when every row has an answer at this
  // context or a second has passed (a row with none is then not recommended).
  // After that only one move happens: a row whose verdict becomes "does not
  // fit" leaves Recommended for the rest of the visit (docs/design.md). Each
  // row's verdict stays live.
  const group = () => {
    const rec = list.filter(c => c.recommended && (verdict(c) === "fits" || (noGpu(gpu) && verdict(c) === "spills")));
    const more = list.filter(c => !rec.includes(c));
    return { context: numCtx, recommended: rec.map(c => c.name), other: more.map(c => c.name) };
  };
  const [savedGroups, setGroups] = useState<ReturnType<typeof group>>();
  const [waited, setWaited] = useState<number>();
  const settled = list.every(c => answer(c) !== undefined);
  useEffect(() => {
    if (settled || list.length === 0) return;
    const t = setTimeout(() => setWaited(numCtx), 1000);
    return () => clearTimeout(t);
  }, [settled, numCtx, list.length]);
  const saved = savedGroups?.context === numCtx ? savedGroups : group();
  const fresh = saved !== savedGroups;
  const holding = fresh && list.length > 0 && !settled && waited !== numCtx;
  const refused = saved.recommended.filter(name => { const c = list.find(e => e.name === name); return c !== undefined && verdict(c) === "refuse"; });
  const groups = refused.length === 0 ? saved : { ...saved, recommended: saved.recommended.filter(n => !refused.includes(n)), other: [...refused, ...saved.other] };
  if (list.length > 0 && !holding && (fresh || groups !== saved)) setGroups(groups);
  const entries = new Map(list.map(c => [c.name, c]));
  const rows = (names: string[]) => names.flatMap(name => {
    const entry = entries.get(name);
    return entry ? [entry] : [];
  });
  const known = new Set([...groups.recommended, ...groups.other]);
  const rec = rows(groups.recommended);
  // Recommended had a place this visit (the placeholder drew its header, or it showed):
  // once empty it keeps that header's height, hidden, so what is below stays put
  const [slot, setSlot] = useState<number>();
  const drewTwo = holding && list.some(c => c.recommended) && list.some(c => !c.recommended);
  if ((drewTwo || (!holding && rec.length > 0)) && slot !== numCtx) setSlot(numCtx);
  const keep = !holding && rec.length === 0 && slot === numCtx;
  // A newly discovered model appears at the end without moving existing rows.
  const more = [...rows(groups.other), ...list.filter(c => !known.has(c.name))];
  // the title is worked out from the rows' live verdicts: its words change in place, the rows stay
  const allSpill = more.length > 0 && more.every(c => verdict(c) === "spills");
  return (
    <>
      {catalog === NA ? (
        <p className="na">The model list is not available in this build. You can still type a model name below.</p>
      ) : null}
      {holding ? <GroupsPlaceholder rows={list.length} first={list.filter(c => c.recommended).length} /> : null}
      {keep ? (
        <div className="grp grp-keep" aria-hidden="true"><div className="grp-h"><div className="grp-l"><div className="grp-t">{" "}</div></div></div></div>
      ) : null}
      {!holding && rec.length > 0 ? (
        <Grp title="Recommended" tip={`Picked for your ${gpuName}. Memory is shown at your current context, ${k(numCtx)}.`}>
          {rec.map((c) => (
            <DlRow key={c.name} c={c} numCtx={numCtx} report={report(c)} actions={actions} />
          ))}
        </Grp>
      ) : null}
      {!holding && more.length > 0 ? (
        <Grp title={allSpill ? "Also available · uses system memory" : "Also available"}>
          {more.map((c) => (
            <DlRow key={c.name} c={c} numCtx={numCtx} report={report(c)} actions={actions} />
          ))}
        </Grp>
      ) : null}
      <Grp title="Something else"><CustomPull actions={actions} /></Grp>
    </>
  );
}
