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
import { noGpu } from "./format.ts";
import { Icon } from "./icons.tsx";
import { type TableFit, rowOf } from "./fit-table.ts";
import { DownloadTab, DownloadingRow, DownloadingRows, othersLine, othersOf, usePendingDownloads } from "./ModelDownloads.tsx";
import { cardDefault, makeDefault, removeModelAndMoveDefault, savedDefault } from "./models-actions.ts";
import {
  type ModelName,
  type Row,
  about,
  canBeDefault,
  filterShows,
  noteSettled,
  fitLabel,
  nameOf,
  nextDefault,
  shortTag,
  sizeText,
  sortRows,
  splitTail,
} from "./models-rules.ts";
import { awaitingInstall, canChat, notForChat, pickedModel } from "./pick.ts";
import { MakerMark } from "./MakerMark.tsx";
import { MemoryMark } from "./MemoryMark.tsx";
import { ModelSpeed } from "./model-speed.tsx";
import { MeasureCells, MeasureFail, MeasureMeta, canMeasure, useMeasureItem } from "./ModelMeasure.tsx";
import { measureOf } from "./session/measures.ts";
import { DialogHead } from "./Panel.tsx";
import { leaveSettings, pull } from "./session.ts";
import { COMPUTER_ONLY, Fail, useAct, useOutside, walk } from "./settings-ui.tsx";
import { NA, type State, setState, useStore } from "./store.ts";
import { FitSkel, PHONE, closeTip, useMedia } from "./ui.tsx";

const catalogOf = (s: State) => (s.catalog === NA ? undefined : s.catalog);
const cannotSaveDefault = (s: State) => s.settings === NA || s.unavailable["settings.update"] === true;

/** The failure of the last action a control ran; cleared when the next try starts. */
// ---------------------------------------------------------------- names and fit

