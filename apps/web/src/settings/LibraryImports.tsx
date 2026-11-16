import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { SampleDatabase, Source, SourceImport, SourceImports } from "@gates-local/contracts";
import { rtOf } from "../runtime/words.tsx";
import { count, fileSize } from "../lib/words/format.ts";
import { handleKey } from "../lib/ui/handles.ts";
import { Icon } from "../lib/ui/icons.tsx";
import { askWhy, databaseRows, type DbRow } from "./library-rows.ts";
import { chatModels } from "../models/pick.ts";
import { applyServerEvent, libraryRequest, refreshSource, removeSource, retryImports } from "../lib/session/index.ts";
import { libraryToolCanUse } from "../lib/words/settings-rules.ts";
import { PathText } from "../lib/ui/settings-controls.tsx";
import { Fail, Grp, Row, Skel } from "../lib/ui/settings-ui.tsx";
import { askWith } from "../composer/starter.ts";
import { NA, useStore } from "../lib/store/store.ts";
import { useAnimationFrame } from "../lib/ui/kit/frame.ts";
import { useFlash } from "../lib/ui/kit/flash.ts";
import { useChange } from "../lib/ui/kit/popover.ts";

const bytes = (n: number) => n < 1_048_576 ? `${Math.ceil(n / 1024)} KiB` : `${(n / 1_048_576).toFixed(1)} MiB`;
const busy = (j?: SourceImport) => j !== undefined && ["downloading", "cloning", "adding"].includes(j.state);
const USUAL_SAMPLES = 4;
const FINISH_MS = 900;
const still = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
export const MIN_FILL_MS = 800;
export const shownFill = (real: number, since: number | undefined, now: number) => since === undefined ? real : Math.min(real, Math.max(0, (now - since) / MIN_FILL_MS));
const repoOf = (url: string) => url.replace(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([0-9a-f]{40})\/.*$/, "https://github.com/$1/$2/tree/$3");
// why: Windows has no Run commands, so Query databases reads databases there
const DB_TOOL = typeof navigator !== "undefined" && /\bWindows\b/.test(navigator.userAgent) ? "query" : "run";

const line = (rest: string, job?: SourceImport, added = false, prefix = "") => {
  const error = !added && job?.state === "error";
  const words = !job ? "" : added ? "Ready in Library" : job.detail ? job.detail : job.state === "downloading" ? `Downloading ${bytes(job.bytes)}${job.total ? ` of ${bytes(job.total)}` : ""}` : job.state === "cloning" ? `Cloning · ${bytes(job.bytes)} received` : job.state === "adding" ? "Adding to Library…" : "Ready in Library";
  return (
    <span className="d import-line">
      <span className={job ? "import-rest gone" : "import-rest"}>{rest}</span>
      <span className="import-status" role={error ? "alert" : "status"}>{job ? `${prefix}${words}` : ""}</span>
    </span>
  );
};

const dbWords = (src: Source) =>
  src.state === "refreshing" ? "Refreshing…"
    : src.state === "error" ? src.detail ?? "Couldn't read it."
      : [...(src.tables ? [count(src.tableCount ?? src.tables.length, "table")] : []), ...(src.sizeBytes === undefined ? [] : [fileSize(src.sizeBytes)])].join(" · ");

const dbLine = (src: Source) => src.state === "error"
  ? <span className="d act-err" role="alert">{dbWords(src)}</span>
  : <span className="d">{dbWords(src)}</span>;

const sampleLine = (sample: SampleDatabase, job: SourceImport | undefined, source: Source | undefined) => {
  const ended = !source && (job?.state === "error" || job?.state === "cancelled");
  const words = job?.detail ?? (job?.state === "cancelled" ? "Download cancelled." : "Couldn't download it.");
  const as = source ?? { state: "ready", tables: sample.tables, sizeBytes: sample.sizeBytes } as Source;
  return (
    <span className="d import-line">
      <span className={source || ended ? "import-rest gone" : "import-rest"}>{`Sample · ${sample.description} · ${fileSize(sample.sizeBytes)}`}</span>
      <span className={ended ? "import-status" : "import-status gone"} role={job?.state === "error" && ended ? "alert" : "status"}>{ended ? words : ""}</span>
      <span className={source ? `import-db${as.state === "error" ? " act-err" : ""}` : "import-db gone"} aria-hidden={source ? undefined : true}>{dbWords(as)}</span>
    </span>
  );
};

