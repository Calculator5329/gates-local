import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import type { SampleDatabase, Source, SourceImport, SourceImports } from "@gates-local/contracts";
import { rtOf } from "./Banner.tsx";
import { count, fileSize } from "./format.ts";
import { handleKey } from "./handles.ts";
import { Icon } from "./icons.tsx";
import { askWhy, databaseRows, type DbRow } from "./library-rows.ts";
import { chatModels } from "./pick.ts";
import { applyServerEvent, libraryRequest, refreshSource, removeSource, settingsReads } from "./session.ts";
import { libraryToolCanUse } from "./settings-rules.ts";
import { PathText } from "./settings-controls.tsx";
import { Fail, Grp, Skel } from "./settings-ui.tsx";
import { askWith } from "./starter.ts";
import { NA, useStore } from "./store.ts";
import { esc } from "./ui.tsx";

const bytes = (n: number) => n < 1_048_576 ? `${Math.ceil(n / 1024)} KiB` : `${(n / 1_048_576).toFixed(1)} MiB`;
const busy = (j?: SourceImport) => j !== undefined && ["downloading", "cloning", "adding"].includes(j.state);
/** The server's sample list today; the slots a placeholder draws when Settings opens before the list is read. */
const USUAL_SAMPLES = 4;
/** How long a finished download shows its check before the row shows the database. */
const FINISH_MS = 900;
const still = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/** The shortest a download button takes to fill, from the press to full, so a quick download is seen to happen (owner 2026-11-13, settings row 12). */
export const MIN_FILL_MS = 800;
/** The fill a button shows: the real fraction, never ahead of what the time since the run began allows. */
export const shownFill = (real: number, since: number | undefined, now: number) => since === undefined ? real : Math.min(real, Math.max(0, (now - since) / MIN_FILL_MS));
/** The pinned file's repository at its commit: raw.githubusercontent.com/o/r/<sha>/… → github.com/o/r/tree/<sha>. */
const repoOf = (url: string) => url.replace(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([0-9a-f]{40})\/.*$/, "https://github.com/$1/$2/tree/$3");
/** On Windows the database tool is Query databases; elsewhere Run commands reads them in its sandbox (Settings › Tools). */
const DB_TOOL = typeof navigator !== "undefined" && /\bWindows\b/.test(navigator.userAgent) ? "query" : "run";

/**
 * A row's description line: its description at rest, the job's progress or
 * result once the person started one, drawn over the description it hides so
 * the row keeps the height it had at rest (a phone wraps the description to
 * two lines; progress takes one). Nothing is reserved for a job that has not
 * started; an error may take two lines, its full text in the tooltip.
 */
const line = (rest: string, job?: SourceImport, added = false, prefix = "") => {
  const error = !added && job?.state === "error";
  const words = !job ? "" : added ? "Ready in Library" : job.detail ? job.detail : job.state === "downloading" ? `Downloading ${bytes(job.bytes)}${job.total ? ` of ${bytes(job.total)}` : ""}` : job.state === "cloning" ? `Cloning · ${bytes(job.bytes)} received` : job.state === "adding" ? "Adding to Library…" : "Ready in Library";
  return (
    <span className="d import-line">
      <span className={job ? "import-rest gone" : "import-rest"}>{rest}</span>
      <span className="import-status" role={error ? "alert" : "status"} data-tip={!added && job?.detail ? esc(job.detail) : undefined}>{job ? `${prefix}${words}` : ""}</span>
    </span>
  );
};

/** A database's words: its tables and size, or what its last refresh is doing or hit. */
const dbWords = (src: Source) =>
  src.state === "refreshing" ? "Refreshing…"
    : src.state === "error" ? src.detail ?? "Couldn't read it."
      : [...(src.tables ? [count(src.tableCount ?? src.tables.length, "table")] : []), ...(src.sizeBytes === undefined ? [] : [fileSize(src.sizeBytes)])].join(" · ");

/** An own database's line. */
const dbLine = (src: Source) => src.state === "error"
  ? <span className="d act-err" role="alert" data-tip={esc(dbWords(src))}>{dbWords(src)}</span>
  : <span className="d">{dbWords(src)}</span>;

/**
 * A sample slot's line, in all three of its faces at once, one cell deep:
 * what it holds; how the last try ended; the database it became. Only one is
 * visible, and the row is the height of the tallest from the first frame, so
 * a download that ends, fails or is removed never moves the rows below.
 */
