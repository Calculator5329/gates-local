import { type ReactNode, useRef, useState } from "react";
import type { CatalogEntry, FitReport, ModelEstimate, PullProgress } from "@gates-local/contracts";
import { suggestedOf } from "../picker/picker-models.ts";
import { etaText, gb, noGpu, verdictOf } from "../lib/words/format.ts";
import { Icon } from "../lib/ui/icons.tsx";
import { MakerMark } from "./MakerMark.tsx";
import { MemoryMark } from "./MemoryMark.tsx";
import { answers, rowOf } from "../fit/fit-table.ts";
import { labelOf, nameOf, pullName, shortTag, sizeText, splitTail } from "./models-rules.ts";
import { awaitingInstall, modelNameKey, pendingDownload } from "./pick.ts";
import { type ActionResult, cancelPull, estimateModel, pull } from "../lib/session/index.ts";
import { PathText } from "../lib/ui/settings-controls.tsx";
import { Grp, Row, useAct, useOutside, walk } from "../lib/ui/settings-ui.tsx";
import { NA, type State, getState, useStore } from "../lib/store/store.ts";
import { Skel, closeTip } from "../lib/ui/ui.tsx";
import { useAfter } from "../lib/ui/kit/flash.ts";
import { requestFocus } from "../lib/ui/kit/focus.ts";
import { useChange } from "../lib/ui/kit/popover.ts";

