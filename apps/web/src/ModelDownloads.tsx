// How a model downloads: the bar and its detail line, the catalog rows with
// their fit and Download or Cancel download, and any other name typed in. The
// Models page's Download tab shows these as they are, and first run and the
// Installed tab share the progress bar and timing words.
import { type ReactNode, useEffect, useRef, useState } from "react";
import { CHAT_MODELS, type CatalogEntry, type FitReport, type ModelEstimate, type PullProgress } from "@gates-local/contracts";
import { shortGpu } from "./FitPanel.tsx";
import { type Verdict, etaText, gb, k, noGpu, verdictOf } from "./format.ts";
import { Icon } from "./icons.tsx";
import { MakerMark } from "./MakerMark.tsx";
import { answers, rowOf } from "./fit-table.ts";
import { nameOf, pullName, shortTag, sizeText, splitTail } from "./models-rules.ts";
import { awaitingInstall, modelNameKey, pendingDownload } from "./pick.ts";
import { type ActionResult, cancelPull, estimateModel, pull } from "./session.ts";
import { PathText } from "./settings-controls.tsx";
import { Grp, Row, useAct, useOutside, walk } from "./settings-ui.tsx";
import { NA, type State, getState, useStore } from "./store.ts";
import { Skel, VLabel, closeTip, esc } from "./ui.tsx";

