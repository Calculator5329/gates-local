// Pictures (direction D, the contact sheet): every finished picture, newest first, in day
// groups of justified rows at true shape; an inspector beside them that is always open.
// One picture: its prompt, facts and Again, Edit prompt, Copy, Save. Several: how many.
// Enter shows the picked one large; Esc goes back. On a phone: two to a row and the
// inspector as a sheet on the bottom edge. It lies over the chat as Settings does.
import "./pictures.css";
import type { ImageChoice, Picture } from "@gates-local/contracts";
import { type MouseEvent, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { replaceDraft } from "./drafts.ts";
import { clock } from "./format.ts";
import { Icon, type IconId } from "./icons.tsx";
import { chosenImage, presetName, sizeLabel } from "./image-choice.ts";
import { type Row, type Sheet, dayLabel, layoutSheet, rowsIn, yOf } from "./pictures-layout.ts";
import { openThread, pictures, send } from "./session.ts";
import type { PicturesView } from "./session/pictures.ts";
import { fileUrl } from "./session/platform.ts";
import { focusComposer, openDrawer } from "./Sidebar.tsx";
import { getState, setState, useStore } from "./store.ts";
import { PHONE, useMedia } from "./ui.tsx";

const GAP = 6;
const ROW_H = 180;
const DAY_H = 44;
const PHONE_DAY_H = 40;
/** Rows drawn past each edge of the window, so a fast scroll does not show blank space. */
const OVERDRAW = 800;
/** The next page is asked for this far before the end. */
const MORE_AT = 1600;

function usePictures<T>(read: (v: PicturesView) => T): T {
  return useSyncExternalStore(pictures.subscribe, () => read(pictures.get()));
}

function useFiles(): (path: string) => string {
  const origin = useStore((s) => s.serverOrigin);
  const token = useStore((s) => s.fileToken);
  return (path) => fileUrl(origin ?? "", token, path);
}

const thumbPath = (p: Picture) => `thumbs/${p.jobId}.webp`;

/** The time it was made: the clock today, else its day too. */
function made(ms: number): string {
  const day = dayLabel(ms);
  return day === "Today" ? clock(ms) : `${day} · ${clock(ms)}`;
}

/** "19 s"; one decimal under ten seconds. */
function took(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}

/** The setup Again runs: the picture's own, else (a card from before setups) what an image send runs now in its thread. */
function againChoice(p: Picture): ImageChoice | undefined {
  if (p.preset !== undefined) return { preset: p.preset, width: p.width, height: p.height };
  const now = chosenImage(getState());
  return now === undefined ? undefined : { preset: now.preset.id, width: now.width, height: now.height };
}

/** Again: the same prompt and setup in its thread, a new seed; queued there like any image send. */
function again(p: Picture): void {
  openThread(p.threadId);
  const draw = againChoice(p);
  void send(p.prompt, { reuseThread: true, keepDraft: true, ...(draw === undefined ? {} : { draw }) });
}

/** Edit prompt: its thread, with the prompt in the message box and Image on. */
function editPrompt(p: Picture): void {
  openThread(p.threadId);
  replaceDraft(p.threadId, { text: p.prompt });
  setState({ image: true });
  focusComposer(true);
}

async function pictureBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(String(res.status));
  return res.blob();
}

async function copyPicture(url: string): Promise<void> {
  const blob = await pictureBlob(url);
  await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
}

/** A file name from the prompt's first words and the seed. */
function fileName(p: Picture): string {
  const words = p.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return `${words || "picture"}-${p.seed ?? p.jobId.slice(0, 8)}.png`;
}

async function savePicture(url: string, name: string): Promise<void> {
  const blob = await pictureBlob(url);
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** An icon button that does a thing once: a check when it worked, the alert when it did not, then its icon again. Same size throughout. */
function DoButton({ icon, label, act }: { icon: IconId; label: string; act: () => Promise<void> }) {
  const [state, show] = useState<"idle" | "ok" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => show("idle"), 1500);
    return () => clearTimeout(t);
  }, [state]);
  const tip = state === "failed" ? `Couldn't ${label.toLowerCase()}` : label;
  return (
    <button type="button" className={`ibtn${state === "failed" ? " red" : ""}`} data-testid={`pictures.actions.${icon}`} aria-label={tip} data-tip={tip} onClick={() => void act().then(() => show("ok"), () => show("failed"))}>
      <Icon id={state === "ok" ? "check" : state === "failed" ? "alert" : icon} />
    </button>
  );
}

