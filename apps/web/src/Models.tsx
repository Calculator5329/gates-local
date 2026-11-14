// Settings › Models: what is installed, which one is the default, and
// downloading another. The design is the models-a4 mockup with the M3
// council rows on top: two tabs under a sticky title, the Default card inside
// Installed, one row menu (Use as default, Copy Ollama name, Remove…), a
// remove dialog that says what happens, and a Download tab that is the
// download flow as it was (ModelDownloads.tsx). The rules live in
// models-rules.ts and the session calls in models-actions.ts.
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { ModelInfo, PullProgress } from "@gates-local/contracts";
import { copyText } from "./copy.ts";
import { k, noGpu } from "./format.ts";
import { Icon } from "./icons.tsx";
import { type TableFit, rowOf } from "./fit-table.ts";
import { DownloadTab, DownloadingRow, DownloadingRows, othersLine, othersOf, usePendingDownloads } from "./ModelDownloads.tsx";
import { cardDefault, makeDefault, removeModelAndMoveDefault, savedDefault } from "./models-actions.ts";
import {
  FIT_DOT,
  type ModelName,
  type Row,
  about,
  canBeDefault,
  filterShows,
  noteSettled,
  fitLabel,
  fitReason,
  nameOf,
  nextDefault,
  optionVariants,
  shortTag,
  sizeText,
  sortRows,
  splitTail,
} from "./models-rules.ts";
import { awaitingInstall, canChat, notForChat, pickedModel } from "./pick.ts";
import { MakerMark } from "./MakerMark.tsx";
import { MemoryMark } from "./MemoryMark.tsx";
import { ModelSpeed } from "./model-speed.tsx";
import { DialogHead } from "./Panel.tsx";
import { leaveSettings, pull } from "./session.ts";
import { PathText } from "./settings-controls.tsx";
import { COMPUTER_ONLY, Fail, Tipped, useAct, useOutside, walk } from "./settings-ui.tsx";
import { NA, type State, setState, useStore } from "./store.ts";
import { FitSkel, PHONE, closeTip, esc, useMedia } from "./ui.tsx";

const catalogOf = (s: State) => (s.catalog === NA ? undefined : s.catalog);
const cannotSaveDefault = (s: State) => s.settings === NA || s.unavailable["settings.update"] === true;

/** The failure of the last action a control ran; cleared when the next try starts. */
// ---------------------------------------------------------------- names and fit

/** In the Default menu, an option that does not run well says so in words, with its reason on hover or focus. */
function FitWords({ report }: { report: TableFit }) {
  const cpu = useStore((s) => noGpu(s.gpu));
  return (
    <span className="mp-fit x" tabIndex={0} data-tip={esc(fitReason(report, cpu))}>
      <span className={`dot ${FIT_DOT[report.verdict]}`} />
      <span className="mp-w">{fitLabel(report.verdict, report.source === "measured", cpu)}</span>
    </span>
  );
}

/** The memory mark against the card (row 28); the verdict's words and reason are its name and tip. */
function Fit({ report }: { report: TableFit | undefined }) {
  const cpu = useStore((s) => noGpu(s.gpu));
  const tabled = useStore((s) => s.fitTable !== undefined);
  if (report === undefined) return tabled ? <span className="mp-fit none">–</span> : <span className="mp-fit none" aria-busy="true"><FitSkel w="120px" /></span>;
  const words = fitLabel(report.verdict, report.source === "measured", cpu);
  return (
    <span className="mp-fit">
      <MemoryMark report={report} words={words} tip={`<b>${esc(words)}</b><br>${esc(fitReason(report, cpu))}`} />
    </span>
  );
}

// ---------------------------------------------------------------- the installed list

interface InstalledRow extends Row {
  readonly info: ModelInfo;
  readonly label: ModelName;
  readonly report: TableFit | undefined;
}

function useInstalledRows(): { rows: InstalledRow[]; def: string | undefined } {
  const models = useStore((s) => s.models);
  const catalog = useStore(catalogOf);
  const numCtx = useStore((s) => s.numCtx);
  const fitTable = useStore((s) => s.fitTable);
  const def = useStore(cardDefault);
  const rows = (models ?? []).map((info): InstalledRow => {
    const chat = canChat(info);
    const report = chat ? rowOf({ fitTable, models, numCtx }, info.name) : undefined;
    const label = nameOf(info.name, catalog);
    return { name: info.name, display: label.text, chat, verdict: report?.verdict, info, label, report };
  });
  return { rows: sortRows(rows, def), def };
}

