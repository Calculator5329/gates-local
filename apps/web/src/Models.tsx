// Settings › Models: what is installed, which one is the default, and
// downloading another. The design is the models-a4 mockup with the M3
// council rows on top: two tabs under a sticky title, the Default card inside
// Installed, one row menu (Use as default, Copy Ollama name, Remove…), a
// remove dialog that says what happens, and a Download tab with the running
// downloads pinned over one search field and the Recommended picks. The rules
// live in models-rules.ts and the session calls in models-actions.ts.
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import type { CatalogEntry, FitReport, ModelInfo, PullProgress } from "@gates-local/contracts";
import { k } from "./format.ts";
import { Icon } from "./icons.tsx";
import { cancelDownload, cardDefault, dismissDownload, makeDefault, removeModelAndMoveDefault, startChatWith } from "./models-actions.ts";
import {
  type Lookup,
  type ModelName,
  type Row,
  about,
  canBeDefault,
  downloadCards,
  fitLabel,
  fitReason,
  fitSymbol,
  isActive,
  lookup,
  matchCatalog,
  nameOf,
  nextDefault,
  progressParts,
  recommendedPicks,
  shortTag,
  sizeText,
  sortRows,
  splitTail,
} from "./models-rules.ts";
import { canChat, notForChat } from "./pick.ts";
import { type ActionResult, ensureFit, leaveSettings, pull } from "./session.ts";
import { NA, type State, fitKey, setState, useStore } from "./store.ts";
import { closeTip, esc } from "./ui.tsx";

const LIBRARY_URL = "https://ollama.com/library";
/** The filter field shows once the list is longer than this. */
const FILTER_FROM = 8;

const catalogOf = (s: State) => (s.catalog === NA ? undefined : s.catalog);

/** The failure of the last action a control ran; cleared when the next try starts. */
function useResult(): [string | null, (action: Promise<ActionResult>) => Promise<boolean>] {
  const [err, setErr] = useState<string | null>(null);
  const run = async (action: Promise<ActionResult>) => {
    setErr(null);
    const r = await action;
    setErr(r);
    return r === null;
  };
  return [err, run];
}

const Fail = ({ err }: { err: string | null }) =>
  err === null ? null : (
    <span className="act-err" role="alert">
      {err}
    </span>
  );

// ---------------------------------------------------------------- names and fit

/** A name on the page: curated label, or the tag in mono cut in the middle so the quant tail always shows. */
function Name({ n, tag }: { n: ModelName; tag: string }) {
  if (!n.mono) return <span className="mp-nmn">{n.text}</span>;
  const [head, tail] = splitTail(n.text);
  return (
    <span className="mp-tag" data-tip={n.text === tag && tail === "" ? undefined : `<span class="mono">${esc(tag)}</span>`}>
      <span className="mp-h">{head}</span>
      {tail ? <span className="mp-t">{tail}</span> : null}
    </span>
  );
}