function Actions({ p, phone }: { p: Picture; phone: boolean }) {
  const file = useFiles();
  const full = file(p.imagePath);
  return (
    <div className="pics-acts">
      <button type="button" className="btn outline" data-testid="pictures.actions.again" onClick={() => again(p)}>
        <Icon id="redo" />
        Again
      </button>
      <button type="button" className="ibtn" data-testid="pictures.actions.edit-prompt" aria-label="Edit prompt" data-tip="Edit prompt" onClick={() => editPrompt(p)}>
        <Icon id="pencil" />
      </button>
      <DoButton icon="copy" label="Copy" act={() => copyPicture(full)} />
      <DoButton icon="download" label="Save" act={() => savePicture(full, fileName(p))} />
      {/* the phone's sheet has no facts list, so its thread is a button here */}
      {phone ? (
        <button type="button" className="ibtn" data-testid="pictures.actions.open-thread" aria-label="Open thread" data-tip="Open thread" onClick={() => openThread(p.threadId)}>
          <Icon id="chat" />
        </button>
      ) : null}
    </div>
  );
}

function Facts({ p }: { p: Picture }) {
  const style = useStore((s) => (p.preset === undefined ? undefined : presetName(s, p.preset)));
  return (
    <dl className="pics-facts">
      {style === undefined ? null : <><dt>Style</dt><dd>{style}</dd></>}
      <dt>Size</dt><dd className="mono">{p.width} × {p.height}</dd>
      {p.seed === undefined ? null : <><dt>Seed</dt><dd className="mono">{p.seed}</dd></>}
      {p.steps === undefined ? null : <><dt>Steps</dt><dd className="mono">{p.steps}</dd></>}
      {p.runMs === undefined ? null : <><dt>Took</dt><dd className="mono">{took(p.runMs)}</dd></>}
      <dt>Made</dt><dd className="mono">{made(p.doneAt)}</dd>
      <dt>Thread</dt>
      <dd>
        <button type="button" className="pics-lnk" data-testid="pictures.detail.thread-link" onClick={() => openThread(p.threadId)}>{p.threadTitle}</button>
      </dd>
    </dl>
  );
}

function One({ p }: { p: Picture }) {
  const file = useFiles();
  return (
    <>
      <button type="button" className="pics-big" data-testid="pictures.detail.show-large" aria-label="Show large" data-tip="Show large" onClick={() => pictures.setLarge(true)} style={{ aspectRatio: `${p.width} / ${p.height}` }}>
        <img src={file(thumbPath(p))} alt="" draggable={false} />
      </button>
      <p className="pics-prompt">{p.prompt}</p>
      <Facts p={p} />
      <Actions p={p} phone={false} />
    </>
  );
}

/** A phone's sheet: the picture small, its prompt, one line of facts, the actions. */
function PhoneOne({ p }: { p: Picture }) {
  const file = useFiles();
  const style = useStore((s) => (p.preset === undefined ? undefined : presetName(s, p.preset)));
  const line = [style, sizeLabel(p.width, p.height), made(p.doneAt)].filter((x) => x !== undefined).join(" · ");
  return (
    <>
      <div className="pics-row">
        <button type="button" className="pics-th" data-testid="pictures.thumb.show-large" aria-label="Show large" onClick={() => pictures.setLarge(true)}>
          <img src={file(thumbPath(p))} alt="" draggable={false} />
        </button>
        <div className="pics-what">
          <p className="pics-prompt">{p.prompt}</p>
          <div className="pics-line">{line}</div>
        </div>
      </div>
      <Actions p={p} phone />
    </>
  );
}