const sampleLine = (sample: SampleDatabase, job: SourceImport | undefined, source: Source | undefined) => {
  const ended = !source && (job?.state === "error" || job?.state === "cancelled");
  const words = job?.detail ?? (job?.state === "cancelled" ? "Download cancelled." : "Couldn't download it.");
  // The database face before it exists: its size and tables as the catalog has them.
  const as = source ?? { state: "ready", tables: sample.tables, sizeBytes: sample.sizeBytes } as Source;
  return (
    <span className="d import-line">
      <span className={source || ended ? "import-rest gone" : "import-rest"}>{`Sample · ${sample.description} · ${fileSize(sample.sizeBytes)}`}</span>
      <span className={ended ? "import-status" : "import-status gone"} role={job?.state === "error" && ended ? "alert" : "status"} data-tip={ended ? esc(words) : undefined}>{ended ? words : ""}</span>
      <span className={source ? `import-db${as.state === "error" ? " act-err" : ""}` : "import-db gone"} aria-hidden={source ? undefined : true}>{dbWords(as)}</span>
    </span>
  );
};

interface FillProps {
  name: string;
  /** The sample's key, the last part of the button's test name. */
  handle: string;
  /** The fraction really downloaded: 1 once the file is in. */
  real: number;
  /** When this run began (performance.now()); the fill takes at least MIN_FILL_MS from here. */
  since: number | undefined;
  running: boolean;
  done: boolean;
  /** What it says at rest: Download, or Retry after a failed or cancelled try. */
  idle: string;
  blocked: boolean;
  onPress: (e: MouseEvent<HTMLButtonElement>) => void;
}