/** The fit symbol: half-filled for slower, struck for won't run. */
function FitGlyph({ verdict }: { verdict: FitReport["verdict"] }) {
  const sym = fitSymbol(verdict);
  if (sym === null) return null;
  return (
    <svg className="mp-g" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="3" />
      {sym === "slow" ? <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" /> : null}
      {sym === "big" ? <path d="M6 6l12 12" stroke="currentColor" strokeWidth="3" /> : null}
      {sym === "ok" ? <circle cx="12" cy="12" r="4" fill="currentColor" /> : null}
    </svg>
  );
}

/** "Runs well" stays quiet; the exceptions carry colour, a symbol, and their reason on hover or focus. */
function Fit({ report }: { report: FitReport | "error" | undefined }) {
  if (report === undefined) return <span className="mp-fit none">Checking…</span>;
  if (report === "error") return <span className="mp-fit none">Couldn't check</span>;
  const exception = report.verdict !== "fits";
  return (
    <span className={`mp-fit ${report.verdict}${exception ? " x" : ""}`} tabIndex={exception ? 0 : undefined} data-tip={exception ? esc(fitReason(report)) : undefined}>
      <FitGlyph verdict={report.verdict} />
      <span className="mp-w">{fitLabel(report.verdict)}</span>
    </span>
  );
}

// ---------------------------------------------------------------- the installed list

interface InstalledRow extends Row {
  readonly info: ModelInfo;
  readonly label: ModelName;
  readonly report: FitReport | "error" | undefined;
}

function useInstalledRows(): { rows: InstalledRow[]; def: string | undefined } {
  const models = useStore((s) => s.models);
  const catalog = useStore(catalogOf);
  const numCtx = useStore((s) => s.numCtx);
  const fits = useStore((s) => s.fits);
  const def = useStore(cardDefault);
  useEffect(() => {
    for (const m of models ?? []) if (canChat(m)) ensureFit(m.name, numCtx);
  }, [models, numCtx, fits]);
  const rows = (models ?? []).map((info): InstalledRow => {
    const chat = canChat(info);
    const checked = fits[fitKey(info.name, numCtx)];
    const report = !chat ? undefined : (checked ?? catalog?.find((c) => c.name === info.name)?.fit);
    const label = nameOf(info.name, catalog);
    return { name: info.name, display: label.text, chat, verdict: report === undefined || report === "error" ? undefined : report.verdict, info, label, report };
  });
  return { rows: sortRows(rows, def), def };
}

export function ModelsPage() {
  const addPage = useStore((s) => s.addPage);
  const count = useStore((s) => s.models?.length);
  const running = useStore((s) => Object.values(s.pulls).filter(isActive).length);
  const tab = addPage ? "download" : "installed";
  const tabs = [useRef<HTMLButtonElement>(null), useRef<HTMLButtonElement>(null)] as const;
  const go = (download: boolean, focus = false) => {
    closeTip();
    setState({ addPage: download });
    if (focus) tabs[download ? 1 : 0].current?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      go(e.key === "End" || (e.key !== "Home" && !addPage), true);
    }
  };
  return (
    <div className="mp">
      <div className="mp-ptop">
        <button type="button" className="mp-back" onClick={leaveSettings}>
          <Icon id="left" />
          Back to chat
        </button>
        <b>Models</b>
      </div>
      <div className="mp-head">
        <h1>Models</h1>
        <div className="mp-tabs" role="tablist" aria-label="Models" onKeyDown={onKey}>
          <button
            ref={tabs[0]}
            type="button"
            role="tab"
            id="mp-tab-installed"
            aria-selected={tab === "installed"}
            aria-controls="mp-panel"
            tabIndex={tab === "installed" ? 0 : -1}
            className={`mp-tab${tab === "installed" ? " on" : ""}`}
            onClick={() => go(false)}
          >
            <span className="mp-lbl" data-l="Installed">
              Installed
            </span>
            {count === undefined ? null : <span className="mp-n">{count}</span>}
          </button>
          <button
            ref={tabs[1]}
            type="button"
            role="tab"
            id="mp-tab-download"
            aria-selected={tab === "download"}
            aria-controls="mp-panel"
            tabIndex={tab === "download" ? 0 : -1}
            className={`mp-tab${tab === "download" ? " on" : ""}`}
            onClick={() => go(true)}
          >
            <span className="mp-lbl" data-l="Download">
              Download
            </span>
            {running > 0 && tab !== "download" ? (
              <span className="mp-live">
                <i className="mp-dot" />
                {running} downloading
              </span>
            ) : null}
          </button>
        </div>
      </div>
      <div role="tabpanel" id="mp-panel" aria-labelledby={tab === "installed" ? "mp-tab-installed" : "mp-tab-download"}>
        {tab === "installed" ? <Installed /> : <Download />}
      </div>
    </div>
  );
}