export function ModelsPage() {
  const canDownload = useStore((s) => s.unavailable["models.pull"] !== true);
  const addPage = useStore((s) => s.addPage) && canDownload;
  const count = useStore((s) => s.models?.length);
  const tab = addPage ? "download" : "installed";
  const phone = useMedia(PHONE);
  const tabs = [useRef<HTMLButtonElement>(null), useRef<HTMLButtonElement>(null)] as const;
  const go = (download: boolean, focus = false) => {
    closeTip();
    setState({ addPage: download });
    if (focus) tabs[download ? 1 : 0].current?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (canDownload && (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End")) {
      e.preventDefault();
      go(e.key === "End" || (e.key !== "Home" && !addPage), true);
    }
  };
  const tablist = (
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
          {canDownload ? (
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
          ) : null}
        </div>
  );
  const panel = (
    <div role="tabpanel" id="mp-panel" aria-labelledby={tab === "installed" ? "mp-tab-installed" : "mp-tab-download"}>
      {tab === "installed" ? <Installed /> : <DownloadTab />}
    </div>
  );
  // Wider than a phone Models is its own pop-up (App.tsx): the tabs are its header's controls, the list scrolls below.
  if (!phone) {
    return (
      <>
        <DialogHead title="Models" onClose={leaveSettings}>{tablist}</DialogHead>
        <div className="dlg-body set">
          <div className="mp">{panel}</div>
        </div>
      </>
    );
  }
  return (
    <div className="mp">
      <div className="mp-head">
        <h1>Models</h1>
        {tablist}
      </div>
      {panel}
    </div>
  );
}

function Installed() {
  const models = useStore((s) => s.models);
  const catalog = useStore(catalogOf);
  const downloads = usePendingDownloads();
  const { rows, def } = useInstalledRows();
  const [filter, setFilter] = useState("");
  const [removing, setRemoving] = useState<{ row: InstalledRow; back: HTMLElement | null } | null>(null);
  const settingsNA = useStore(cannotSaveDefault);
  const saved = useStore(savedDefault);
  const others = useStore(othersOf);
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
  // A download starts in the same sorted slot its installed row will use.
  type ListedRow = InstalledRow | (Row & { readonly progress: PullProgress });
  const listed = sortRows<ListedRow>([...rows, ...downloads.map((progress) => ({ name: progress.name, display: nameOf(progress.name, catalog).text, chat: true, verdict: undefined, progress }))], def);
  const shown = q === "" ? listed : listed.filter((r) => r.display.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  const total = models.reduce((sum, m) => sum + m.sizeBytes, 0);
  const shownDef = settingsNA ? undefined : def;
  return (
    <>
      {rows.some((r) => r.chat) ? <DefaultCard rows={rows} def={def} disabled={settingsNA} /> : null}
      {notice}
      {filterShows(listed.length, filter) ? (
        <Field value={filter} onChange={setFilter} placeholder="Filter installed models" label="Filter installed models" cls="mp-filter" />
      ) : null}
      <div className="mp-card">
        <div className="mp-th" aria-hidden="true">
          <span className="mp-thn">Model</span>
          <span className="mp-sz">Size</span>
          <span className="mp-fitc">On this computer</span>
          <span />
        </div>
        {shown.map((r) => "progress" in r ? (
          <DownloadingRow key={r.name} p={r.progress} />
        ) : <ModelRowView key={r.name} r={r} def={shownDef} saved={saved} onRemove={(back) => setRemoving({ row: r, back })} />)}
        {shown.length === 0 ? <div className="mp-none">No installed model matches “{filter.trim()}”.</div> : null}
      </div>
      {/* what other programs hold, said once under the list and never in a row's mark (row 28) */}
      {others ? <p className="mp-others">{othersLine(others)}</p> : null}
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
          <MakerMark tag={r.name} />
          <span className="mp-nmn">{r.label.text}</span>
          {chip}
          <ModelSpeed tag={r.name} />
        </div>
        {r.label.purpose ? (
          <div className="mp-p">{r.label.purpose}</div>
        ) : r.label.id === undefined ? null : (
          <div className="mp-p">
            <PathText path={r.label.id} shown={shortTag(r.label.id)} />
          </div>
        )}
        <div className="mp-meta">
          <span>{sizeText(r.info.sizeBytes)}</span>
          <span aria-hidden="true">·</span>
          {fit}
        </div>
      </div>
      <span className="mp-sz">{sizeText(r.info.sizeBytes)}</span>
      {/* A fit check is long by nature: its words may change, its box does not (docs/design.md). */}
      <span className="mp-fitc" data-wait="">{fit}</span>
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
  const settingsNA = useStore(cannotSaveDefault);
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

const DEFAULT_TIP = "New chats start on this model. If it can't run here, they start on the first model that fits: recommended models first, then your largest. Any chat can switch from its model menu.";

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
  const saved = useStore(savedDefault);
  const models = useStore((s) => s.models);
  const locked = useStore((s) => s.unavailable["settings.update"] === true);
  // the server's pick (runtime/pick.ts) is the model new chats really start on
  const picked = pickedModel(models);
  const fallback = saved !== undefined && picked !== undefined && picked.name !== saved ? (rows.find((r) => r.name === picked.name)?.label.text ?? picked.name) : undefined;
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
  const variants = optionVariants(chat);
  const variantOf = (name: string | undefined) => {
    const v = name === undefined ? undefined : variants.get(name);
    return v === undefined ? null : <span className="mp-var">{v}</span>;
  };
  const currentWords = current === undefined ? "none" : [current.label.text, variants.get(current.name)].filter(Boolean).join(" ");
  const option = (r: InstalledRow, off: boolean) => (
    <div
      key={r.name}
      role="option"
      tabIndex={-1}
      aria-selected={r.name === def}
      aria-disabled={off}
      aria-label={[r.label.text, r.name, sizeText(r.info.sizeBytes)].join(", ")}
      data-tip={esc(r.name)}
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
        <span className="mp-nmn">{r.label.text}</span>
        {variantOf(r.name)}
      </span>
      {r.report === undefined ? <Fit report={undefined} /> : r.report.verdict !== "fits" ? <FitWords report={r.report} /> : <span />}
      <span className="mp-osz">{sizeText(r.info.sizeBytes)}</span>
    </div>
  );
  return (
    <div className="mp-defrow" ref={box} onKeyDown={(e) => open && walk(e, box.current, "[role=option]", close)}>
      <div className="mp-dl-l">
        <b><Tipped tip={DEFAULT_TIP}>Default for new chats</Tipped></b>
        {limit === undefined && !locked ? null : (
          <span>
            {limit === undefined ? null : `This model can only run at ${k(limit)}, so long chats drop their oldest messages.`}
            {locked ? `${limit === undefined ? "" : " "}Changing this default: ${COMPUTER_ONLY.toLowerCase()}` : null}
          </span>
        )}
        {fallback === undefined ? null : (
          <span className="mp-fb">
            {current?.label.text} won't run here, so new chats start on <b>{fallback}</b>.
          </span>
        )}
        <Fail err={err} />
      </div>
      <button
        ref={btn}
        type="button"
        className={`mp-select${open ? " on" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Default for new chats: ${currentWords}`}
        disabled={disabled}
        onClick={() => {
          closeTip();
          setOpen((o) => !o);
        }}
      >
        <span className="mp-sv">
          {current ? (
            <>
              <span className="mp-nmn">{current.label.text}</span>
              {variantOf(current.name)}
            </>
          ) : (
            "Choose a model"
          )}
        </span>
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
  const downloading = useStore((s) => Object.values(s.pulls).some(awaitingInstall));
  const pullNA = useStore((s) => s.unavailable["models.pull"] === true);
  const cpu = useStore((s) => noGpu(s.gpu));
  const [err, run] = useAct();
  // the suggestion's verdict is the table's row for it, never the catalog's own estimate
  const want = cpu ? "spills" : "fits";
  const pick = useStore(s => catalogOf(s)?.find((c) => c.recommended && rowOf(s, c.name)?.verdict === want));
  if (downloading) {
    return (
      <div className="mp-first">
        <h2>Your first model is downloading</h2>
        <p>It shows up here when it is ready. You can keep using Settings meanwhile.</p>
        <DownloadingRows />
      </div>
    );
  }
  return (
    <div className="mp-empty">
      <Icon id="bot" cls="mp-big" />
      <h2>No models yet</h2>
      <p>
        {pullNA ? `Downloading: ${COMPUTER_ONLY.toLowerCase()}` : "Download one to start chatting."}
        {pick && !pullNA ? (
          <>
            {" "}
            We suggest <b>{pick.label}</b>: {about(pick.downloadBytes)}, {fitLabel(want, false, cpu).toLowerCase()} on this computer.
          </>
        ) : null}
      </p>
      {pullNA ? null : (
        <div className="mp-r2">
          {pick ? (
            <button type="button" className="btn primary" onClick={() => void run(pull(pick.name))}>
              <Icon id="download" cls="s14" />
              Download {pick.label}
            </button>
          ) : null}
          <button type="button" className={pick ? "btn outline" : "btn primary"} onClick={() => setState({ addPage: true })}>
            Browse models
          </button>
        </div>
      )}
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