interface FillProps {
  name: string;
  handle: string;
  real: number;
  since: number | undefined;
  running: boolean;
  done: boolean;
  idle: string;
  blocked: boolean;
  onPress: (e: MouseEvent<HTMLButtonElement>) => void;
}

function FillButton({ name, handle, real, since, running, done, idle, blocked, onPress }: FillProps) {
  const [, frame] = useState(0);
  const sweeping = !still() && (running || done);
  const shown = sweeping ? shownFill(real, since, performance.now()) : real;
  const behind = shown < real;
  const [drawnFull, setDrawnFull] = useState(false);
  // why: the commit that first draws the fill full swaps the ref, so the check shows after it
  const [marks] = useState(() => ({ full: (el: HTMLButtonElement | null) => { if (el) setDrawnFull(true); }, empty: (el: HTMLButtonElement | null) => { if (el) setDrawnFull(false); } }));
  const full = done && !behind;
  const finished = full && drawnFull;
  // why: the sweep's frames, until the drawn fill catches up with the download
  useAnimationFrame(() => { frame(n => n + 1); return true; }, behind);
  const busyNow = !finished && (running || done);
  const pct = Math.floor(shown * 100);
  const label = finished ? "" : busyNow ? `${pct}%` : idle;
  return (
    <button
      type="button"
      ref={full ? marks.full : marks.empty}
      className={`btn outline import-action fill-btn${busyNow ? " running" : ""}${finished ? " done" : ""}${behind || done ? " sweep" : ""}`}
      data-testid={`settings.database.download-${handle}`}
      style={{ "--f": finished ? 1 : shown } as React.CSSProperties}
      aria-label={finished ? `${name} downloaded` : busyNow ? `Cancel download, ${pct}% done` : `${label} ${name}`}
      data-tip={busyNow ? "Cancel download" : undefined}
      disabled={finished || blocked}
      onClick={onPress}
    >
      <i className="fill" aria-hidden="true" />
      <span className="lab">{label}</span>
      <Icon id="check" cls="chk" />
    </button>
  );
}