function Installed() {
  const models = useStore((s) => s.models);
  const { rows, def } = useInstalledRows();
  const [filter, setFilter] = useState("");
  const [removing, setRemoving] = useState<{ row: InstalledRow; back: HTMLElement | null } | null>(null);
  const settingsNA = useStore((s) => s.settings === NA);
  if (models === undefined) return <p className="mp-quiet">Checking which models are installed…</p>;
  if (models.length === 0) return <NoModels />;
  const q = filter.trim().toLowerCase();
  const shown = q === "" ? rows : rows.filter((r) => r.display.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  const total = models.reduce((sum, m) => sum + m.sizeBytes, 0);
  const savedDef = settingsNA ? undefined : def;
  return (
    <>
      {rows.some((r) => r.chat) ? <DefaultCard rows={rows} def={def} disabled={settingsNA} /> : null}
      {rows.length > FILTER_FROM ? (
        <Field value={filter} onChange={setFilter} placeholder="Filter installed models" label="Filter installed models" cls="mp-filter" />
      ) : null}
      <div className="mp-card">
        <div className="mp-th" aria-hidden="true">
          <span>Model</span>
          <span className="mp-sz">Size</span>
          <span className="mp-fitc">On this computer</span>
          <span />
        </div>
        {shown.map((r) => (
          <ModelRowView key={r.name} r={r} def={savedDef} onRemove={(back) => setRemoving({ row: r, back })} />
        ))}
        {shown.length === 0 ? <div className="mp-none">No installed model matches “{filter.trim()}”.</div> : null}
      </div>
      <div className="mp-foot">{sizeText(total)} on disk</div>
      {removing ? (
        <RemoveDialog
          row={removing.row}
          next={settingsNA ? undefined : nextDefault(rows, removing.row.name, def)}
          rows={rows}
          onClose={() => {
            removing.back?.focus();
            setRemoving(null);
          }}
        />
      ) : null}
    </>
  );
}

function ModelRowView({ r, def, onRemove }: { r: InstalledRow; def: string | undefined; onRemove: (back: HTMLElement | null) => void }) {
  const isDef = r.name === def;
  const why = r.chat ? undefined : notForChat(r.info);
  const fit = why ? (
    <span className="mp-fit none" data-tip={esc(why.tip)}>
      {why.label}
    </span>
  ) : (
    <Fit report={r.report} />
  );
  const chip = isDef ? (
    <span className="mp-chip">
      <Icon id="check" cls="s12" />
      Default
    </span>
  ) : null;
  return (
    <div
      className={`mp-row${r.verdict === "refuse" ? " cant" : ""}${r.chat ? "" : " emb"}`}
      {...(r.chat ? { "data-dm": r.name } : { "data-em": r.name })}
      aria-label={r.label.text}
    >
      <div className="mp-nm">
        <div className="mp-l1">
          <Name n={r.label} tag={r.name} />
          {chip}
        </div>
        {r.label.purpose ? <div className="mp-p">{r.label.purpose}</div> : null}
        <div className="mp-meta">
          {chip}
          <span>{sizeText(r.info.sizeBytes)}</span>
          <span aria-hidden="true">·</span>
          {fit}
        </div>
      </div>
      <span className="mp-sz">{sizeText(r.info.sizeBytes)}</span>
      <span className="mp-fitc">{fit}</span>
      <RowMenu r={r} def={def} onRemove={onRemove} />
    </div>
  );
}

// ---------------------------------------------------------------- row menu

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // a browser without clipboard access: the old way
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

/** Close a popover on a press outside it. */
function useOutside(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [ref, open, close]);
}

/** Arrow keys walk the items of a menu or list, skipping disabled ones; Escape closes it. */
function walk(e: KeyboardEvent<HTMLElement>, box: HTMLElement | null, selector: string, close: () => void): void {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    close();
    return;
  }
  if (e.key === "Tab") return close();
  const items = [...(box?.querySelectorAll<HTMLElement>(selector) ?? [])].filter((el) => el.getAttribute("aria-disabled") !== "true");
  const at = items.indexOf(document.activeElement as HTMLElement);
  const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
  if (step === 0 && e.key !== "Home" && e.key !== "End") return;
  e.preventDefault();
  const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + step + items.length) % items.length;
  items[next]?.focus();
}

