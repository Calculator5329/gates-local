// Layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The sidebar (shell.md F05, F33): thread list grouped by day with search, or
// the Settings section nav, and the footer with the download and runtime rows.
import { Fragment, type KeyboardEvent, type MouseEvent, useEffect, useState } from "react";
import { rtInfo, rtOf } from "./Banner.tsx";
import { NBSP, describeModel, gb, shortAge, when } from "./format.ts";
import { Icon, type IconId } from "./icons.tsx";
import { cancelPendingSettings, leaveSettings, newThread, openSettings, openThread, preloadThread } from "./session.ts";
import { NA, type Section, type State, getState, runningThreads, setState, useStore } from "./store.ts";
import { closePop, closeTip, esc, isTouch, useMedia } from "./ui.tsx";
import { SidebarUpdate } from "./Updates.tsx";

export const SECTIONS: readonly (readonly [Section, string, IconId])[] = [
  ["general", "General", "gear"],
  ["models", "Models", "cpu"],
  ["instructions", "Instructions", "pencil"],
  ["library", "Library", "folder"],
  ["tools", "Tools", "wrench"],
  ["images", "Image generation", "image"],
  ["runtime", "Runtime", "server"],
  ["advanced", "Advanced", "sliders"],
  ["shortcuts", "Shortcuts", "keyboard"],
];

/** Re-render every interval so "5m" ages without a store change. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Put the cursor in the message box. On touch only when asked (force): focus there pops the keyboard. */
export function focusComposer(force = false): void {
  if (!force && isTouch()) return;
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#ta")?.focus());
}

export function goNew(): void {
  closeDrawer(() => {
    newThread();
    focusComposer();
  }, true);
}

// ---------------------------------------------------------------- the drawer (below 1024 px)
// Opening pushes one history entry, so the back gesture closes it. Every other close pops that
// entry first and acts once it is gone: an action that rewrites the hash (openThread) must not
// rewrite the drawer's entry, or going back would land on the old thread.

const DRAWER_ENTRY = "gl-drawer";
let afterClose: (() => void) | null = null;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

const onDrawerEntry = () => (history.state as { [DRAWER_ENTRY]?: boolean } | null)?.[DRAWER_ENTRY] === true;

export function openDrawer(): void {
  cancelPendingSettings();
  if (getState().drawer) return;
  setState({ drawer: true, pop: null, searchOpen: false, search: "" });
  if (!onDrawerEntry()) history.pushState({ [DRAWER_ENTRY]: true }, "");
  requestAnimationFrame(() => document.querySelector<HTMLElement>(".sb .sb-act, .sb button")?.focus());
}

/** After the drawer closes, focus goes to the top bar's first visible control: never a row sliding off screen. */
function focusShell(): void {
  requestAnimationFrame(() => {
    for (const el of document.querySelectorAll<HTMLElement>(".hdr .bk, #menuBtn, .set-bar .set-done")) {
      if (el.getClientRects().length > 0) return el.focus();
    }
  });
}

function drawerClosed(refocus: boolean): void {
  clearTimeout(closeTimer);
  setState({ drawer: false });
  const then = afterClose;
  afterClose = null;
  if (refocus) focusShell();
  then?.();
}

/** Close the drawer (when open), then run then(). With no drawer open, then() runs at once. */
export function closeDrawer(then?: () => void, refocus = then === undefined): void {
  if (!getState().drawer) return then?.();
  if (!onDrawerEntry()) {
    afterClose = then ?? null;
    return drawerClosed(refocus);
  }
  afterClose = () => {
    if (refocus) focusShell();
    then?.();
  };
  history.back();
  // a browser that never answers the back (none seen) still closes
  closeTimer = setTimeout(() => drawerClosed(false), 400);
}

/** The back gesture or a history.back() left the drawer's entry. */
export function onDrawerPop(): void {
  if (getState().drawer && !onDrawerEntry()) {
    if (afterClose === null) cancelPendingSettings();
    drawerClosed(afterClose === null);
  }
}

/** Ctrl K and the Search button: show the search field (leaving Settings first). */
export function openSearch(): void {
  const s = getState();
  if (s.view === "firstrun") return;
  cancelPendingSettings();
  if (s.view === "settings") leaveSettings();
  // below 1024 px the search field lives in the drawer
  if (window.innerWidth < 1024) openDrawer();
  setState({ searchOpen: true });
  requestAnimationFrame(() => document.querySelector<HTMLInputElement>("#searchIn")?.focus());
}

