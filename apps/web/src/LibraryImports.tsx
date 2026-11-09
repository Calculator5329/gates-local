import { useEffect, useRef, useState } from "react";
import type { SourceImport, SourceImports } from "@gates-local/contracts";
import { libraryRequest } from "./session.ts";
import { Fail, Grp, Row } from "./settings-ui.tsx";
import { NA, useStore } from "./store.ts";
import { esc } from "./ui.tsx";

const bytes = (n: number) => n < 1_048_576 ? `${Math.ceil(n / 1024)} KiB` : `${(n / 1_048_576).toFixed(1)} MiB`;
const busy = (j?: SourceImport) => j !== undefined && ["downloading", "cloning", "adding"].includes(j.state);
const status = (job?: SourceImport, added = false) => (
  <span className="d import-status" role={!added && job?.state === "error" ? "alert" : "status"} data-tip={!added && job?.detail ? esc(job.detail) : undefined}>
    {!job ? "\u00a0" : added ? "Ready in Library" : job.detail ? job.detail : job.state === "downloading" ? `Downloading ${bytes(job.bytes)}${job.total ? ` of ${bytes(job.total)}` : ""}` : job.state === "cloning" ? `Cloning · ${bytes(job.bytes)} received` : job.state === "adding" ? "Adding to Library…" : "Ready in Library"}
  </span>
);

/** Polls only while this Settings section is open; remount and restart read the server's state. */
export default function LibraryImports() {
  const [value, setValue] = useState<SourceImports>();
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
      try { const next = await libraryRequest("sources.imports", {}); if (live.current) setValue(next); }
      catch (e) { if (live.current) setError(e instanceof Error ? e.message : "Couldn't read the available samples. Retry."); }
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
      if (live.current) setValue(v => v && ({ ...v, jobs: [...v.jobs.filter(j => j.id !== job.id && !(j.kind === job.kind && j.key === job.key)), job] }));
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : "Couldn't start this import. Retry."); }
    finally { if (live.current) setPending(undefined); }
  };
  const cancel = async (job: SourceImport) => {
    try { await libraryRequest("sources.cancelImport", { id: job.id }); }
    catch { if (live.current) setError("Couldn't cancel while disconnected. Retry once Gates Local reconnects."); }
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
  return (
    <>
      <Grp title="Sample databases" desc="Download a small database to try a Library query.">
        {value?.samples.map(sample => {
          const job = value.jobs.findLast(j => j.kind === "sample" && j.key === sample.id);
          const added = ready("sample", sample.id);
          return <div className="srow import-row" key={sample.id} data-import={sample.id}>
            <div className="sl"><b tabIndex={0} data-tip={`${esc(sample.license)}<br>Source: ${esc(sample.url)}`} >{sample.label}</b><span className="d">{sample.description} · {bytes(sample.sizeBytes)}</span>{status(job?.state === "ready" && !added ? undefined : job, added)}</div>
            <div className="sv">{action(sample.id, job, added, () => void start(sample.id, () => libraryRequest("sources.downloadSample", { id: sample.id })), "Download")}</div>
          </div>;
        })}
        {!value ? <div className="src-none">Loading samples…</div> : null}
      </Grp>
      <Grp title="Clone a repository" desc="A public GitHub repository, read as a Library folder.">
        <Row label="GitHub URL" desc="Up to 64 MiB and 10,000 files." >
          <input className="inp import-url" aria-label="Public GitHub repository URL" placeholder="https://github.com/owner/repo" value={url} disabled={busy(repoJob)} onChange={e => setUrl(e.target.value)} />
          {action("repository", repoJob, ready("repository", url), () => { setUrl(repoUrl); void start("repository", () => libraryRequest("sources.clone", { url: repoUrl })); }, "Clone")}
        </Row>
        {repoJob ? <div className="src-none">{repoJob.label}{status(repoJob, ready("repository", repoJob.key))}</div> : null}
      </Grp>
      <Fail err={error} line />
    </>
  );
}