function RowMenu({ r, def, onRemove }: { r: InstalledRow; def: string | undefined; onRemove: (back: HTMLElement | null) => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const [err, run] = useResult();
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const canRemove = useStore((s) => s.unavailable["models.remove"] !== true);
  const settingsNA = useStore((s) => s.settings === NA);
  const close = (refocus = true) => {
    setOpen(false);
    setCopied(null);
    if (refocus) btn.current?.focus();
  };
  useOutside(box, open, () => close(false));
  useEffect(() => {
    if (open) box.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [open]);
  const [head, tail] = splitTail(shortTag(r.name));
  return (
    <div className="mp-acts" ref={box} onKeyDown={(e) => open && walk(e, box.current, "[role=menuitem]", close)}>
      <button
        ref={btn}
        type="button"
        className={`mp-kebab${open ? " on" : ""}`}
        aria-label={`More for ${r.label.text}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          closeTip();
          setOpen((o) => !o);
          setCopied(null);
        }}
      >
        <Icon id="more" />
      </button>
      {open ? (
        <div className="mp-menu" role="menu" aria-label={r.label.text}>
          {!settingsNA && canBeDefault(r, def) ? (
            <button
              type="button"
              role="menuitem"
              className="mp-mi"
              onClick={() => {
                void run(makeDefault(r.name)).then((ok) => ok && close());
              }}
            >
              <Icon id="check" />
              Use as default
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className={`mp-mi${copied === "yes" ? " ok" : ""}`}
            onClick={() => {
              void copyText(r.name).then((ok) => setCopied(ok ? "yes" : "no"));
            }}
          >
            <Icon id={copied === "yes" ? "check" : "copy"} />
            {copied === "yes" ? "Copied" : copied === "no" ? "Couldn't copy" : "Copy Ollama name"}
            <span className="mp-k mono">
              <span className="mp-h">{head}</span>
              {tail ? <span className="mp-t">{tail}</span> : null}
            </span>
          </button>
          {canRemove ? (
            <>
              <div className="mp-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="mp-mi danger"
                onClick={() => {
                  close(false);
                  onRemove(btn.current);
                }}
              >
                <Icon id="trash" />
                Remove…
                <span className="mp-k">frees {sizeText(r.info.sizeBytes)}</span>
              </button>
            </>
          ) : null}
          <Fail err={err} />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- remove dialog

function RemoveDialog({ row, next, rows, onClose }: { row: InstalledRow; next: string | null | undefined; rows: readonly InstalledRow[]; onClose: () => void }) {
  const [err, run] = useResult();
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  const name = row.label.text;
  const nextName = next ? (rows.find((r) => r.name === next)?.label.text ?? next) : null;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Tab") {
      // keep focus inside the dialog
      const els = [...(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? [])];
      const at = els.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      els[(at + (e.shiftKey ? -1 : 1) + els.length) % els.length]?.focus();
    }
  };
  return (
    <div className="mp-scrim" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="mp-dlg" role="dialog" aria-modal="true" aria-labelledby="mp-dlg-t" ref={box} onKeyDown={onKey}>
        <h3 id="mp-dlg-t">Remove {name}?</h3>
        <p>
          Frees {sizeText(row.info.sizeBytes)}. Chats you made with {name} stay, and you can download it again later.
        </p>
        {next === undefined ? null : nextName ? (
          <p>
            <b>{nextName}</b>, the next model in your list, becomes the default for new chats.
          </p>
        ) : (
          <p>No other installed model can chat, so new chats wait until you download one.</p>
        )}
        <Fail err={err} />
        <div className="mp-r2">
          <button ref={cancel} type="button" className="btn outline" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn mp-danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void run(removeModelAndMoveDefault(row.name, next)).then((ok) => {
                setBusy(false);
                if (ok) onClose();
              });
            }}
          >
            {busy ? "Removing…" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- default card

function DefaultCard({ rows, def, disabled }: { rows: readonly InstalledRow[]; def: string | undefined; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [err, run] = useResult();
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const numCtx = useStore((s) => s.numCtx);
  const chat = rows.filter((r) => r.chat);
  const runs = chat.filter((r) => r.verdict !== "refuse");
  const wont = chat.filter((r) => r.verdict === "refuse");
  const current = rows.find((r) => r.name === def);
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };
  useOutside(box, open, () => close(false));
  useEffect(() => {
    if (open) (box.current?.querySelector<HTMLElement>("[role=option][aria-selected=true]") ?? box.current?.querySelector<HTMLElement>("[role=option]"))?.focus();
  }, [open]);
  const pick = (name: string) => {
    void run(makeDefault(name)).then((ok) => ok && close());
  };
  const option = (r: InstalledRow, off: boolean) => (
    <div
      key={r.name}
      role="option"
      tabIndex={-1}
      aria-selected={r.name === def}
      aria-disabled={off}
      className={`mp-opt${off ? " off" : ""}`}
      onClick={() => !off && pick(r.name)}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !off) {
          e.preventDefault();
          pick(r.name);
        }
      }}
    >
      {r.name === def ? <Icon id="check" cls="s14 mp-ck" /> : <span />}
      <span className="mp-nmx">
        <Name n={r.label} tag={r.name} />
      </span>
      {r.report !== undefined && r.report !== "error" && r.report.verdict !== "fits" ? <Fit report={r.report} /> : <span />}
      <span className="mp-osz">{sizeText(r.info.sizeBytes)}</span>
    </div>
  );
  return (
    <div className="mp-defrow" ref={box} onKeyDown={(e) => open && walk(e, box.current, "[role=option]", close)}>
      <div className="mp-dl-l">
        <b>Default for new chats</b>
        <span>If it can't run at {k(numCtx)}, new chats start on your best model that fits the GPU. Any chat can switch from its model menu.</span>
        <Fail err={err} />
      </div>
      <button
        ref={btn}
        type="button"
        className={`mp-select${open ? " on" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Default for new chats: ${current?.label.text ?? "none"}`}
        disabled={disabled}
        onClick={() => {
          closeTip();
          setOpen((o) => !o);
        }}
      >
        <span className="mp-sv">{current ? <Name n={current.label} tag={current.name} /> : "Choose a model"}</span>
        <Icon id="down" cls="s14" />
      </button>
      {open ? (
        <div className="mp-dd" role="listbox" aria-label="Installed chat models">
          <div className="mp-cap">Installed chat models</div>
          {runs.map((r) => option(r, false))}
          {wont.length > 0 ? <div className="mp-sep" role="separator" /> : null}
          {wont.map((r) => option(r, true))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- zero models

function NoModels() {
  const catalog = useStore(catalogOf);
  const pulls = useStore((s) => s.pulls);
  const pullNA = useStore((s) => s.unavailable["models.pull"] === true);
  const [err, run] = useResult();
  const cards = downloadCards(pulls);
  if (cards.running.length > 0) {
    return (
      <div className="mp-first">
        <h2>Your first model is downloading</h2>
        <p>It shows up here when it is ready. You can keep using Settings meanwhile.</p>
        <DownloadCards />
      </div>
    );
  }
  const pick = recommendedPicks(catalog ?? [], new Set(), new Set()).picks[0];
  return (
    <div className="mp-empty">
      <Icon id="box" cls="mp-big" />
      <h2>No models yet</h2>
      <p>
        Download one to start chatting.
        {pick ? (
          <>
            {" "}
            We suggest <b>{pick.label}</b>: {about(pick.downloadBytes)}, runs well on this computer.
          </>
        ) : null}
      </p>
      <div className="mp-r2">
        {pick && !pullNA ? (
          <button type="button" className="btn primary" onClick={() => void run(pull(pick.name))}>
            <Icon id="download" cls="s14" />
            Download {pick.label}
          </button>
        ) : null}
        <button type="button" className={pick && !pullNA ? "btn outline" : "btn primary"} onClick={() => setState({ addPage: true })}>
          Browse models
        </button>
      </div>
      <Fail err={err} />
      <DownloadCards />
    </div>
  );
}

// ---------------------------------------------------------------- download tab

function Field({ value, onChange, placeholder, label, cls }: { value: string; onChange: (v: string) => void; placeholder: string; label: string; cls?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className={`mp-field${value ? " typed" : ""}${cls ? ` ${cls}` : ""}`}>
      <Icon id="search" cls="s14" />
      <input
        ref={ref}
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value !== "") {
            e.stopPropagation();
            onChange("");
          }
        }}
      />
      {value ? (
        <button
          type="button"
          className="mp-x"
          aria-label="Clear"
          onClick={() => {
            onChange("");
            ref.current?.focus();
          }}
        >
          <Icon id="x" cls="s14" />
        </button>
      ) : null}
    </div>
  );
}

function Download() {
  const catalogRaw = useStore((s) => s.catalog);
  const models = useStore((s) => s.models);
  const pulls = useStore((s) => s.pulls);
  const gpu = useStore((s) => s.gpu);
  const pullNA = useStore((s) => s.unavailable["models.pull"] === true);
  const [q, setQ] = useState("");
  const catalog = catalogRaw === NA || catalogRaw === undefined ? [] : catalogRaw;
  const installed = new Set((models ?? []).map((m) => m.name));
  const busy = new Set(Object.values(pulls).filter(isActive).map((p) => p.name));
  const typed = q.trim();
  return (
    <>
      <DownloadCards typed={typed} />
      {pullNA ? <p className="mp-quiet">Downloading models is not available in this build.</p> : null}
      <Field value={q} onChange={setQ} placeholder="Search or type a model name, like qwen3:4b" label="Search or type a model name" cls="mp-search" />
      {typed === "" ? (
        <Recommended catalog={catalog} catalogNA={catalogRaw === NA} installed={installed} busy={busy} gpu={gpu === NA ? undefined : gpu} />
      ) : (
        <Results q={typed} catalog={catalog} installed={installed} pulls={pulls} />
      )}
    </>
  );
}

/** The running, finished and failed downloads, pinned above the search. */
function DownloadCards({ typed = "" }: { typed?: string }) {
  const pulls = useStore((s) => s.pulls);
  const { running, ready, failed } = downloadCards(pulls, typed);
  if (running.length + ready.length + failed.length === 0) return null;
  return (
    <div className="mp-card mp-cards">
      {ready.map((p) => (
        <ReadyCard key={p.name} p={p} />
      ))}
      {running.map((p) => (
        <RunningCard key={p.name} p={p} />
      ))}
      {failed.map((p) => (
        <FailedCard key={p.name} p={p} />
      ))}
    </div>
  );
}

function useLabel(name: string): string {
  const catalog = useStore(catalogOf);
  return nameOf(name, catalog).text;
}

function RunningCard({ p }: { p: PullProgress }) {
  const label = useLabel(p.name);
  const [err, run] = useResult();
  const parts = progressParts(p);
  const meta: ReactNode[] = [];
  if (p.state === "queued") meta.push("Waiting for the download before it");
  else if (parts.pct === null) meta.push("Checking the Ollama library…");
  else {
    meta.push(<b key="pct">{parts.pct}%</b>);
    if (parts.left) meta.push(parts.left);
    if (parts.got) meta.push(parts.got);
    if (parts.rate) meta.push(parts.rate);
  }
  return (
    <div className="mp-row mp-dlc" data-pull={p.name}>
      <div className="mp-nm">
        <div className="mp-l1">
          <span className="mp-nmn">{label}</span>
        </div>
      </div>
      <div className="mp-acts">
        <button type="button" className="btn outline" aria-label={`Cancel downloading ${label}`} onClick={() => void run(cancelDownload(p.name))}>
          Cancel
        </button>
      </div>
      <div className="mp-prog">
        <div className="mp-bar" role="progressbar" aria-label={`${label} download`} aria-valuenow={parts.pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: `${parts.pct ?? 0}%` }} />
        </div>
        <div className="mp-pmeta">
          {meta.map((m, i) => (
            <span key={i} className={i > 0 ? "mp-g2" : undefined}>
              {m}
            </span>
          ))}
        </div>
        <Fail err={err} />
      </div>
    </div>
  );
}

function ReadyCard({ p }: { p: PullProgress }) {
  const label = useLabel(p.name);
  return (
    <div className="mp-row mp-ready" data-pull={p.name}>
      <div className="mp-nm">
        <div className="mp-l1">
          <Icon id="checkc" cls="s14 mp-okc" />
          <span className="mp-nmn">{label} is ready</span>
        </div>
      </div>
      <div className="mp-acts">
        <button type="button" className="btn outline" onClick={() => startChatWith(p.name)}>
          <Icon id="chat" cls="s14" />
          Start chat
        </button>
        <button type="button" className="mp-kebab" aria-label={`Dismiss ${label}`} onClick={() => dismissDownload(p.name)}>
          <Icon id="x" cls="s14" />
        </button>
      </div>
    </div>
  );
}

function FailedCard({ p }: { p: PullProgress }) {
  const label = useLabel(p.name);
  const [err, run] = useResult();
  return (
    <div className="mp-row mp-failed" data-pull={p.name}>
      <div className="mp-nm">
        <div className="mp-l1">
          <Icon id="alert" cls="s14 mp-errc" />
          <span className="mp-nmn">{label} didn't download</span>
        </div>
        <div className="mp-p mp-wrap">{p.message ?? "The download stopped."}</div>
        <Fail err={err} />
      </div>
      <div className="mp-acts">
        {p.reason === "not-found" ? null : (
          <button type="button" className="btn outline" onClick={() => void run(pull(p.name))}>
            Try again
          </button>
        )}
        <button type="button" className="mp-kebab" aria-label={`Dismiss ${label}`} onClick={() => dismissDownload(p.name)}>
          <Icon id="x" cls="s14" />
        </button>
      </div>
    </div>
  );
}

/** One catalog model with its size, fit and Download (or where it stands). */
function CatalogRow({ c, installed }: { c: CatalogEntry; installed: boolean }) {
  const p = useStore((s) => s.pulls[c.name]);
  const pullNA = useStore((s) => s.unavailable["models.pull"] === true);
  const [err, run] = useResult();
  const name = nameOf(c.name, [c]);
  const action = installed ? (
    <span className="badge">Installed</span>
  ) : p !== undefined && isActive(p) ? (
    <span className="mp-quiet">Downloading</span>
  ) : (
    <button type="button" className="btn outline" disabled={pullNA || c.fit?.verdict === "refuse"} aria-label={`Download ${c.label}`} onClick={() => void run(pull(c.name))}>
      <Icon id="download" cls="s14 mp-phone" />
      Download
    </button>
  );
  return (
    <div className="mp-row" data-cat={c.name}>
      <div className="mp-nm">
        <div className="mp-l1">
          <Name n={name} tag={c.name} />
        </div>
        {name.purpose ? <div className="mp-p">{name.purpose}</div> : null}
        <div className="mp-meta">
          <span>{sizeText(c.downloadBytes)}</span>
          {c.fit ? (
            <>
              <span aria-hidden="true">·</span>
              <Fit report={c.fit} />
            </>
          ) : null}
        </div>
        <Fail err={err} />
      </div>
      <span className="mp-sz">{sizeText(c.downloadBytes)}</span>
      <span className="mp-fitc">{c.fit ? <Fit report={c.fit} /> : null}</span>
      <div className="mp-acts">{action}</div>
    </div>
  );
}

function Recommended({
  catalog,
  catalogNA,
  installed,
  busy,
  gpu,
}: {
  catalog: readonly CatalogEntry[];
  catalogNA: boolean;
  installed: ReadonlySet<string>;
  busy: ReadonlySet<string>;
  gpu: State["gpu"];
}) {
  const r = recommendedPicks(catalog, installed, busy);
  const g = gpu === NA ? undefined : gpu;
  const forGpu = g?.vendor === "nvidia" && g.totalBytes ? `your ${about(g.totalBytes)} NVIDIA GPU` : "this computer";
  return (
    <section className="mp-blk" aria-labelledby="mp-rec-t">
      <div className="mp-gt">
        <b id="mp-rec-t">Recommended for {r.slower ? "this computer" : forGpu}</b>
        {r.slower ? <span>Nothing we suggest runs fully on your GPU; these run slower, partly in system memory.</span> : null}
      </div>
      {catalogNA ? (
        <p className="mp-quiet">The model list is not available in this build. You can still type a model name above.</p>
      ) : r.picks.length > 0 ? (
        <div className="mp-card">
          <div className="mp-th" aria-hidden="true">
            <span>Model</span>
            <span className="mp-sz">Size</span>
            <span className="mp-fitc">On this computer</span>
            <span />
          </div>
          {r.picks.map((c) => (
            <CatalogRow key={c.name} c={c} installed={false} />
          ))}
        </div>
      ) : r.allInstalled ? (
        <p className="mp-quiet">You have every model we'd suggest for this computer.</p>
      ) : null}
      <div className="mp-foot">
        <a className="mp-link" href={LIBRARY_URL} target="_blank" rel="noreferrer noopener" aria-label="Browse ollama.com/library (opens your browser)">
          Browse ollama.com/library
          <Icon id="ext" cls="s12" />
        </a>
      </div>
    </section>
  );
}

function LibraryRow({ q, l }: { q: string; l: Lookup }) {
  const pullNA = useStore((s) => s.unavailable["models.pull"] === true);
  const [err, run] = useResult();
  const [head, tail] = splitTail(q);
  const tag = (
    <span className={`mp-tag${l.k === "not-found" ? " miss" : ""}`}>
      <span className="mp-h">{head}</span>
      {tail ? <span className="mp-t">{tail}</span> : null}
    </span>
  );
  if (l.k === "not-found") {
    return (
      <div className="mp-row mp-lib" data-lib="not-found">
        <div className="mp-miss">
          No model called {tag} in the Ollama library. Check the spelling or browse{" "}
          <a className="mp-link" href={LIBRARY_URL} target="_blank" rel="noreferrer noopener">
            ollama.com/library
          </a>
        </div>
      </div>
    );
  }
  const right =
    l.k === "checking" ? (
      <span className="mp-lookup">
        <Icon id="spin" cls="s14 spin" />
        Checking the Ollama library…
      </span>
    ) : l.k === "found" ? (
      <span className="mp-lookup">Found · downloading above</span>
    ) : l.k === "installed" ? (
      <span className="mp-lookup">Installed</span>
    ) : null;
  return (
    <div className="mp-row mp-lib" data-lib={l.k}>
      <div className="mp-nm">
        <div className="mp-l1">{tag}</div>
        <Fail err={err} />
      </div>
      <span className="mp-sz">{l.k === "found" ? sizeText(l.totalBytes) : ""}</span>
      <span className="mp-fitc">{right}</span>
      <div className="mp-acts">
        {l.k === "unchecked" ? (
          <button type="button" className="btn outline" disabled={pullNA} aria-label={`Download ${q}`} onClick={() => void run(pull(q))}>
            <Icon id="download" cls="s14 mp-phone" />
            Download
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Results({ q, catalog, installed, pulls }: { q: string; catalog: readonly CatalogEntry[]; installed: ReadonlySet<string>; pulls: Readonly<Record<string, PullProgress>> }) {
  const l = lookup(q, catalog, installed, pulls);
  const related = matchCatalog(catalog, q);
  const library = l.k !== "none" && l.k !== "catalog";
  if (!library && related.length === 0) {
    return <p className="mp-quiet">No model in our list matches “{q}”. Type its full Ollama name, like qwen3:4b, to check the library.</p>;
  }
  return (
    <div className="mp-card mp-results">
      {library ? (
        <>
          <div className="mp-sub">Ollama library</div>
          <LibraryRow q={q} l={l} />
        </>
      ) : null}
      {related.length > 0 ? (
        <>
          <div className="mp-sub">{library ? "Related models" : "Models"}</div>
          {related.map((c) => (
            <CatalogRow key={c.name} c={c} installed={c.installed || installed.has(c.name)} />
          ))}
        </>
      ) : null}
    </div>
  );
}
