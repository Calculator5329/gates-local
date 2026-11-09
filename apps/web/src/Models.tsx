// Settings › Models: what is installed, which one is the default, and
// downloading another. The design is the models-a4 mockup with the M3
// council rows on top: two tabs under a sticky title, the Default card inside
// Installed, one row menu (Use as default, Copy Ollama name, Remove…), a
// remove dialog that says what happens, and a Download tab that is the
// download flow as it was (ModelDownloads.tsx). The rules live in
// models-rules.ts and the session calls in models-actions.ts.
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { FitReport, ModelInfo } from "@gates-local/contracts";
import { copyText } from "./copy.ts";
import { k, noGpu } from "./format.ts";
import { Icon } from "./icons.tsx";
import { DownloadTab, DownloadingRows, isActive } from "./ModelDownloads.tsx";
import { cardDefault, makeDefault, removeModelAndMoveDefault, savedDefault } from "./models-actions.ts";
import {
  type ModelName,
  type Row,
  about,
  canBeDefault,
  filterShows,
  noteSettled,
  fitLabel,
  fitReason,
  fitSymbol,
  nameOf,
  nextDefault,
  shortTag,
  sizeText,
  sortRows,
  splitTail,
} from "./models-rules.ts";
import { canChat, notForChat } from "./pick.ts";
import { ensureFit, pull } from "./session.ts";
import { Fail, useAct, useOutside, walk } from "./settings-ui.tsx";
import { NA, type State, fitKey, setState, useStore } from "./store.ts";
import { closeTip, esc } from "./ui.tsx";

const catalogOf = (s: State) => (s.catalog === NA ? undefined : s.catalog);

/** The failure of the last action a control ran; cleared when the next try starts. */
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
  const cpu = useStore((s) => noGpu(s.gpu));
  if (report === undefined) return <span className="mp-fit none">Checking…</span>;
  if (report === "error") return <span className="mp-fit none">Couldn't check</span>;
  const exception = report.verdict !== "fits";
  return (
    <span className={`mp-fit ${report.verdict}${exception ? " x" : ""}`} tabIndex={exception ? 0 : undefined} data-tip={exception ? esc(fitReason(report, cpu)) : undefined}>
      <FitGlyph verdict={report.verdict} />
      <span className="mp-w">{fitLabel(report.verdict, undefined, cpu)}</span>
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
          </button>
        </div>
      </div>
      <div role="tabpanel" id="mp-panel" aria-labelledby={tab === "installed" ? "mp-tab-installed" : "mp-tab-download"}>
        {tab === "installed" ? <Installed /> : <DownloadTab />}
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
  const saved = useStore(savedDefault);
  // A removal that worked but could not save the next default. Ends for good once a default is saved.
  const [note, setNote] = useState<{ removed: string; text: string } | null>(null);
  if (note !== null && noteSettled(note.removed, saved)) setNote(null);
  const notice =
    note !== null && saved === undefined ? (
      <div className="mp-note">
        <Fail err={note.text} />
      </div>
    ) : null;
  if (models === undefined) return <p className="mp-quiet">Checking which models are installed…</p>;
  if (models.length === 0) {
    return (
      <>
        {notice}
        <NoModels />
      </>
    );
  }
  const q = filter.trim().toLowerCase();
  const shown = q === "" ? rows : rows.filter((r) => r.display.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  const total = models.reduce((sum, m) => sum + m.sizeBytes, 0);
  const shownDef = settingsNA ? undefined : def;
  return (
    <>
      {rows.some((r) => r.chat) ? <DefaultCard rows={rows} def={def} disabled={settingsNA} /> : null}
      {notice}
      {filterShows(rows.length, filter) ? (
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
          <ModelRowView key={r.name} r={r} def={shownDef} saved={saved} onRemove={(back) => setRemoving({ row: r, back })} />
        ))}
        <DownloadingRows />
        {shown.length === 0 ? <div className="mp-none">No installed model matches “{filter.trim()}”.</div> : null}
      </div>
      <div className="mp-foot">{sizeText(total)} on disk</div>
      {removing ? (
        <RemoveDialog
          row={removing.row}
          next={settingsNA ? undefined : nextDefault(rows, removing.row.name, def)}
          rows={rows}
          onDefaultFailed={(text) => setNote({ removed: removing.row.name, text })}
          onClose={() => {
            removing.back?.focus();
            setRemoving(null);
          }}
        />
      ) : null}
    </>
  );
}