const closeSearch = () => setState({ searchOpen: false, search: "" });

/** The row's thread actions, anchored to its button or to a context-menu point. */
function openThreadMenu(thread: string, at: { x: number; y: number } | undefined, kb: boolean): void {
  preloadThread(null);
  closeTip();
  setState({ pop: { id: "thread", kb, thread, ...(at === undefined ? {} : { at }) } });
}

function rowMenuKey(e: KeyboardEvent<HTMLButtonElement>, thread: string): void {
  if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
  e.preventDefault();
  const r = e.currentTarget.getBoundingClientRect();
  openThreadMenu(thread, { x: r.left + 12, y: r.bottom }, true);
}

function rowMenuClick(e: MouseEvent<HTMLElement>, thread: string): void {
  e.preventDefault();
  const p = getState().pop;
  // the context-menu key also sends this event after its keydown opened the menu
  if (p?.id === "thread" && p.thread === thread && p.kb) return;
  openThreadMenu(thread, { x: e.clientX, y: e.clientY }, false);
}

function ThreadList() {
  useEffect(() => () => preloadThread(null), []);
  const threads = useStore((s) => s.threads);
  const q = useStore((s) => s.search.trim().toLowerCase());
  const on = useStore((s) => (s.view === "thread" ? s.threadId : null));
  // a send waiting for the server's answer counts: its dot shows before the start event
  const running = useStore(runningThreads);
  // the row whose thread menu is open stays marked while the menu acts on it
  const menuFor = useStore((s) => (s.pop?.id === "thread" ? s.pop.thread : null));
  const now = useNow(30_000);
  const drawerWidth = useMedia("(max-width: 1023px)");
  const shown = q === "" ? threads : threads.filter((t) => t.title.toLowerCase().includes(q));
  if (shown.length === 0) {
    return <nav className="sb-list">{threads.length > 0 ? <div className="sb-empty">No thread matches.</div> : null}</nav>;
  }
  let last = "";
  return (
    <nav className="sb-list">
      {shown.map((t) => {
        const w = when(t.updatedAt, now);
        const head = w.group !== last ? <div className="sb-group">{w.group}</div> : null;
        last = w.group;
        // a Fragment, not a wrapper: .sb-group:first-child must match only the list's first heading
        return (
          <Fragment key={t.id}>
            {head}
            <div
              className={`sb-row${on === t.id ? " on" : ""}${menuFor === t.id ? " menu-open" : ""}`}
              data-thread={t.id}
              data-tipt={t.title}
              onPointerEnter={e => {
                if (e.pointerType === "mouse" && matchMedia("(hover: hover) and (pointer: fine)").matches) preloadThread(t.id);
              }}
              onPointerLeave={() => preloadThread(null)}
              onContextMenu={(e) => rowMenuClick(e, t.id)}
            >
              <button type="button" className="sb-thread" onClick={() => closeDrawer(() => openThread(t.id), true)} onKeyDown={(e) => rowMenuKey(e, t.id)}>
                <span className="t">{t.title}</span>
                <span className="sb-status">
                  {running.has(t.id) ?<span className="live" aria-label="Reply in progress" /> : <span className="ago">{drawerWidth ? shortAge(t.updatedAt, now) : w.ago}</span>}
                </span>
              </button>
              <button
                type="button"
                className="ibtn xs sb-menu"
                aria-label={`Thread actions: ${t.title}`}
                aria-haspopup="menu"
                aria-expanded={menuFor === t.id}
                aria-controls="threadMenu"
                data-tip="Thread actions"
                onClick={(e) => menuFor === t.id ? closePop(true) : openThreadMenu(t.id, undefined, e.detail === 0)}
              >
                <Icon id="more" cls="s14" />
              </button>
            </div>
          </Fragment>
        );
      })}
    </nav>
  );
}