function Progress({ p, name }: { p: PullProgress; name: string }) {
  const pct = p.totalBytes ? Math.round((p.completedBytes / p.totalBytes) * 100) : 0;
  return (
    <div className="prog" role="progressbar" aria-label={`${name} download`} aria-valuenow={pct}>
      <i style={{ width: `${pct}%` }} />
    </div>
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

/** A download's percent, 0 until Ollama has named a size. */
const pctOf = (p: PullProgress) => (p.totalBytes ? Math.min(100, Math.round((p.completedBytes / p.totalBytes) * 100)) : 0);

/**
 * The download button every model row shares, and first run (row 18, layout A): idle, its label is
 * the download's size; running, the same box fills with the percent and the × beside it cancels.
 * Both boxes keep their size in every state, so nothing beside them moves.
 */
export function DlButton({ size, label, p, installed = false, disabled = false, onStart, onCancel, side }: {
  /** The download's size as it is shown ("6.1 GB"); undefined while it is not known. */
  size: string | undefined;
  label: string;
  p?: PullProgress | undefined;
  installed?: boolean;
  disabled?: boolean;
  onStart?: () => void;
  onCancel?: (() => void) | undefined;
  /** What takes the × box while nothing downloads (a row menu); empty by default. */
  side?: ReactNode;
}) {
  const pct = p ? pctOf(p) : 0;
  const finishing = p !== undefined && (p.state === "done" || p.state === "verifying" || (p.totalBytes !== undefined && p.completedBytes >= p.totalBytes));
  return (
    <div className="dl-a">
      {installed ? (
        <span className="dl-btn dl-done">Installed</span>
      ) : p ? (
        <span className="dl-btn dl-run" role="progressbar" aria-label={`${label} download`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <i style={{ width: `${finishing ? 100 : pct}%` }} />
          <span>{finishing ? "Finishing" : p.totalBytes ? `${pct}%` : "…"}</span>
        </span>
      ) : (
        <button type="button" className="dl-btn" aria-label={size === undefined ? "Download" : `Download ${size}`} disabled={disabled} onClick={onStart}>
          <Icon id="download" />
          {size ?? "Download"}
        </button>
      )}
      {p && onCancel && !installed ? (
        <button
          type="button"
          className="dl-x"
          aria-label="Cancel download"
          data-tip="Cancel download"
          disabled={p.state === "done"}
          onClick={() => {
            closeTip();
            onCancel();
          }}
        >
          <Icon id="x" />
        </button>
      ) : side !== undefined && !p ? (
        <span className="dl-side">{side}</span>
      ) : (
        <span className="dl-x off" aria-hidden="true" />
      )}
    </div>
  );
}

/** The row's tooltip: the memory it takes and the context it is judged at, said in words. */
function memoryTip(v: Verdict, context: number, cpu: boolean): string {
  const basis = v.measured ? "Measured" : "Estimated";
  const where = cpu ? "all in system memory (no supported GPU)" : `with ${gb(v.avail)} on the GPU`;
  return `${basis} ${gb(v.need)} of memory with ${k(context)} of context, ${where}.`;
}

function DlRow({ c, numCtx, report, mark, actions }: { c: CatalogEntry; numCtx: number; report: FitReport | undefined; mark: boolean; actions: DownloadActions }) {
  const p = useStore(s => Object.values(s.pulls).findLast(progress => downloadKey(progress.name) === downloadKey(c.name) && awaitingInstall(progress)));
  const installed = useStore((s) => c.installed || (s.models ?? []).some((m) => downloadKey(m.name) === downloadKey(c.name)));
  const canCancel = useStore(canCancelPull);
  const cpu = useStore((s) => noGpu(s.gpu));
  const v = report ? verdictOf(report) : undefined;
  const dling = p !== undefined && awaitingInstall(p) && !installed;
  const err = installed ? null : actions.error(c.name);
  const tip = `<b>${esc(c.label)}</b> · <span class="mono">${esc(c.name)}</span>${v ? `<br>${esc(memoryTip(v, report?.numCtx ?? numCtx, cpu))}` : ""}`;
  return (
    <div className="dlrow" data-cat={c.name} data-verdict={report?.verdict}>
      <MakerMark tag={c.name} />
      <div className="sl" data-tip={tip}>
        <b>{c.label}</b>
        <span className="d dl-status">
          {err ? (
            <span role="alert" className="dl-error">{err}</span>
          ) : dling ? (
            etaText(p, { speed: false })
          ) : (
            <>
              {c.purpose}
              {/* only an exception to the line above the list (row 18) */}
              {mark && v ? <> · <VLabel v={v} /></> : null}
            </>
          )}
        </span>
      </div>
      <DlButton
        size={gb(c.downloadBytes)}
        label={c.label}
        p={dling ? p : undefined}
        installed={installed}
        onStart={() => void actions.start(c.name)}
        onCancel={dling && canCancel ? () => actions.cancel(p.name) : undefined}
      />
    </div>
  );
}

/** A row that cannot run here: what it needs, and no button (row 18). */
function BigRow({ c, report, numCtx }: { c: CatalogEntry; report: FitReport; numCtx: number }) {
  const v = verdictOf(report);
  const cpu = useStore((s) => noGpu(s.gpu));
  return (
    <div className="dlrow dl-big" data-cat={c.name} data-verdict={report.verdict}>
      <MakerMark tag={c.name} />
      <div className="sl" data-tip={`<b>${esc(c.label)}</b> · <span class="mono">${esc(c.name)}</span><br>${esc(memoryTip(v, report.numCtx || numCtx, cpu))}`}>
        <b>{c.label}</b>
        <span className="d">{c.purpose}</span>
      </div>
      <span className="dl-need">needs {gb(v.need)} of memory</span>
    </div>
  );
}

/** How long typing rests before a typed name is looked up. */
const TYPED_DEBOUNCE_MS = 400;

/** The typed name's answer: what the server said for which name, at which context. */
type Typed = { key: string; numCtx: number; estimate: ModelEstimate | undefined };

function CustomPull({ actions, numCtx }: { actions: DownloadActions; numCtx: number }) {
  const [name, setName] = useState("");
  const [typed, setTyped] = useState<Typed>();
  const [menu, setMenu] = useState(false);
  const cpu = useStore((s) => noGpu(s.gpu));
  const box = useRef<HTMLDivElement>(null);
  useOutside(box, menu, () => setMenu(false));
  // the row menu keys as the Installed menu's do: focus goes in, Escape closes the menu and not the pop-up
  useEffect(() => {
    if (menu) box.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [menu]);
  const closeMenu = () => {
    setMenu(false);
    box.current?.querySelector<HTMLElement>(".dl-x")?.focus();
  };
  const tag = pullName(name);
  const key = downloadKey(tag);
  useEffect(() => {
    if (tag === "") return;
    let live = true;
    const t = setTimeout(() => {
      void estimateModel(tag, numCtx).then((estimate) => {
        if (live) setTyped({ key, numCtx, estimate });
      });
    }, TYPED_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [tag, key, numCtx]);
  const answer = typed?.key === key && typed.numCtx === numCtx && tag !== "" ? typed.estimate : undefined;
  const v = answer?.fit ? verdictOf(answer.fit) : undefined;
  const big = v?.k === "no";
  const start = () => {
    setMenu(false);
    // the typed name stays until the download starts (W-07)
    void actions.start(tag).then(ok => { if (ok) setName(current => current === name ? "" : current); });
  };
  // the line under the field: the typed name's verdict, said once, before any download
  const said = tag === "" || answer === undefined ? undefined
    : answer.found === "no" ? "Not in the Ollama library. Check the name."
    : answer.found === "unknown" ? "Couldn't read this model's size, so it is not checked."
    : big ? `Too big for this computer · needs ${gb(v.need)}`
    : v?.k === "spill" && !cpu ? v.word
    : undefined;
  return (
    <Row
      err={actions.error(tag)}
      label="Any model from the Ollama library"
      desc={
        said === undefined ? (
          <a className="link" href="https://ollama.com/library" target="_blank" rel="noreferrer noopener" aria-label="Browse the Ollama library at ollama.com/library (opens your browser)">
            Browse the Ollama library ↗
          </a>
        ) : (
          <span className={big || answer?.found === "no" ? "dl-typed no" : "dl-typed"} role="status" data-tip={v && answer?.fit ? esc(memoryTip(v, answer.fit.numCtx, cpu)) : undefined}>{said}</span>
        )
      }
    >
      <input className="inp" placeholder={`Model name, e.g. ${CHAT_MODELS.typedExample}`} aria-label="Model name" value={name} onChange={(e) => setName(e.target.value)} />
      <div className="dl-typed-a" ref={box} onKeyDown={(e) => menu && walk(e, box.current, "[role=menuitem]", closeMenu)}>
        <DlButton
          size={answer?.downloadBytes === undefined ? undefined : gb(answer.downloadBytes)}
          label={tag}
          disabled={tag === "" || big || answer?.found === "no"}
          onStart={start}
          side={big ? (
            <button type="button" className={`dl-x${menu ? " on" : ""}`} aria-label={`More for ${tag}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(m => !m)}>
              <Icon id="more" />
            </button>
          ) : undefined}
        />
        {big && menu ? (
          <div className="mp-menu dl-menu" role="menu" aria-label={tag}>
            <button type="button" role="menuitem" className="mp-mi" onClick={start}>
              <Icon id="download" />
              Download anyway
              <span className="mp-k">{answer?.downloadBytes === undefined ? "" : gb(answer.downloadBytes)}</span>
            </button>
          </div>
        ) : null}
      </div>
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
                  <div className="sl"><b><Skel w="8em" /></b><span className="d"><Skel w="12em" /></span></div>
                  <div className="dl-a"><span className="dl-btn dl-skel"><Skel w="64px" /></span><span className="dl-x off" /></div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Who holds GPU memory above the card's steady baseline right now, said once above the list. It is
 * information: the rows are judged against the card's own memory, and a send still judges right now.
 */
export function othersLine(others: { programs: readonly string[]; bytes: number }): string {
  const [first, second] = others.programs;
  const who = first === undefined ? "Other programs" : others.programs.length === 1 ? first : others.programs.length === 2 ? `${first} and ${second}` : `${first} and ${others.programs.length - 1} other programs`;
  return `${who} ${others.programs.length === 1 ? "is" : "are"} using ${gb(others.bytes)} of GPU memory right now.`;
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
  const table = useStore((s) => s.fitTable);
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
  // the table's row at this context: the one source, never the catalog's own fit; judged against
  // the card's own memory (rowOf), whatever the line above the groups says is in use
  const report = (c: CatalogEntry) => rowOf({ fitTable: table, models, numCtx }, c.name);
  // What this context has answered for a row: the table's row, "none" when the
  // table is in without one, undefined until a table that answers comes (an
  // empty or unreadable one does not).
  const answer = (c: CatalogEntry): FitReport | "none" | undefined => !answers(table) ? undefined : report(c) ?? "none";
  const verdict = (c: CatalogEntry) => { const a = answer(c); return a === "none" ? undefined : a?.verdict; };
  // Grouped once per visit and context, when every row has an answer at this
  // context or a second has passed (a row with none is then not recommended).
  // After that only one move happens: a row whose verdict becomes "does not
  // fit" leaves Recommended for the rest of the visit (docs/design.md). Each
  // row's verdict stays live.
  const runs = (c: CatalogEntry) => verdict(c) === "fits" || verdict(c) === "spills";
  const group = () => {
    // the server's picks for this computer's tier, in the tier's order (row 21)
    const rec = list.filter(c => c.recommended && runs(c)).toSorted((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
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
  const entries = new Map(list.map(c => [c.name, c]));
  // A row that cannot run here shows in the last group, Too big for this computer (row 18). One
  // that leaves Recommended so never comes back this visit: should it run again, it is with the rest.
  const refuses = (c: CatalogEntry) => verdict(c) === "refuse";
  const refused = saved.recommended.filter(name => { const c = entries.get(name); return c !== undefined && refuses(c); });
  const groups = refused.length === 0 ? saved : { ...saved, recommended: saved.recommended.filter(n => !refused.includes(n)), other: [...refused, ...saved.other] };
  if (list.length > 0 && !holding && (fresh || groups !== saved)) setGroups(groups);
  const rows = (names: string[]) => names.flatMap(name => {
    const entry = entries.get(name);
    return entry && !refuses(entry) ? [entry] : [];
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
  const more = [...rows(groups.other), ...list.filter(c => !known.has(c.name) && !refuses(c))];
  const big = holding ? [] : list.filter(refuses);
  // Said once above the list when every row that runs here runs the same way; then rows carry only
  // an exception. Worked out from the live verdicts: its words change in place, the rows stay.
  const runnable = [...rec, ...more];
  const first = runnable[0] === undefined ? undefined : verdict(runnable[0]);
  const shared = !holding && runnable.every(c => runs(c) && verdict(c) === first) ? first : undefined;
  // Rows split between the GPU and slower: the line says the GPU and points at the marked rows, so
  // its box is never empty once the verdicts are in.
  const split = !holding && shared === undefined && runnable.some(c => verdict(c) === "fits") && runnable.every(runs);
  const gpuWord = gpuName === "computer" ? "GPU" : gpuName;
  const once = shared === "fits" ? `These run on your ${gpuWord}.`
    : shared === "spills" ? (noGpu(gpu) ? "No supported GPU, so these run in system memory and replies are slower." : "These are bigger than your GPU's memory, so replies are slower.")
    : split ? `These run on your ${gpuWord}, except the ones marked slower.`
    : undefined;
  const mark = (c: CatalogEntry) => shared === undefined && verdict(c) === "spills";
  const others = table?.memory.kind === "gpu" ? table.memory.others : undefined;
  return (
    <>
      {catalog === NA ? (
        <p className="na">The model list is not available in this build. You can still type a model name below.</p>
      ) : null}
      {others && list.length > 0 ? <p className="na dl-others">{othersLine(others)}</p> : null}
      {/* the line's box stays while its words come and go, so the groups below never move */}
      {list.length > 0 ? (
        <p className="dl-once" data-wait="">
          {once === undefined ? null : <><span className={`vd ${shared === "spills" ? "spill" : "gpu"}`} />{once}</>}
        </p>
      ) : null}
      {holding ? <GroupsPlaceholder rows={list.length} first={list.filter(c => c.recommended).length} /> : null}
      {keep ? (
        <div className="grp grp-keep" aria-hidden="true"><div className="grp-h"><div className="grp-l"><div className="grp-t">{" "}</div></div></div></div>
      ) : null}
      {!holding && rec.length > 0 ? (
        <Grp title="Recommended" tip={`Picked for your ${gpuName}. `}>
          {rec.map((c) => (
            <DlRow key={c.name} c={c} numCtx={numCtx} report={report(c)} mark={mark(c)} actions={actions} />
          ))}
        </Grp>
      ) : null}
      {!holding && more.length > 0 ? (
        <Grp title="Also available">
          {more.map((c) => (
            <DlRow key={c.name} c={c} numCtx={numCtx} report={report(c)} mark={mark(c)} actions={actions} />
          ))}
        </Grp>
      ) : null}
      <Grp title="Something else"><CustomPull actions={actions} numCtx={numCtx} /></Grp>
      {big.length > 0 ? (
        <details className="grp dl-bigs">
          <summary className="grp-h">
            <div className="grp-l"><div className="grp-t">Too big for this computer<span className="grp-n">{big.length}</span><Icon id="down" cls="dl-chev" /></div></div>
          </summary>
          <div className="box">
            {big.map((c) => {
              const r = report(c);
              return r ? <BigRow key={c.name} c={c} report={r} numCtx={numCtx} /> : null;
            })}
          </div>
        </details>
      ) : null}
    </>
  );
}
