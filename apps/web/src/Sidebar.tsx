// Layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The sidebar (shell.md F05, F33): thread list grouped by day with search, or
// the Settings section nav, and the footer's row of icons (Settings, Models, Usage, the update icon).
import type { PullProgress } from "@gates-local/contracts";
import { Fragment, type KeyboardEvent, type MouseEvent, type ReactNode, isValidElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import { booting, rtInfo, rtOf, unread } from "./Banner.tsx";
import { finishedInBurst, modelsIcon, settingsIcon } from "./footer-state.ts";
import { describeModel, shortAge, when } from "./format.ts";
import { Icon, type IconId } from "./icons.tsx";
import { cancelPendingSettings, closeSettings, closeUsage, leaveSettings, newThread, openSettings, openThread, preloadThread, spareScreenEntry, toggleModels, toggleUsage } from "./session.ts";
import { NA, type Section, getState, runningThreads, setState, useStore } from "./store.ts";
import { PHONE, closePop, closeTip, isTouch, useMedia } from "./ui.tsx";
import { FootButton, SidebarUpdate } from "./Updates.tsx";

export const SECTIONS: readonly (readonly [Section, string, IconId])[] = [
  ["general", "General", "gear"],
  ["models", "Models", "bot"],
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
  setState({ drawer: true, pop: null, search: "" });
  // a screen just closed for this (search) leaves its entry: the drawer takes it over rather than stacking on it
  if (spareScreenEntry()) history.replaceState({ [DRAWER_ENTRY]: true }, "");
  else if (!onDrawerEntry()) history.pushState({ [DRAWER_ENTRY]: true }, "");
  // the first thing in the drawer, as the row's Search button was: the Search field, or in Settings Back to chat.
  // On touch focus takes New thread beside the field instead, so the keyboard stays down, as in the phone picker.
  requestAnimationFrame(() => document.querySelector<HTMLElement>(isTouch() ? ".sb .sb-tools button, .sb .snav .sb-act" : ".sb #searchIn, .sb .snav .sb-act")?.focus());
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

/** Ctrl K: focus the search field (leaving Settings first). */
export function openSearch(): void {
  const s = getState();
  if (s.view === "firstrun") return;
  cancelPendingSettings();
  // below 1024 px the search field lives in the drawer, which takes over the screen's history entry
  const narrow = window.innerWidth < 1024;
  if (s.panel !== null) closeUsage(false, narrow);
  else if (s.view === "settings" && narrow) closeSettings();
  else if (s.view === "settings") leaveSettings();
  if (narrow) openDrawer();
  requestAnimationFrame(() => document.querySelector<HTMLInputElement>("#searchIn")?.focus());
}

const clearSearch = () => setState({ search: "" });

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

/** The title with each match of q (already lower case) in a <mark>: a plain string split rendered as
 *  text nodes, never HTML. A title whose lower case changes its length keeps no marks. */
function marked(title: string, q: string): ReactNode {
  const lower = title.toLowerCase();
  if (q === "" || lower.length !== title.length) return title;
  const parts: ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, at)) {
    if (i > at) parts.push(title.slice(at, i));
    parts.push(<mark key={i}>{title.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  if (at < title.length) parts.push(title.slice(at));
  return parts;
}

/** Widths of the placeholder rows: varied like titles, never a full-width block. */
const SKEL_ROWS = ["72%", "56%", "80%", "64%", "48%", "70%"] as const;

/** How far the list runs past each edge, for its fade (styles.css .sb-list): px above the view and below it. */
function measureFade(el: HTMLElement): void {
  const end = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
  el.style.setProperty("--fade-top", `${Math.max(0, el.scrollTop)}px`);
  el.style.setProperty("--fade-end", `${end}px`);
}

/** Keeps the thread list's edge fades true while it scrolls or resizes; a ref callback, so it follows the node. */
function fadeEdges(el: HTMLElement | null): (() => void) | undefined {
  if (!el) return undefined;
  const update = () => measureFade(el);
  update();
  el.addEventListener("scroll", update, { passive: true });
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
  ro?.observe(el);
  return () => {
    el.removeEventListener("scroll", update);
    ro?.disconnect();
  };
}

function ThreadList() {
  const list = useRef<HTMLElement | null>(null);
  // threads arriving, leaving or filtered change how far the list runs without a scroll or a resize
  useLayoutEffect(() => {
    if (list.current) measureFade(list.current);
  });
  // one callback for the list's life: a new one each render would re-attach the listeners every render
  const ref = useRef((el: HTMLElement | null) => {
    list.current = el;
    return fadeEdges(el);
  }).current;
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
  const boot = useStore(booting);
  const shown = q === "" ? threads : threads.filter((t) => t.title.toLowerCase().includes(q));
  if (boot && threads.length === 0) {
    // the list's shape is the data's: row-shaped placeholders until the first read lands
    return (
      <nav className="sb-list" aria-busy="true" ref={ref}>
        <div className="sb-skel" data-skel="" aria-hidden="true">
          {SKEL_ROWS.map((w, i) => (
            <div key={i} className="sb-skel-r"><span className="skel" style={{ width: w }} /></div>
          ))}
        </div>
      </nav>
    );
  }
  if (shown.length === 0) {
    return <nav className="sb-list" ref={ref}>{threads.length > 0 ? <div className="sb-empty">No thread matches.</div> : null}</nav>;
  }
  let last = "";
  return (
    <nav className="sb-list" ref={ref}>
      {/* while searching, one heading counts the matches in place of the date groups */}
      {q === "" ? null : <div className="sb-group">{shown.length} {shown.length === 1 ? "thread" : "threads"}</div>}
      {shown.map((t) => {
        const w = when(t.updatedAt, now);
        const head = q === "" && w.group !== last ? <div className="sb-group">{w.group}</div> : null;
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
              <button type="button" className="sb-thread" onClick={() => closeDrawer(() => openThread(t.id), true)} onKeyDown={(e) => rowMenuKey(e, t.id)}
                // a keyboard pause on a row reads it ahead, as a mouse pause does
                onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) preloadThread(t.id); }}
                onBlur={() => preloadThread(null)}>
                <span className="t">{q === "" ? t.title : marked(t.title, q)}</span>
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
  const search = useStore((s) => s.search);
  return (
    <div className="sb-body">
      {/* one row: an always-there Search field at the left (nothing swaps, so nothing jumps); icon buttons sit at the right end */}
      <div className="sb-top">
        <label className="sb-search">
          <Icon id="search" />
          <input
            id="searchIn"
            type="text"
            placeholder="Search"
            aria-label="Search threads"
            autoComplete="off"
            spellCheck={false}
            value={search}
            onChange={(e) => setState({ search: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // an empty field has nothing to clear: the same Escape goes on and closes the drawer
                if (search !== "") e.stopPropagation();
                clearSearch();
                e.currentTarget.blur();
              }
            }}
          />
          {search === "" ? (
            <span className="sb-kbd" aria-hidden="true">Ctrl K</span>
          ) : (
            <button
              type="button"
              className="sb-clear"
              aria-label="Clear search"
              data-tip="Clear · Esc"
              // the field keeps its focus through the press
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => {
                clearSearch();
                document.querySelector<HTMLInputElement>("#searchIn")?.focus();
              }}
            >
              <Icon id="x" cls="s14" />
            </button>
          )}
        </label>
        <div className="sb-tools">
          <button type="button" className="ibtn" aria-label="New thread" data-tip="New thread · Ctrl N" onClick={goNew}>
            <Icon id="pen" />
          </button>
        </div>
      </div>
      <ThreadList />
    </div>
  );
}

/** Settings' sections. Wider than a phone Models is a pop-up of its own (the footer's bot), so it is not among them there. */
function SettingsNav({ phone }: { phone: boolean }) {
  const section = useStore((s) => s.section);
  return (
    <nav className="sb-body">
      <div className="snav">
        <button type="button" className="sb-act back" data-tip="Back to chat · Esc" onClick={() => closeDrawer(leaveSettings, true)}>
          <Icon id="left" />
          <span className="grow">Back to chat</span>
        </button>
        {SECTIONS.filter(([id]) => phone || id !== "models").map(([id, label, icon]) => (
          <button key={id} type="button" className={`sb-act${section === id ? " on" : ""}${id === "runtime" ? " gap" : ""}`} onClick={() => closeDrawer(() => openSettings(id), true)}>
            <Icon id={icon} />
            <span className="grow">{label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------- the footer
// One row of 32 px icon buttons, the same in chat and Settings and the same height in every
// state: Settings and Models at the left, the update icon at the far right. No words in the
// row; they live in each button's tooltip and aria-label.

/** The words of a node rtInfo builds (<><b>Port 11434</b> · busy</>), for a tooltip and an aria-label. */
function plain(n: ReactNode): string {
  if (n === null || n === undefined || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(plain).join("");
  return isValidElement<{ children?: ReactNode }>(n) ? plain(n.props.children) : "";
}

/** The gear. While the runtime is not ready it carries what the runtime row said, and a click opens Settings › Runtime as the row did. */
function SettingsButton() {
  // Models is a pop-up of its own: the bot is lit for it, not the gear
  const inSettings = useStore((s) => s.view === "settings" && s.section !== "models");
  const conn = useStore((s) => s.conn);
  const runtime = useStore((s) => s.runtime);
  const settings = useStore((s) => s.settings);
  // before the runtime's first answer the gear claims nothing about it, past the boot bound too
  const boot = useStore(booting);
  const none = useStore(unread);
  const info = boot || none || rtOf({ conn, runtime, settings }) === "ready" ? null : rtInfo({ conn, runtime, settings });
  const g = settingsIcon(info && { text: plain(info.text), tip: info.tip, dot: info.dot });
  return (
    <FootButton
      icon="gear"
      label={g.label}
      tip={g.tip}
      {...(inSettings ? { tone: "on" as const } : {})}
      pressed={inSettings}
      dot={g.dot}
      onClick={() =>
        closeDrawer(() => {
          if (getState().view === "settings") return leaveSettings();
          if (g.runtime) return openSettings("runtime");
          // a phone opens Settings on its section list
          setState({ setList: true });
          openSettings();
        }, true)
      }
    />
  );
}

/** Failed downloads already seen in Settings › Models. A new attempt's failure is a new store object, so it shows again. Memory only. */
const seenFailures = new WeakSet<PullProgress>();
const running = (p: PullProgress) => p.state === "queued" || p.state === "downloading" || p.state === "verifying";

/** The bot: a ring while models download, red with a dot after a failure until Settings › Models is opened. */
function ModelsButton() {
  const pulls = useStore((s) => s.pulls);
  const catalog = useStore((s) => (s.catalog === NA ? undefined : s.catalog));
  const inModels = useStore((s) => s.view === "settings" && s.section === "models");
  const [, seen] = useState(0);
  useEffect(() => {
    if (!inModels) return;
    const fresh = Object.values(pulls).filter((p) => p.state === "error" && !seenFailures.has(p));
    for (const p of fresh) seenFailures.add(p);
    if (fresh.length > 0) seen((n) => n + 1);
  }, [inModels, pulls]);
  const all = Object.values(pulls);
  // downloads that finished in this burst stay in the ring's total, so it never goes backwards
  const burst = useRef<readonly PullProgress[]>([]);
  burst.current = finishedInBurst(burst.current, all);
  const m = modelsIcon(all.filter((p) => p.state !== "error" || !seenFailures.has(p)), (tag) => describeModel(tag, catalog).name, burst.current);
  return (
    <FootButton
      icon="bot"
      label={m.label}
      tip={m.tip}
      {...(m.state === "failed" ? { tone: "red" as const } : m.state === "downloading" ? { tone: "fg" as const, ring: m.progress } : {})}
      pressed={inModels}
      dot={m.failed ? "red" : null}
      onClick={() => closeDrawer(() => toggleModels(all.some(running)), true)}
    />
  );
}

/** Usage: a pop-up over the chat, lit while it is open. No badge: nothing about it needs attention. */
function UsageButton() {
  const open = useStore((s) => s.panel === "usage");
  return (
    <FootButton
      icon="bars"
      label="Usage"
      tip="Usage"
      cls="usage"
      {...(open ? { tone: "on" as const } : {})}
      pressed={open}
      onClick={() => closeDrawer(toggleUsage, true)}
    />
  );
}

export function Sidebar() {
  // under the Models pop-up (wider than a phone) the sidebar keeps its threads
  const phone = useMedia(PHONE);
  const inSettings = useStore((s) => s.view === "settings" && (phone || s.section !== "models"));
  return (
    <aside className="sb">
      {/* the same head in chat and Settings, so the first row below it never moves between the two */}
      <div className="sb-head">
        <svg className="mark" aria-hidden="true">
          <use href="#i-mark" />
        </svg>
        <span className="wordmark">Gates Local</span>
        <button type="button" className="ibtn sb-x" aria-label="Close threads" onClick={() => { cancelPendingSettings(); closeDrawer(); }}>
          <Icon id="x" />
        </button>
      </div>
      {inSettings ? <SettingsNav phone={phone} /> : <ChatNav />}
      <div className="sb-foot">
        <SettingsButton />
        <ModelsButton />
        <UsageButton />
        <SidebarUpdate via={(then) => closeDrawer(then, true)} />
      </div>
    </aside>
  );
}