export default function LibraryImports({ add, clone, clones = [] }: { add: ReactNode; clone: boolean; clones?: readonly ReactNode[] }) {
  const stored = useStore(s => s.sourceImports);
  const value: SourceImports | undefined = stored === NA ? undefined : stored;
  const [actionError, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState<string>();
  const [opened, setOpened] = useState<readonly string[]>([]);
  const [finishMs, setFinishMs] = useState(FINISH_MS);
  const [finishing, finish] = useFlash<readonly string[]>(finishMs);
  const [rowErr, setRowErr] = useState<Readonly<Record<string, string>>>({});
  const sources = useStore(s => s.sources);
  const tools = useStore(s => s.settings === NA || s.settings?.tools === true);
  const chat = useStore(s => rtOf(s) === "ready" && chatModels(s.models ?? []).length > 0);
  const download = useStore(s => s.unavailable["sources.downloadSample"] !== true);
  const edit = useStore(s => s.unavailable["sources.remove"] !== true);
  const ran = useRef(new Set<string>());
  const started = useRef(new Map<string, number>());
  const start = async (key: string, action: () => Promise<SourceImport>) => {
    if (pending !== undefined) return;
    setError(null);
    setPending(key);
    try { await action(); }
    catch (e) { applyServerEvent(() => setError(e instanceof Error ? e.message : "Couldn't start this import. Retry.")); }
    finally { setPending(undefined); }
  };
  const cancel = async (job: SourceImport) => {
    try { await libraryRequest("sources.cancelImport", { id: job.id }); }
    catch { applyServerEvent(() => setError("Couldn't cancel while disconnected. Retry once Gates Local reconnects.")); }
  };
  const act = async (key: string, action: Promise<string | null>) => {
    setRowErr(e => { const { [key]: _gone, ...rest } = e; return rest; });
    const failed = await action;
    if (failed !== null) setRowErr(e => ({ ...e, [key]: failed }));
  };
  const list = sources === NA || sources === undefined ? [] : sources;
  const rows = value ? databaseRows(value.samples, list, value.jobs) : databaseRows([], list.filter(s => s.managed?.kind !== "sample"), []);
  const runs = (r: DbRow) => r.sample !== undefined && (busy(r.job) || pending === r.sample.id || (r.job?.state === "ready" && ran.current.has(r.sample.id)));
  for (const r of rows) {
    if (!r.sample || r.source) continue;
    if (busy(r.job) || pending === r.sample.id) ran.current.add(r.sample.id);
    if (!runs(r)) started.current.delete(r.sample.id);
    else if (!started.current.has(r.sample.id)) started.current.set(r.sample.id, performance.now());
  }
  const landed = rows.flatMap(r => r.sample && r.source && ran.current.has(r.sample.id) ? [r.sample.id] : []).join(" ");
  // why: a download the server now reports as a source holds its check on screen once the sweep ends
  useChange(landed, now => {
    if (now === "") return;
    const ids = now.split(" ");
    for (const id of ids) ran.current.delete(id);
    if (still()) return;
    const at = performance.now();
    const sweep = Math.max(0, ...ids.map(id => MIN_FILL_MS - (at - (started.current.get(id) ?? -Infinity))));
    setFinishMs(FINISH_MS + sweep);
    finish([...(finishing ?? []), ...ids]);
  });
  const toggle = (key: string) => setOpened(o => o.includes(key) ? o.filter(k => k !== key) : [...o, key]);
  const usable = libraryToolCanUse(DB_TOOL, list);

  const fillButton = (row: DbRow, sample: SampleDatabase, done: boolean) => {
    const job = row.job;
    const running = runs(row);
    const frac = done || job?.state === "adding" || (job?.state === "ready" && running) ? 1 : busy(job) ? Math.min(1, job!.bytes / (job!.total ?? sample.sizeBytes)) : 0;
    return (
      <FillButton
        name={sample.label}
        handle={handleKey(sample.id)}
        real={frac}
        since={started.current.get(sample.id)}
        running={running}
        done={done}
        idle={job?.state === "error" || job?.state === "cancelled" ? "Retry" : "Download"}
        blocked={pending !== undefined && pending !== sample.id}
        onPress={e => { if (job && busy(job)) { if (e.detail <= 1) void cancel(job); } else if (!running && !done) void start(sample.id, () => libraryRequest("sources.downloadSample", { id: sample.id })); }}
      />
    );
  };

  const more = (row: DbRow) => {
    const tables = row.source?.tables ?? row.sample?.tables;
    const why = row.sample ? askWhy({ downloaded: row.source?.state === "ready", chat, tools, tool: usable }) : null;
    return (
      <div className="db-more">
        {row.source && !row.sample ? <span className="d db-path"><PathText path={row.source.path} /></span> : null}
        {tables ? (
          <div className="db-tables" aria-label="Tables and their rows">
            {tables.map(t => <span key={t.name} className="db-t">{t.rows === undefined ? t.name : <>{t.name} <span className="n">{t.rows.toLocaleString()}</span></>}</span>)}
          </div>
        ) : <span className="d">Refresh it to list its tables.</span>}
        {row.sample ? (
          <>
            <div className="db-qs">
              {why === null ? null : <span className="d db-why">{why}</span>}
              {row.sample.questions.map((q, i) => (
                <button key={q} type="button" className="db-q" data-testid={`settings.database.ask-${handleKey(row.key)}-${i + 1}`} disabled={why !== null} onClick={() => { if (why === null) askWith(`In ${row.sample!.label}: ${q}`); }}>
                  <span>{q}</span>
                  <Icon id="arrow" cls="s14" />
                </button>
              ))}
            </div>
            <span className="d db-lic">
              <a className="link" href={row.sample.licenseUrl} data-testid={`settings.database.license-${handleKey(row.key)}`} target="_blank" rel="noreferrer noopener">{row.sample.license}</a>
              {" · "}
              <a className="link" href={repoOf(row.sample.url)} data-testid={`settings.database.source-${handleKey(row.key)}`} target="_blank" rel="noreferrer noopener">Source</a>
            </span>
          </>
        ) : null}
      </div>
    );
  };

  const dbRow = (row: DbRow) => {
    const { sample, source } = row;
    const name = sample?.label ?? source?.label ?? "";
    const open = opened.includes(row.key);
    const done = sample !== undefined && source !== undefined && (finishing?.includes(sample.id) === true || (ran.current.has(sample.id) && !still()));
    const own = source !== undefined && sample === undefined;
    return (
      <div className={`srow db-row${open ? " open" : ""}`} key={row.key} data-db={row.key}>
        <button type="button" className="db-open" data-testid={`settings.database.open-${handleKey(row.key)}`} aria-expanded={open} onClick={() => toggle(row.key)}>
          <Icon id="right" cls="db-caret s14" />
          <Icon id="db" cls="src-ic" />
          <span className="sl">
            <b>{name}</b>
            {sample ? sampleLine(sample, row.job, done ? undefined : source) : source ? dbLine(source) : null}
          </span>
        </button>
        <div className="sv">
          {sample && (!source || done) ? (download ? fillButton(row, sample, done) : null) : source && edit ? (
            <>
              {own || source.state === "error" ? (
                <button type="button" className="ibtn" data-testid={`settings.database.refresh-${handleKey(row.key)}`} aria-label={`Refresh ${name}`} data-tip="Refresh" onClick={() => void act(row.key, refreshSource(source.id))}>
                  <Icon id="refresh" />
                </button>
              ) : null}
              <button type="button" className="ibtn" data-testid={`settings.database.remove-${handleKey(row.key)}`} aria-label={`Remove ${name}`} data-tip="Remove from Library" onClick={() => void act(row.key, removeSource(source.id))}>
                <Icon id="trash" />
              </button>
            </>
          ) : null}
        </div>
        <Fail err={rowErr[row.key] ?? null} />
        {open ? more(row) : null}
      </div>
    );
  };

  const lastRepoJob = value?.jobs.findLast(j => j.kind === "repository");
  const entered = url.trim().replace(/\.git\/?$|\/$/g, "").toLowerCase();
  const repoJob = busy(lastRepoJob) || entered === "" || entered === lastRepoJob?.key.toLowerCase() ? lastRepoJob : undefined;
  const repoUrl = repoJob && ["error", "cancelled"].includes(repoJob.state) ? repoJob.key : url;
  const repoReady = (key: string) => {
    const shownKey = key.replace(/\.git\/?$|\/$/g, "");
    return list.some(s => s.managed?.kind === "repository" && s.managed.key.toLowerCase() === shownKey.toLowerCase());
  };
  const shownJob = repoJob !== undefined && repoReady(repoJob.key) ? undefined : repoJob;
  const cloneAdded = repoReady(url);
  return (
    <>
      <Grp title="Databases" busy={stored === undefined}>
        {stored === NA ? (
          <Row label="Sample databases" err="Couldn't read the available samples.">
            <button type="button" className="btn outline" data-testid="settings.database.retry-samples" onClick={() => void retryImports()}>Retry</button>
          </Row>
        ) : value ? null : Array.from({ length: USUAL_SAMPLES }, (_, i) => (
          <div className="srow db-row" key={`skel-${i}`} data-skel="" aria-hidden="true">
            <span className="db-open">
              <Icon id="right" cls="db-caret s14" />
              <Icon id="db" cls="src-ic" />
              <span className="sl"><b><Skel w="6em" /></b><span className="d"><Skel w="20em" /></span></span>
            </span>
            <div className="sv"><Skel w="104px" /></div>
          </div>
        ))}
        {rows.map(dbRow)}
        {add}
      </Grp>
      {clone || clones.length > 0 ? (
        <Grp title="Clone a repository">
          {clones}
          {clone ? <div className="srow">
            <div className="sl"><b>GitHub URL</b>{line("Up to 64 MiB and 10,000 files.", shownJob, false, shownJob ? `${shownJob.label} · ` : "")}</div>
            <div className="sv">
              <input className="inp import-url" data-testid="settings.clone.url" aria-label="Public GitHub repository URL" placeholder="https://github.com/owner/repo" value={url} disabled={busy(repoJob)} onChange={e => setUrl(e.target.value)} />
              <button type="button" className="btn outline import-action" data-testid="settings.clone.start" disabled={cloneAdded || pending !== undefined} onClick={() => repoJob && busy(repoJob) ? void cancel(repoJob) : (setUrl(repoUrl), void start("repository", () => libraryRequest("sources.clone", { url: repoUrl })))}>
                {cloneAdded ? "Added" : busy(repoJob) ? "Cancel" : pending === "repository" ? "Starting…" : repoJob?.state === "error" || repoJob?.state === "cancelled" ? "Retry" : "Clone"}
              </button>
            </div>
          </div> : null}
        </Grp>
      ) : null}
      <Fail err={actionError} line />
    </>
  );
}