function ModelRowView({ r, def, saved, onRemove }: { r: InstalledRow; def: string | undefined; saved: string | undefined; onRemove: (back: HTMLElement | null) => void }) {
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
      <RowMenu r={r} saved={saved} onRemove={onRemove} />
    </div>
  );
}

// ---------------------------------------------------------------- row menu

function RowMenu({ r, saved, onRemove }: { r: InstalledRow; saved: string | undefined; onRemove: (back: HTMLElement | null) => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const [err, run] = useAct();
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
          {!settingsNA && canBeDefault(r, saved) ? (
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

function RemoveDialog({ row, next, rows, onDefaultFailed, onClose }: { row: InstalledRow; next: string | null | undefined; rows: readonly InstalledRow[]; onDefaultFailed: (note: string) => void; onClose: () => void }) {
  const [err, run] = useAct();
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  // On open, and after a removal that failed. While one runs both buttons are disabled and the dialog holds focus.
  useEffect(() => {
    if (!busy) cancel.current?.focus();
  }, [busy]);
  const name = row.label.text;
  const nextName = next ? (rows.find((r) => r.name === next)?.label.text ?? next) : null;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (!busy) onClose();
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
      <div className="mp-dlg" role="dialog" aria-modal="true" aria-labelledby="mp-dlg-t" ref={box} tabIndex={-1} onKeyDown={onKey}>
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
          <button ref={cancel} type="button" className="btn outline" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn mp-danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              box.current?.focus();
              const done = removeModelAndMoveDefault(row.name, next);
              void run(done.then((d) => d.removeErr)).then(async (removed) => {
                setBusy(false);
                if (!removed) return;
                const { defaultErr } = await done;
                if (defaultErr !== null) onDefaultFailed(`${name} was removed. ${defaultErr}${nextName ? " Choose the default above." : ""}`);
                onClose();
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
  const [err, run] = useAct();
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const chat = rows.filter((r) => r.chat);
  const runs = chat.filter((r) => r.verdict !== "refuse");
  const wont = chat.filter((r) => r.verdict === "refuse");
  const current = rows.find((r) => r.name === def);
  const numCtx = useStore((s) => s.numCtx);
  // the number is only worth showing when this model cannot reach the default size
  const max = current?.info.maxContext;
  const limit = max !== undefined && max < numCtx ? max : undefined;
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
        <span>
          New chats start on this model. If it's too big for this computer, they start on the best one that fits. Any chat can switch from its model menu.
          {limit === undefined ? null : ` This model can only run at ${k(limit)}, so long chats drop their oldest messages.`}
        </span>
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
  const downloading = useStore((s) => Object.values(s.pulls).some(isActive));
  const pullNA = useStore((s) => s.unavailable["models.pull"] === true);
  const cpu = useStore((s) => noGpu(s.gpu));
  const [err, run] = useAct();
  if (downloading) {
    return (
      <div className="mp-first">
        <h2>Your first model is downloading</h2>
        <p>It shows up here when it is ready. You can keep using Settings meanwhile.</p>
        <DownloadingRows />
      </div>
    );
  }
  // with no supported GPU the best a model can do is load into system memory
  const pick = catalog?.find((c) => c.recommended && c.fit?.verdict === (cpu ? "spills" : "fits"));
  return (
    <div className="mp-empty">
      <Icon id="box" cls="mp-big" />
      <h2>No models yet</h2>
      <p>
        Download one to start chatting.
        {pick ? (
          <>
            {" "}
            We suggest <b>{pick.label}</b>: {about(pick.downloadBytes)}, {cpu ? "runs in system memory" : "runs well"} on this computer.
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
    </div>
  );
}

// ---------------------------------------------------------------- filter field

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