/** Option A: the button is the progress. It fills with the fraction done and counts; pressing it while it fills cancels. */
function FillButton({ name, handle, real, since, running, done, idle, blocked, onPress }: FillProps) {
  const [, frame] = useState(0);
  const sweeping = !still() && (running || done);
  const shown = sweeping ? shownFill(real, since, performance.now()) : real;
  const behind = shown < real;
  // A download is finished only once a frame has drawn the fill full; until then it counts like any other.
  const drawnFull = useRef(false);
  const full = done && !behind;
  const finished = full && drawnFull.current;
  useEffect(() => {
    drawnFull.current = full;
    if (!behind && finished === full) return;
    const id = requestAnimationFrame(() => frame(n => n + 1));
    return () => cancelAnimationFrame(id);
  });
  const busyNow = !finished && (running || done);
  const pct = Math.floor(shown * 100);
  const label = finished ? "" : busyNow ? `${pct}%` : idle;
  return (
    <button
      type="button"
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

/** Settings › Library: one list of databases with the samples in it, then Clone a repository. Polls only while open; remount and restart read the server's state. */
export default function LibraryImports({ add, clone, clones = [] }: { add: ReactNode; clone: boolean; clones?: readonly ReactNode[] }) {
  // Read before Settings opened (session/settings-reads.ts), so the rows are there on the first frame.
  const [value, setValue] = useState<SourceImports | undefined>(settingsReads.imports());
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState<string>();
  const [opened, setOpened] = useState<readonly string[]>([]);
  const [finishing, setFinishing] = useState<readonly string[]>([]);
  const [rowErr, setRowErr] = useState<Readonly<Record<string, string>>>({});
  const sources = useStore(s => s.sources);
  // As Settings › Tools reads it: a client that cannot read settings (the phone) leaves the switch to the computer.
  const tools = useStore(s => s.settings === NA || s.settings?.tools === true);
  const chat = useStore(s => rtOf(s) === "ready" && chatModels(s.models ?? []).length > 0);
  const download = useStore(s => s.unavailable["sources.downloadSample"] !== true);
  const edit = useStore(s => s.unavailable["sources.remove"] !== true);
  const live = useRef(true);
  const request = useRef(false);
  // Samples whose download this visit saw running: when one lands, its row shows the finish once.
  const ran = useRef(new Set<string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  // When each sample's current run began, for the shortest fill.
  const started = useRef(new Map<string, number>());
  useEffect(() => {
    live.current = true;
    const read = async () => {
      if (request.current) return;
      request.current = true;
      try { const next = await libraryRequest("sources.imports", {}); settingsReads.keepImports(next); applyServerEvent(() => { if (live.current) setValue(next); }); }
      catch (e) { applyServerEvent(() => { if (live.current) setError(e instanceof Error ? e.message : "Couldn't read the available samples. Retry."); }); }
      finally { request.current = false; }
    };
    void read();
    const timer = setInterval(() => void read(), 500);
    const held = timers.current;
    return () => { live.current = false; clearInterval(timer); for (const t of held) clearTimeout(t); held.clear(); };
  }, []);
  const start = async (key: string, action: () => Promise<SourceImport>) => {
    if (pending !== undefined) return;
    setError(null);
    setPending(key);
    try {
      const job = await action();
      applyServerEvent(() => { if (live.current) setValue(v => v && ({ ...v, jobs: [...v.jobs.filter(j => j.id !== job.id && !(j.kind === job.kind && j.key === job.key)), job] })); });
    } catch (e) { applyServerEvent(() => { if (live.current) setError(e instanceof Error ? e.message : "Couldn't start this import. Retry."); }); }
    finally { if (live.current) setPending(undefined); }
  };
  const cancel = async (job: SourceImport) => {
    try { await libraryRequest("sources.cancelImport", { id: job.id }); }
    catch { applyServerEvent(() => { if (live.current) setError("Couldn't cancel while disconnected. Retry once Gates Local reconnects."); }); }
  };
  const act = async (key: string, action: Promise<string | null>) => {
    setRowErr(e => { const { [key]: _gone, ...rest } = e; return rest; });
    const failed = await action;
    if (failed !== null && live.current) setRowErr(e => ({ ...e, [key]: failed }));
  };
  const list = sources === NA || sources === undefined ? [] : sources;
  const rows = value ? databaseRows(value.samples, list, value.jobs) : databaseRows([], list.filter(s => s.managed?.kind !== "sample"), []);
  // A sample's run: pressed, downloading, or done and landing. A finished job is landing only for a download this
  // visit saw run; the server keeps it after its database is removed.
  const runs = (r: DbRow) => r.sample !== undefined && (busy(r.job) || pending === r.sample.id || (r.job?.state === "ready" && ran.current.has(r.sample.id)));
  for (const r of rows) {
    if (!r.sample || r.source) continue;
    if (busy(r.job) || pending === r.sample.id) ran.current.add(r.sample.id);
    if (!runs(r)) started.current.delete(r.sample.id);
    else if (!started.current.has(r.sample.id)) started.current.set(r.sample.id, performance.now());
  }
  const landed = rows.flatMap(r => r.sample && r.source && ran.current.has(r.sample.id) ? [r.sample.id] : []).join(" ");
  useEffect(() => {
    if (landed === "") return;
    const ids = landed.split(" ");
    for (const id of ids) ran.current.delete(id);
    if (still()) return;
    setFinishing(f => [...f, ...ids]);
    // The check shows for FINISH_MS once the fill is full, and a quick download's fill is still sweeping.
    const sweep = Math.max(0, ...ids.map(id => MIN_FILL_MS - (performance.now() - (started.current.get(id) ?? -Infinity))));
    const t = setTimeout(() => { timers.current.delete(t); if (live.current) setFinishing(f => f.filter(id => !ids.includes(id))); }, FINISH_MS + sweep);
    timers.current.add(t);
  }, [landed]);
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
        // A double click's second press (detail 2) lands on the running button; only a single press cancels. Enter and Space have detail 0.
        onPress={e => { if (job && busy(job)) { if (e.detail <= 1) void cancel(job); } else if (!running && !done) void start(sample.id, () => libraryRequest("sources.downloadSample", { id: sample.id })); }}
      />
    );
  };

  /** What an opened row shows: an own database's path, its tables, and for a sample its questions and licence. */
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
    const done = sample !== undefined && source !== undefined && (finishing.includes(sample.id) || (ran.current.has(sample.id) && !still()));
    const own = source !== undefined && sample === undefined;
    const copied = source?.snapshotAt === undefined ? "" : ` from ${new Date(source.snapshotAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
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
                <button type="button" className="ibtn" data-testid={`settings.database.refresh-${handleKey(row.key)}`} aria-label={`Refresh ${name}`} data-tip={own ? esc(`Refresh. The model reads a copy${copied}; refresh it to see later changes.`) : "Refresh"} onClick={() => void act(row.key, refreshSource(source.id))}>
                  <Icon id="refresh" />
                </button>
              ) : null}
              <button type="button" className="ibtn" data-testid={`settings.database.remove-${handleKey(row.key)}`} aria-label={`Remove ${name}`} data-tip={own ? "Remove from Library. The file stays where it is." : "Remove from Library"} onClick={() => void act(row.key, removeSource(source.id))}>
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
  // Once the copy is listed above, its own row says so; the URL row goes back to its rest line.
  const shownJob = repoJob !== undefined && repoReady(repoJob.key) ? undefined : repoJob;
  const cloneAdded = repoReady(url);
  return (
    <>
      <Grp title="Databases" busy={!value}>
        {value ? null : Array.from({ length: USUAL_SAMPLES }, (_, i) => (
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
        <Grp title="Clone a repository" tip="A public GitHub repository, copied once and read as a Library folder.">
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
      <Fail err={error} line />
    </>
  );
}