function Progress({ p, name }: { p: PullProgress; name: string }) {
  const pct = p.totalBytes ? Math.round((p.completedBytes / p.totalBytes) * 100) : 0;
  return (
    <div className="prog" role="progressbar" aria-label={`${name} download`} aria-valuenow={pct}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

const catalogOf = (s: State) => (s.catalog === NA ? undefined : s.catalog);

export const canCancelPull = (s: State): boolean => s.unavailable["models.cancelPull"] !== true;

export function usePendingDownloads() {
  const pulls = useStore((s) => s.pulls);
  const models = useStore((s) => s.models);
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
      <div className="mp-nm">
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
            data-testid="models.downloading.cancel"
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

// external: Ollama's pull progress has no total until it knows a layer's size
const pctOf = (p: PullProgress) => (p.totalBytes ? Math.min(100, Math.round((p.completedBytes / p.totalBytes) * 100)) : 0);

export function DlButton({ size, label, p, installed = false, disabled = false, onStart, onCancel, side }: {
  size: string | undefined;
  label: string;
  p?: PullProgress | undefined;
  installed?: boolean;
  disabled?: boolean;
  onStart?: () => void;
  onCancel?: (() => void) | undefined;
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
        <button type="button" className="dl-btn" data-testid="models.download.start" aria-label={size === undefined ? "Download" : `Download ${size}`} disabled={disabled} onClick={onStart}>
          <Icon id="download" />
          {size ?? "Download"}
        </button>
      )}
      {p && onCancel && !installed ? (
        <button
          type="button"
          className="dl-x"
          data-testid="models.download.cancel"
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

function DlRow({ c, report, actions }: { c: CatalogEntry; report: FitReport | undefined; actions: DownloadActions }) {
  const p = useStore(s => Object.values(s.pulls).findLast(progress => downloadKey(progress.name) === downloadKey(c.name) && awaitingInstall(progress)));
  const installed = useStore((s) => c.installed || (s.models ?? []).some((m) => downloadKey(m.name) === downloadKey(c.name)));
  const canCancel = useStore(canCancelPull);
  const v = report ? verdictOf(report) : undefined;
  const dling = p !== undefined && awaitingInstall(p) && !installed;
  const err = installed ? null : actions.error(c.name);
  const name = labelOf(c);
  return (
    <div className="dlrow" data-cat={c.name} data-verdict={report?.verdict}>
      <MakerMark tag={c.name} />
      <div className="sl">
        <b>{name}</b>
        <span className="d dl-status">
          {err ? (
            <span role="alert" className="dl-error">{err}</span>
          ) : dling ? (
            etaText(p, { speed: false })
          ) : (
            c.purpose
          )}
        </span>
      </div>
      {report && v ? <MemoryMark report={report} words={v.mark} /> :<span className="mm" aria-hidden="true" />}
      <DlButton
        size={gb(c.downloadBytes)}
        label={name}
        p={dling ? p : undefined}
        installed={installed}
        onStart={() => void actions.start(c.name)}
        onCancel={dling && canCancel ? () => actions.cancel(p.name) : undefined}
      />
    </div>
  );
}

function BigRow({ c, report }: { c: CatalogEntry; report: FitReport }) {
  const name = labelOf(c);
  return (
    <div className="dlrow dl-big" data-cat={c.name} data-verdict={report.verdict}>
      <MakerMark tag={c.name} />
      <div className="sl">
        <b>{name}</b>
        <span className="d">{c.purpose}</span>
      </div>
      <MemoryMark report={report} words={verdictOf(report).mark} />
    </div>
  );
}

type Typed = { key: string; numCtx: number; estimate: ModelEstimate | undefined };

export function CustomPull({ actions, numCtx }: { actions: DownloadActions; numCtx: number }) {
  const [name, setName] = useState("");
  const [typed, setTyped] = useState<Typed>();
  const [menu, setMenu] = useState(false);
  const cpu = useStore((s) => noGpu(s.gpu));
  const typedExample = useStore((s) => suggestedOf(s)?.typedExample);
  const box = useRef<HTMLDivElement>(null);
  useOutside(box, menu, () => setMenu(false));
  const closeMenu = () => {
    setMenu(false);
    box.current?.querySelector<HTMLElement>(".dl-x")?.focus();
  };
  const tag = pullName(name);
  const key = downloadKey(tag);
  const answer = typed?.key === key && typed.numCtx === numCtx && tag !== "" ? typed.estimate : undefined;
  const v = answer?.fit ? verdictOf(answer.fit) : undefined;
  const big = v?.k === "no";
  const lookUp = async (): Promise<ModelEstimate | undefined> => {
    const estimate = await estimateModel(tag, numCtx);
    setTyped({ key, numCtx, estimate });
    return estimate;
  };
  const start = () => {
    setMenu(false);
    void actions.start(tag).then(ok => { if (ok) setName(current => current === name ? "" : current); });
  };
  const download = async () => {
    if (tag === "") return;
    const a = answer ?? await lookUp();
    if (a?.found === "no" || (a?.fit !== undefined && verdictOf(a.fit).k === "no")) return;
    start();
  };
  const said = tag === "" || answer === undefined ? undefined
    : answer.found === "no" ? "Not in the Ollama library. Check the name."
    : answer.found === "unknown" ? "Couldn't read this model's size, so it is not checked."
    : big ? `${v.mark} · needs ${gb(v.need)}`
    : v?.k === "spill" && !cpu ? v.word
    : undefined;
  return (
    <Row
      err={actions.error(tag)}
      label="Any model from the Ollama library"
      desc={
        said === undefined ? (
          <a className="link" data-testid="models.custom.library-link" href="https://ollama.com/library" target="_blank" rel="noreferrer noopener" aria-label="Browse the Ollama library at ollama.com/library (opens your browser)">
            Browse the Ollama library ↗
          </a>
        ) : (
          <span className={big || answer?.found === "no" ? "dl-typed no" : "dl-typed"} role="status">{said}</span>
        )
      }
    >
      <input className="inp" placeholder={typedExample === undefined ? "Model name" : `Model name, e.g. ${typedExample}`} aria-label="Model name" data-testid="models.custom.name" value={name} onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && tag !== "") { e.preventDefault(); void lookUp(); } }} />
      <div className="dl-typed-a" ref={box} data-testid="models.custom.actions" onKeyDown={(e) => menu && walk(e, box.current, "[role=menuitem]", closeMenu)}>
        <DlButton
          size={answer?.downloadBytes === undefined ? undefined : gb(answer.downloadBytes)}
          label={tag}
          disabled={tag === "" || big || answer?.found === "no"}
          onStart={() => void download()}
          side={big ? (
            <button type="button" className={`dl-x${menu ? " on" : ""}`} data-testid="models.custom.more" aria-label={`More for ${tag}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => {
              // why: focus goes in when the menu opens, not each time a new lookup draws it again
              if (!menu) requestFocus(() => box.current?.querySelector<HTMLElement>("[role=menuitem]"));
              setMenu(!menu);
            }}>
              <Icon id="more" />
            </button>
          ) : undefined}
        />
        {big && menu ? (
          <div className="mp-menu dl-menu" role="menu" aria-label={tag}>
            <button type="button" role="menuitem" className="mp-mi" data-testid="models.custom.download-anyway" onClick={start}>
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

function GroupsPlaceholder({ rows, first }: { rows: number; first: number }) {
  const sizes = [first, rows - first].filter(n => n > 0);
  return (
    <div className="grp-skel" aria-busy="true">
      <div data-skel="" aria-hidden="true">
        {sizes.map((n, g) => (
          <div className="grp" key={g}>
            <div className="grp-h"><div><div className="grp-t"><Skel w={g === 0 ? "7em" : "8em"} /></div></div></div>
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

export const othersOf = (s: Pick<State, "fitTable">) => (s.fitTable?.memory.kind === "gpu" ? s.fitTable.memory.others : undefined);

export function othersLine(others: { programs: readonly string[]; bytes: number }): string {
  const [first, second] = others.programs;
  const who = first === undefined ? "Other programs" : others.programs.length === 1 ? first : others.programs.length === 2 ? `${first} and ${second}` : `${first} and ${others.programs.length - 1} other programs`;
  return `${who} ${others.programs.length === 1 ? "is" : "are"} using ${gb(others.bytes)} of GPU memory right now.`;
}

export function DownloadTab() {
  const [attempts, setAttempts] = useState<Record<string, { error: ActionResult | undefined; pulls: State["pulls"]; installed: ReturnType<typeof installation>; start: boolean }>>({});
  const run = async (name: string, action: Promise<ActionResult>, start = false) => {
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
  const table = useStore((s) => s.fitTable);
  const list =catalog === NA || catalog === undefined ? [] : catalog;
  const retired = (key: string, attempt: (typeof attempts)[string]) => {
    if (attempt.error === undefined) return false;
    const s = getState(), now = installation(s, key), before = attempt.installed;
    return (now !== undefined && (before === undefined || (now !== true && before !== true && (now.digest !== before.digest || now.modifiedAt !== before.modifiedAt)))) ||
      (attempt.start && Object.entries(s.pulls).some(([name, p]) => downloadKey(name) === key && attempt.pulls[name] !== p &&
        (p.state === "downloading" || p.state === "verifying" || p.state === "done")));
  };
  // why: an attempt retires on pushed installs and progress; the push handlers are lib/session's
  const retire = () => setAttempts(previous => {
    const next = Object.fromEntries(Object.entries(previous).filter(([key, attempt]) => !retired(key, attempt)));
    return Object.keys(next).length === Object.keys(previous).length ? previous : next;
  });
  useChange(models, retire);
  useChange(pulls, retire);
  useChange(catalog, retire);
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
  const report = (c: CatalogEntry) => rowOf({ fitTable: table, models, numCtx }, c.name);
  const answer = (c: CatalogEntry): FitReport | "none" | undefined => !answers(table) ? undefined : report(c) ?? "none";
  const verdict = (c: CatalogEntry) => { const a = answer(c); return a === "none" ? undefined : a?.verdict; };
  const runs = (c: CatalogEntry) => verdict(c) === "fits" || verdict(c) === "spills";
  const group = () => {
    const rec = list.filter(c => c.recommended && runs(c)).toSorted((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    const more = list.filter(c => !rec.includes(c));
    return { context: numCtx, recommended: rec.map(c => c.name), other: more.map(c => c.name) };
  };
  const [savedGroups, setGroups] = useState<ReturnType<typeof group>>();
  const settled = list.every(c => answer(c) !== undefined);
  // why: design.md: rows group once every answer is in or a second has passed, per context size
  const waited = useAfter(1000, settled || list.length === 0 ? null : numCtx);
  const saved = savedGroups?.context === numCtx ? savedGroups : group();
  const fresh = saved !== savedGroups;
  const holding = fresh && list.length > 0 && !settled && !waited;
  const entries = new Map(list.map(c => [c.name, c]));
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
  const [slot, setSlot] = useState<number>();
  const drewTwo = holding && list.some(c => c.recommended) && list.some(c => !c.recommended);
  if ((drewTwo || (!holding && rec.length > 0)) && slot !== numCtx) setSlot(numCtx);
  const keep = !holding && rec.length === 0 && slot === numCtx;
  const more = [...rows(groups.other), ...list.filter(c => !known.has(c.name) && !refuses(c))];
  const big = holding ? [] : list.filter(refuses);
  const others = table?.memory.kind === "gpu" ? table.memory.others : undefined;
  return (
    <>
      {catalog === NA ? (
        <p className="na">The model list is not available in this build. You can still type a model name below.</p>
      ) : null}
      {holding ? <GroupsPlaceholder rows={list.length} first={list.filter(c => c.recommended).length} /> : null}
      {keep ? (
        <div className="grp grp-keep" aria-hidden="true"><div className="grp-h"><div><div className="grp-t">{" "}</div></div></div></div>
      ) : null}
      {!holding && rec.length > 0 ? (
        <Grp title="Recommended">
          {rec.map((c) => (
            <DlRow key={c.name} c={c} report={report(c)} actions={actions} />
          ))}
        </Grp>
      ) : null}
      {!holding && more.length > 0 ? (
        <Grp title="Also available">
          {more.map((c) => (
            <DlRow key={c.name} c={c} report={report(c)} actions={actions} />
          ))}
        </Grp>
      ) : null}
      {others && list.length > 0 ? <p className="na dl-others">{othersLine(others)}</p> : null}
      <Grp title="Something else"><CustomPull actions={actions} numCtx={numCtx} /></Grp>
      {big.length > 0 ? (
        <details className="grp dl-bigs">
          <summary className="grp-h" data-testid="models.download.too-big">
            <div><div className="grp-t">Too big for this computer<span className="grp-n">{big.length}</span><Icon id="down" cls="dl-chev" /></div></div>
          </summary>
          <div className="box">
            {big.map((c) => {
              const r = report(c);
              return r ? <BigRow key={c.name} c={c} report={r} /> : null;
            })}
          </div>
        </details>
      ) : null}
    </>
  );
}
