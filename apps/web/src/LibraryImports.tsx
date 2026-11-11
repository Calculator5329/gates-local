import { useEffect, useRef, useState } from "react";
import type { SourceImport, SourceImports } from "@gates-local/contracts";
import { applyServerEvent, libraryRequest, settingsReads } from "./session.ts";
import { Fail, Grp, Skel } from "./settings-ui.tsx";
import { NA, useStore } from "./store.ts";
import { esc } from "./ui.tsx";

const bytes = (n: number) => n < 1_048_576 ? `${Math.ceil(n / 1024)} KiB` : `${(n / 1_048_576).toFixed(1)} MiB`;
const busy = (j?: SourceImport) => j !== undefined && ["downloading", "cloning", "adding"].includes(j.state);
/** The server's sample list today; the rows a placeholder draws when Settings opens before the list is read. */
const USUAL_SAMPLES = 2;

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

/** Polls only while this Settings section is open; remount and restart read the server's state. */
export default function LibraryImports() {
  // Read before Settings opened (session/settings-reads.ts), so the rows are there on the first frame.
  const [value, setValue] = useState<SourceImports | undefined>(settingsReads.imports());
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [pending, setPending] = useState<string>();
  const sources = useStore(s => s.sources);
  const live = useRef(true);
  const request = useRef(false);
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
    return () => { live.current = false; clearInterval(timer); };
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
  const ready = (kind: "sample" | "repository", key: string) => {
    const shownKey = kind === "repository" ? key.replace(/\.git\/?$|\/$/g, "") : key;
    return sources !== NA && sources?.some(s => s.managed?.kind === kind && s.managed.key.toLowerCase() === shownKey.toLowerCase());
  };
  const action = (key: string, job: SourceImport | undefined, added: boolean | undefined, begin: () => void, word: string) => (
    <button type="button" className="btn outline import-action" disabled={added || pending !== undefined} onClick={() => job && busy(job) ? void cancel(job) : begin()}>
      {added ? "Added" : busy(job) ? "Cancel" : pending === key ? "Starting…" : job?.state === "error" || job?.state === "cancelled" ? "Retry" : word}
    </button>
  );
  const lastRepoJob = value?.jobs.findLast(j => j.kind === "repository");
  const entered = url.trim().replace(/\.git\/?$|\/$/g, "").toLowerCase();
  const repoJob = busy(lastRepoJob) || entered === "" || entered === lastRepoJob?.key.toLowerCase() ? lastRepoJob : undefined;
  const repoUrl = repoJob && ["error", "cancelled"].includes(repoJob.state) ? repoJob.key : url;
  const repoAdded = repoJob !== undefined && ready("repository", repoJob.key);
  return (
    <>
      <Grp title="Sample databases" tip="Download a small database to try a Library query." busy={!value}>
        {value ? value.samples.map(sample => {
          const job = value.jobs.findLast(j => j.kind === "sample" && j.key === sample.id);
          const added = ready("sample", sample.id);
          return <div className="srow import-row" key={sample.id} data-import={sample.id}>
            <div className="sl"><b tabIndex={0} data-tip={`${esc(sample.license)}<br>Source: ${esc(sample.url)}`} >{sample.label}</b>{line(`${sample.description} · ${bytes(sample.sizeBytes)}`, job?.state === "ready" && !added ? undefined : job, added)}</div>
            <div className="sv">{action(sample.id, job, added, () => void start(sample.id, () => libraryRequest("sources.downloadSample", { id: sample.id })), "Download")}</div>
          </div>;
        }) : Array.from({ length: USUAL_SAMPLES }, (_, i) => (
          <div className="srow import-row" key={i} data-skel="" aria-hidden="true">
            <div className="sl"><b><Skel w="6em" /></b><span className="d"><Skel w="20em" /></span></div>
            <div className="sv"><Skel w="104px" /></div>
          </div>
        ))}
      </Grp>
      <Grp title="Clone a repository" tip="A public GitHub repository, read as a Library folder.">
        <div className="srow">
          <div className="sl"><b>GitHub URL</b>{line("Up to 64 MiB and 10,000 files.", repoJob, repoAdded, repoJob ? `${repoJob.label} · ` : "")}</div>
          <div className="sv">
            <input className="inp import-url" aria-label="Public GitHub repository URL" placeholder="https://github.com/owner/repo" value={url} disabled={busy(repoJob)} onChange={e => setUrl(e.target.value)} />
            {action("repository", repoJob, ready("repository", url), () => { setUrl(repoUrl); void start("repository", () => libraryRequest("sources.clone", { url: repoUrl })); }, "Clone")}
          </div>
        </div>
      </Grp>
      <Fail err={error} line />
    </>
  );
}