/** The memory mark against the card (row 28); the verdict's words are its name and its tip, the number says the rest. */
function Fit({ report }: { report: TableFit | undefined }) {
  const cpu = useStore((s) => noGpu(s.gpu));
  const tabled = useStore((s) => s.fitTable !== undefined);
  if (report === undefined) return tabled ? <span className="mp-fit none">–</span> : <span className="mp-fit none" aria-busy="true"><FitSkel w="120px" /></span>;
  const words = fitLabel(report.verdict, report.source === "measured", cpu);
  return (
    <span className="mp-fit">
      <MemoryMark report={report} words={words} />
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
        <div className="mp-tabs" role="tablist" aria-label="Models" data-testid="models.tabs.list" onKeyDown={onKey}>
          <button
            ref={tabs[0]}
            type="button"
            role="tab"
            id="mp-tab-installed"
            data-testid="models.tabs.installed"
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
              data-testid="models.tabs.download"
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
  const measureShown = useStore(canMeasure);
  return (
    <>
      <Fallback rows={rows} />
      {notice}
      {filterShows(listed.length, filter) ? (
        <Field value={filter} onChange={setFilter} placeholder="Filter installed models" label="Filter installed models" cls="mp-filter" />
      ) : null}
      <div className={measureShown ? "mp-card ms" : "mp-card"}>
        <div className="mp-th" aria-hidden="true">
          <span className="mp-thn">Model</span>
          <span className="mp-sz">Size</span>
          <span className="mp-fitc">On this computer</span>
          {measureShown ? (
            <>
              <span className="mp-spd">Speed</span>
              <span className="mp-score">Score</span>
            </>
          ) : null}
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
  const measured = useStore((s) => measureOf(s, r.name) !== undefined);
  const measureShown = useStore(canMeasure);
  const why = r.chat ? undefined : notForChat(r.info);
  const fit = why ? (
    <span className="mp-fit none">{why.label}</span>
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
          {/* the measured speed says it once, in its own column (row 29) */}
          {measured ? null : <ModelSpeed tag={r.name} />}
        </div>
        {/* a model with no purpose has no second line: its Ollama name is in the row menu (Copy Ollama name) */}
        {r.label.purpose ? <div className="mp-p">{r.label.purpose}</div> : null}
        <div className="mp-meta">
          <span>{sizeText(r.info.sizeBytes)}</span>
          <span aria-hidden="true">·</span>
          {fit}
        </div>
        <MeasureMeta name={r.name} />
        <MeasureFail name={r.name} />
      </div>
      <span className="mp-sz">{sizeText(r.info.sizeBytes)}</span>
      {/* A fit check is long by nature: its words may change, its box does not (docs/design.md). */}
      <span className="mp-fitc" data-wait="">{fit}</span>
      {measureShown ? r.chat ? <MeasureCells name={r.name} label={r.label.text} /> : <span className="mp-meas" /> : null}
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
  const measureItem = useMeasureItem(r.name);
  const canMeasureHere = useStore(canMeasure) && r.chat;
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
    <div className="mp-acts" ref={box} data-testid="models.row-menu.actions" onKeyDown={(e) => open && walk(e, box.current, "[role=menuitem]", close)}>
      <button
        ref={btn}
        type="button"
        className={`mp-kebab${open ? " on" : ""}`}
        data-testid="models.row-menu.open"
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
              data-testid="models.row-menu.make-default"
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
            data-testid="models.row-menu.copy-name"
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
                data-testid="models.row-menu.remove"
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
          {measureItem && canMeasureHere ? (
            <button
              type="button"
              role="menuitem"
              className="mp-mi"
              data-testid="models.row-menu.measure"
              onClick={() => {
                close();
                measureItem.act();
              }}
            >
              <Icon id="speed" />
              {measureItem.text}
            </button>
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
    <div className="mp-scrim" data-testid="models.remove.scrim" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="mp-dlg" role="dialog" aria-modal="true" aria-labelledby="mp-dlg-t" data-testid="models.remove.dialog" ref={box} tabIndex={-1} onKeyDown={onKey}>
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
          <button ref={cancel} type="button" className="btn outline" data-testid="models.remove.cancel" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn mp-danger"
            data-testid="models.remove.confirm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              box.current?.focus();
              const done = removeModelAndMoveDefault(row.name, next);
              void run(done.then((d) => d.removeErr)).then(async (removed) => {
                setBusy(false);
                if (!removed) return;
                const { defaultErr } = await done;
                if (defaultErr !== null) onDefaultFailed(`${name} was removed. ${defaultErr}${nextName ? " Set one from a row's menu." : ""}`);
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

// ---------------------------------------------------------------- default fallback

/**
 * The chip marks the saved default and a row's menu sets it (decision 10). When the saved default
 * cannot run here, new chats start on another model; without this line the chip would be untrue.
 */
function Fallback({ rows }: { rows: readonly InstalledRow[] }) {
  const saved = useStore(savedDefault);
  const models = useStore((s) => s.models);
  // the server's pick (runtime/pick.ts) is the model new chats really start on
  const picked = pickedModel(models);
  if (saved === undefined || picked === undefined || picked.name === saved) return null;
  const name = (tag: string) => rows.find((r) => r.name === tag)?.label.text ?? tag;
  return (
    <p className="mp-note mp-fb" data-testid="models.default.fallback">
      {name(saved)} won't run here, so new chats start on <b>{name(picked.name)}</b>.
    </p>
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
            <button type="button" className="btn primary" data-testid="models.empty.download-suggested" onClick={() => void run(pull(pick.name))}>
              <Icon id="download" cls="s14" />
              Download {pick.label}
            </button>
          ) : null}
          <button type="button" className={pick ? "btn outline" : "btn primary"} data-testid="models.empty.browse" onClick={() => setState({ addPage: true })}>
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
        data-testid="models.installed.filter"
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
          data-testid="models.installed.clear-filter"
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