function Several({ picked }: { picked: readonly Picture[] }) {
  const file = useFiles();
  const first = picked[0]!;
  const same = picked.every((p) => p.prompt === first.prompt);
  return (
    <>
      <div className="pics-n">
        <span>{picked.length} selected</span>
        <button type="button" className="pics-lnk dim" data-testid="pictures.selection.clear" onClick={() => pictures.select([picked.at(-1)!.jobId])}>Clear</button>
      </div>
      <div className="pics-ths">
        {picked.slice(0, 12).map((p) => (
          <img key={p.jobId} src={file(thumbPath(p))} alt="" style={{ aspectRatio: `${p.width} / ${p.height}` }} draggable={false} />
        ))}
      </div>
      {same ? <p className="pics-prompt">{first.prompt}</p> : null}
    </>
  );
}

function Inspector({ picked, phone }: { picked: readonly Picture[]; phone: boolean }) {
  const one = picked.length === 1 ? picked[0]! : undefined;
  return (
    <aside className="pics-insp" aria-label="Picked">
      {picked.length === 0 ? null : one === undefined ? <Several picked={picked} /> : phone ? <PhoneOne p={one} /> : <One p={one} />}
    </aside>
  );
}

/** Enter's view: the picked picture as large as the sheet's room allows, the original file. */
function Large({ p, list }: { p: Picture; list: readonly Picture[] }) {
  const file = useFiles();
  const at = list.findIndex((x) => x.jobId === p.jobId);
  return (
    <div className="pics-large" role="dialog" aria-label="Picture" data-testid="pictures.large.dialog" onClick={(e) => { if (e.target === e.currentTarget) pictures.setLarge(false); }}>
      <img src={file(p.imagePath)} alt={p.prompt} style={{ aspectRatio: `${p.width} / ${p.height}` }} draggable={false} />
      <button type="button" className="ibtn pics-x" data-testid="pictures.large.close" aria-label="Close" data-tip="Close" onClick={() => pictures.setLarge(false)}>
        <Icon id="x" cls="s18" />
      </button>
      {at > 0 ? (
        <button type="button" className="ibtn pics-step l" data-testid="pictures.large.newer" aria-label="Newer" data-tip="Newer" onClick={() => step(list, -1)}>
          <Icon id="left" cls="s18" />
        </button>
      ) : null}
      {at >= 0 && at < list.length - 1 ? (
        <button type="button" className="ibtn pics-step r" data-testid="pictures.large.older" aria-label="Older" data-tip="Older" onClick={() => step(list, 1)}>
          <Icon id="right" cls="s18" />
        </button>
      ) : null}
    </div>
  );
}

/** The arrow keys: the next or previous picture becomes the one selected. */
function step(list: readonly Picture[], by: 1 | -1): string | undefined {
  const sel = pictures.get().sel;
  const at = list.findIndex((p) => p.jobId === sel.at(-1));
  const next = list[at < 0 ? 0 : Math.min(list.length - 1, Math.max(0, at + by))];
  if (next === undefined) return undefined;
  pictures.select([next.jobId]);
  return next.jobId;
}

/** A click picks one; Ctrl or Cmd adds or takes away; Shift picks the run from the last plain pick. */
function pick(list: readonly Picture[], id: string, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, anchor: { current: string | null }, phone: boolean): void {
  const sel = pictures.get().sel;
  if (phone || !(e.ctrlKey || e.metaKey || e.shiftKey)) {
    anchor.current = id;
    pictures.select([id]);
  } else if (e.shiftKey) {
    const from = list.findIndex((p) => p.jobId === (anchor.current ?? sel.at(-1)));
    const to = list.findIndex((p) => p.jobId === id);
    if (from < 0 || to < 0) return pictures.select([id]);
    const [a, b] = from < to ? [from, to] : [to, from];
    pictures.select(list.slice(a, b + 1).map((p) => p.jobId));
  } else if (sel.includes(id)) {
    // the last one stays: the inspector always shows a pick
    if (sel.length > 1) pictures.select(sel.filter((x) => x !== id));
  } else {
    anchor.current = id;
    pictures.select([...sel, id]);
  }
}