function ChatNav() {
  const searchOpen = useStore((s) => s.searchOpen);
  const search = useStore((s) => s.search);
  return (
    <div className="sb-body">
      <div className="sb-actions">
        <button type="button" className="sb-act" onClick={goNew}>
          <Icon id="pen" />
          <span className="grow">New thread</span>
          <span className="ks">Ctrl N</span>
        </button>
        {searchOpen ? (
          <label className="sb-search">
            <Icon id="search" />
            <input
              id="searchIn"
              placeholder="Search threads"
              autoComplete="off"
              value={search}
              onChange={(e) => setState({ search: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  closeSearch();
                }
              }}
              onBlur={(e) => {
                if (e.target.value === "") closeSearch();
              }}
            />
          </label>
        ) : (
          <button type="button" className="sb-act" onClick={openSearch}>
            <Icon id="search" />
            <span className="grow">Search</span>
            <span className="ks">Ctrl K</span>
          </button>
        )}
      </div>
      <ThreadList />
    </div>
  );
}

function SettingsNav() {
  const section = useStore((s) => s.section);
  return (
    <nav className="sb-body">
      <div className="snav">
        <button type="button" className="sb-act back" onClick={() => closeDrawer(leaveSettings, true)}>
          <Icon id="left" />
          <span className="grow">Back to chat</span>
          <span className="ks">Esc</span>
        </button>
        {SECTIONS.map(([id, label, icon]) => (
          <button key={id} type="button" className={`sb-act${section === id ? " on" : ""}${id === "runtime" ? " gap" : ""}`} onClick={() => closeDrawer(() => openSettings(id), true)}>
            <Icon id={icon} />
            <span className="grow">{label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

/** The download in progress, if any, for the footer row. */
function activePull(s: State) {
  return Object.values(s.pulls).find((p) => p.state === "downloading" || p.state === "verifying" || p.state === "queued");
}

function DownloadRow() {
  const p = useStore(activePull);
  const catalog = useStore((s) => (s.catalog === NA ? undefined : s.catalog));
  if (!p) return null;
  const pct = p.totalBytes ? Math.round((p.completedBytes / p.totalBytes) * 100) : 0;
  const name = describeModel(p.name, catalog).name;
  const tip = `<b>${esc(name)}</b> · ${p.totalBytes ? `${gb(p.completedBytes).replace(`${NBSP}GB`, "")} of ${gb(p.totalBytes)}` : "starting"}. Opens the downloads in Settings.`;
  return (
    <button type="button" className="rt" data-tip={tip} onClick={() => closeDrawer(() => openSettings("models", true), true)}>
      <Icon id="download" />
      <span className="grow">
        <b>Downloading</b> · {pct}%
      </span>
      <span className="pct" />
    </button>
  );
}

function RuntimeRow() {
  const conn = useStore((s) => s.conn);
  const runtime = useStore((s) => s.runtime);
  const settings = useStore((s) => s.settings);
  // a healthy runtime has no row; the version lives in Settings › Runtime
  if (rtOf({ conn, runtime, settings }) === "ready") return null;
  const info = rtInfo({ conn, runtime, settings });
  return (
    <button type="button" className="rt" data-tip={info.tip} onClick={() => closeDrawer(() => openSettings("runtime"), true)}>
      <span className={`dot ${info.dot}`} />
      <span className="grow">{info.text}</span>
      <span className="pct" />
    </button>
  );
}

export function Sidebar() {
  const inSettings = useStore((s) => s.view === "settings");
  return (
    <aside className="sb">
      <div className={`sb-head${inSettings ? " set-brand" : ""}`}>
        <svg className="mark" aria-hidden="true">
          <use href="#i-mark" />
        </svg>
        <span className="wordmark">Gates Local</span>
        <button type="button" className="ibtn sb-x" aria-label="Close threads" onClick={() => { cancelPendingSettings(); closeDrawer(); }}>
          <Icon id="x" />
        </button>
      </div>
      {inSettings ? <SettingsNav /> : <ChatNav />}
      <div className="sb-foot">
        {inSettings ? null : <SidebarUpdate />}
        <DownloadRow />
        <RuntimeRow />
        {inSettings ? null : (
          <button
            type="button"
            className="sb-set"
            onClick={() =>
              closeDrawer(() => {
                // a phone opens Settings on its section list
                setState({ setList: true });
                openSettings();
              }, true)
            }
          >
            <Icon id="gear" />
            Settings
            <span className="ks" aria-label="Ctrl comma">
              Ctrl<b>,</b>
            </span>
          </button>
        )}
      </div>
    </aside>
  );
}