function TileRow({ row, list, sel, multi, onPick }: { row: Extract<Row, { kind: "tiles" }>; list: readonly Picture[]; sel: ReadonlySet<string>; multi: boolean; onPick: (id: string, e: MouseEvent) => void }) {
  const file = useFiles();
  return (
    <>
      {row.tiles.map((t) => {
        const p = list[t.index]!;
        const on = sel.has(p.jobId);
        return (
          <button
            key={p.jobId}
            type="button"
            className="pics-tile"
            data-testid="pictures.grid.tile"
            data-job={p.jobId}
            aria-pressed={on}
            aria-label={p.prompt}
            style={{ top: row.y, left: t.x, width: t.w, height: row.h }}
            onClick={(e) => onPick(p.jobId, e)}
            onDoubleClick={() => { pictures.select([p.jobId]); pictures.setLarge(true); }}
          >
            <img src={file(thumbPath(p))} alt="" loading="lazy" decoding="async" draggable={false} />
            {on && multi ? <span className="pics-ck"><Icon id="check" /></span> : null}
          </button>
        );
      })}
    </>
  );
}

function SheetView({ list, sel, phone, q, next }: { list: readonly Picture[]; sel: readonly string[]; phone: boolean; q: string; next: string | undefined }) {
  const scroller = useRef<HTMLDivElement>(null);
  const rowsBox = useRef<HTMLDivElement>(null);
  const anchor = useRef<string | null>(null);
  const [width, setWidth] = useState(0);
  const [win, setWin] = useState({ top: 0, h: 0 });
  useLayoutEffect(() => {
    const el = scroller.current;
    const box = rowsBox.current;
    if (el === null || box === null) return;
    const measure = () => {
      setWidth(box.clientWidth);
      setWin({ top: el.scrollTop, h: el.clientHeight });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const sheet: Sheet = useMemo(
    () => layoutSheet(list, { width, target: phone ? Math.max(90, Math.floor(width / 3)) : ROW_H, gap: GAP, dayH: phone ? PHONE_DAY_H : DAY_H }),
    [list, width, phone],
  );

  // A picture joining the top keeps the rows on screen where they were (no reflow above the window).
  const prev = useRef<{ list: readonly Picture[]; sheet: Sheet; q: string } | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const before = prev.current;
    prev.current = { list, sheet, q };
    if (el === null || before === null) return;
    if (before.q !== q) {
      el.scrollTop = 0;
      return;
    }
    if (before.list === list || before.list[0]?.jobId === list[0]?.jobId || el.scrollTop === 0) return;
    const top = el.scrollTop;
    const row = before.sheet.rows.find((r) => r.kind === "tiles" && r.y >= top);
    if (row === undefined || row.kind !== "tiles") return;
    const id = before.list[row.tiles[0]!.index]?.jobId;
    const y = yOf(sheet, list.findIndex((p) => p.jobId === id));
    if (y !== undefined) el.scrollTop = top + (y - row.y);
  }, [list, sheet, q]);

  // the next page, once the window nears the end (or the first page does not fill it)
  useEffect(() => {
    if (next !== undefined && win.h > 0 && win.top + win.h > sheet.height - MORE_AT) void pictures.more();
  }, [next, win, sheet.height]);

  // the arrow keys keep the picked picture in view
  const last = sel.at(-1);
  useEffect(() => {
    const el = scroller.current;
    if (el === null || last === undefined) return;
    const at = list.findIndex((p) => p.jobId === last);
    const row = sheet.rows.find((r) => r.kind === "tiles" && r.tiles.some((t) => t.index === at));
    if (row === undefined) return;
    if (row.y < el.scrollTop) el.scrollTop = Math.max(0, row.y - DAY_H);
    else if (row.y + row.h > el.scrollTop + el.clientHeight) el.scrollTop = row.y + row.h - el.clientHeight + GAP;
  }, [last, list, sheet]);

  const selected = useMemo(() => new Set(sel), [sel]);
  const shown = rowsIn(sheet, win.top - OVERDRAW, win.top + win.h + OVERDRAW);
  const onPick = (id: string, e: MouseEvent) => pick(list, id, e, anchor, phone);
  return (
    <div className="pics-sheet" ref={scroller} onScroll={(e) => setWin({ top: e.currentTarget.scrollTop, h: e.currentTarget.clientHeight })}>
      <div className="pics-rows" ref={rowsBox} style={{ height: sheet.height }}>
        {shown.map((r) =>
          r.kind === "day" ? (
            <div key={`d${r.y}`} className="pics-day" style={{ top: r.y, height: r.h }}>{r.label}</div>
          ) : (
            <TileRow key={`r${r.y}`} row={r} list={list} sel={selected} multi={sel.length > 1} onPick={onPick} />
          ),
        )}
      </div>
    </div>
  );
}

function Bar({ phone }: { phone: boolean }) {
  const q = usePictures((v) => v.q);
  const count = usePictures((v) => v.count);
  const ready = usePictures((v) => v.status === "ready");
  const [searching, setSearching] = useState(false);
  const field = (
    <label className="sb-search pics-search">
      <Icon id="search" />
      <input placeholder="Search prompts" aria-label="Search prompts" data-testid="pictures.search.input" value={q} autoFocus={phone} onChange={(e) => pictures.search(e.target.value)} />
    </label>
  );
  return (
    <header className="hdr pics-bar">
      <button type="button" className="ibtn hb" id="menuBtn" data-testid="pictures.head.open-threads" aria-label="Open threads" onClick={openDrawer}>
        <Icon id="menu" cls="s18" />
      </button>
      {phone && searching ? field : (
        <h2>
          Pictures
          {ready ? <span className="pics-count">{count}</span> : null}
        </h2>
      )}
      {phone ? (
        <button
          type="button"
          className="ibtn hb"
          data-testid="pictures.search.toggle"
          aria-label={searching ? "Stop searching" : "Search prompts"}
          onClick={() => {
            if (searching) pictures.search("");
            setSearching(!searching);
          }}
        >
          <Icon id={searching ? "x" : "search"} cls="s18" />
        </button>
      ) : field}
    </header>
  );
}

function Empty({ status, q }: { status: PicturesView["status"]; q: string }) {
  if (status === "loading") return <div className="pics-sheet" />;
  return (
    <div className="pics-sheet pics-empty">
      {status === "error" ? (
        <p>
          Pictures couldn't load.{" "}
          <button type="button" className="pics-lnk" data-testid="pictures.error.try-again" onClick={() => void pictures.enter()}>Try again</button>
        </p>
      ) : q.trim() !== "" ? (
        <p>No picture's prompt has those words.</p>
      ) : (
        <p>No pictures yet. Turn on Image in a chat and send what you want to see.</p>
      )}
    </div>
  );
}

export function Pictures() {
  const phone = useMedia(PHONE);
  const list = usePictures((v) => v.pictures);
  const sel = usePictures((v) => v.sel);
  const large = usePictures((v) => v.large);
  const status = usePictures((v) => v.status);
  const q = usePictures((v) => v.q);
  const next = usePictures((v) => v.next);
  const byId = useMemo(() => new Map(list.map((p) => [p.jobId, p])), [list]);
  const picked = useMemo(() => sel.map((id) => byId.get(id)).filter((p) => p !== undefined), [sel, byId]);
  const one = picked.length === 1 ? picked[0] : undefined;

  useEffect(() => {
    pictures.shown(true);
    return () => pictures.shown(false);
  }, []);

  // Enter shows the picked picture large; the arrows move the pick (and the large view with it)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (e.ctrlKey || e.metaKey || e.altKey || t?.closest("input,textarea,[contenteditable]")) return;
      if (getState().pop !== null || getState().panel !== null || getState().drawer) return;
      const onButton = t?.closest("button") ?? null;
      if (e.key === "Enter" && (onButton === null || onButton.classList.contains("pics-tile"))) {
        e.preventDefault();
        pictures.setLarge(true);
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const id = step(pictures.get().pictures, e.key === "ArrowRight" ? 1 : -1);
        if (id !== undefined && !pictures.get().large) requestAnimationFrame(() => document.querySelector<HTMLElement>(`.pics-tile[data-job="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }));
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  return (
    <div className="pics">
      <Bar phone={phone} />
      <div className="pics-body">
        <div className="pics-main">
          {list.length === 0 ? <Empty status={status} q={q} /> : <SheetView list={list} sel={sel} phone={phone} q={q} next={next} />}
          {large && one !== undefined ? <Large p={one} list={list} /> : null}
        </div>
        {list.length === 0 && phone ? null : <Inspector picked={picked} phone={phone} />}
      </div>
    </div>
  );
}
