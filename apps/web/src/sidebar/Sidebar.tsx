// Layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
import type { PullProgress } from "@gates-local/contracts";
import { Fragment, type KeyboardEvent, type MouseEvent, type ReactNode, isValidElement, useEffect, useLayoutEffect, useRef } from "react";
import { requestFocus } from "../lib/ui/kit/focus.ts";
import { useNow } from "../lib/ui/kit/now.ts";
import { booting, rtInfo, rtOf, unread } from "../runtime/words.tsx";
import { finishedInBurst, modelsIcon, settingsIcon } from "./footer-state.ts";
import { describeModel, shortAge, when } from "../lib/words/format.ts";
import { Icon, type IconId } from "../lib/ui/icons.tsx";
import { focusComposer } from "../composer/focus.ts";
import { cancelPendingSettings, closeSettings, closeUsage, leavePictures, leaveSettings, newThread, openSettings, openThread, preloadThread, spareScreenEntry, toggleModels, togglePictures, toggleUsage } from "../lib/session/index.ts";
import { NA, type Section, getState, overChat, runningThreads, setState, useStore, waitingReplies } from "../lib/store/store.ts";
import { drawsPicture } from "../thread/turn.ts";
import { PHONE, closePop, closeTip, isTouch, useMedia } from "../lib/ui/ui.tsx";
import { FootButton, SidebarUpdate } from "../updates/Updates.tsx";

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

export function goNew(): void {
  closeDrawer(() => {
    newThread();
    focusComposer();
  }, true);
}

const DRAWER_BELOW_PX = 1024;
const DRAWER_ENTRY = "gl-drawer";
let afterClose: (() => void) | null = null;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

const onDrawerEntry = () => (history.state as { [DRAWER_ENTRY]?: boolean } | null)?.[DRAWER_ENTRY] === true;

export function openDrawer(): void {
  cancelPendingSettings();
  if (getState().drawer) return;
  setState({ drawer: true, pop: null, search: "" });
  // why: a screen just closed for this leaves its history entry, which the drawer takes over.
  if (spareScreenEntry()) history.replaceState({ [DRAWER_ENTRY]: true }, "");
  else if (!onDrawerEntry()) history.pushState({ [DRAWER_ENTRY]: true }, "");
  // why: on touch, focus takes a button, not the Search field, so the keyboard stays down.
  requestFocus(() => document.querySelector<HTMLElement>(isTouch() ? ".sb .sb-tools button, .sb .snav .sb-act" : ".sb #searchIn, .sb .snav .sb-act"));
}

// why: focus goes to the top bar's first visible control, never to a row sliding off screen.
function focusShell(): void {
  requestFocus(() => [...document.querySelectorAll<HTMLElement>(".hdr .bk, #menuBtn, .set-bar .set-done")].find((el) => el.getClientRects().length > 0));
}

function drawerClosed(refocus: boolean): void {
  clearTimeout(closeTimer);
  setState({ drawer: false });
  const then = afterClose;
  afterClose = null;
  if (refocus) focusShell();
  then?.();
}

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
  // oxlint-disable-next-line gates/timer-needs-reason -- a limit on the back's answer: a browser that never sends popstate (none seen) still closes the drawer
  closeTimer = setTimeout(() => drawerClosed(false), 400);
}

export function onDrawerPop(): void {
  if (getState().drawer && !onDrawerEntry()) {
    const backGesture = afterClose === null;
    if (backGesture) cancelPendingSettings();
    drawerClosed(backGesture);
  }
}

export function openSearch(): void {
  const s = getState();
  if (s.view === "firstrun") return;
  cancelPendingSettings();
  // why: this narrow, the Search field is in the drawer, which takes the screen's history entry.
  const narrow = window.innerWidth < DRAWER_BELOW_PX;
  if (s.panel !== null) closeUsage(false, narrow);
  else if (overChat(s.view) && narrow) closeSettings();
  else if (s.view === "settings") leaveSettings();
  else if (s.view === "pictures") leavePictures();
  if (narrow) openDrawer();
  requestFocus("#searchIn");
}

const clearSearch = () => setState({ search: "" });

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
  // external: a browser sends contextmenu after the keydown of the context-menu key, which has opened the menu by then
  if (p?.id === "thread" && p.thread === thread && p.kb) return;
  openThreadMenu(thread, { x: e.clientX, y: e.clientY }, false);
}

function marked(title: string, lowerCaseQuery: string): ReactNode {
  const lower = title.toLowerCase();
  // why: a title whose lower case changes its length keeps no marks, as their places would be off.
  if (lowerCaseQuery === "" || lower.length !== title.length) return title;
  const parts: ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(lowerCaseQuery); i !== -1; i = lower.indexOf(lowerCaseQuery, at)) {
    if (i > at) parts.push(title.slice(at, i));
    parts.push(<mark key={i}>{title.slice(i, i + lowerCaseQuery.length)}</mark>);
    at = i + lowerCaseQuery.length;
  }
  if (at < title.length) parts.push(title.slice(at));
  return parts;
}

// why: widths vary as titles do, never a full-width block.
const SKEL_ROWS = ["72%", "56%", "80%", "64%", "48%", "70%"] as const;

// why: joined as "id@at", so the selector's value compares equal until it changes.
const notStarted = (s: ReturnType<typeof getState>): string => {
  const out: string[] = [];
  for (const t of Object.values(s.turns)) {
    if (t.end !== undefined || drawsPicture(t)) continue;
    if (t.text === "" && t.thinking === "" && t.tools.length === 0) out.push(`${t.threadId}@${t.startedAt}`);
  }
  // why: a new thread holding only a queued message counts from when the message was typed.
  for (const q of waitingReplies(s)) if (s.turns[q.threadId] === undefined && s.messages[q.threadId]?.length === 0) out.push(`${q.threadId}@${q.at}`);
  return out.join(" ");
};
const waitingSince = (joined: string): ReadonlyMap<string, number> =>
  new Map(joined.split(" ").filter((e) => e !== "").map((e) => [e.slice(0, e.lastIndexOf("@")), Number(e.slice(e.lastIndexOf("@") + 1))]));

export function listOrder<T extends { id: string }>(threads: readonly T[], running: ReadonlySet<string>, waiting: ReadonlyMap<string, number>): readonly T[] {
  const ahead = (r: T, w: T) => r.id !== w.id && running.has(r.id) && (!waiting.has(r.id) || (waiting.get(r.id) ?? 0) < (waiting.get(w.id) ?? 0));
  const out = [...threads];
  for (const w of threads.filter((t) => waiting.has(t.id))) {
    const from = out.indexOf(w);
    const to = out.findLastIndex((r) => ahead(r, w));
    if (to > from) { out.splice(from, 1); out.splice(to, 0, w); }
  }
  return out;
}

function measureFade(el: HTMLElement): void {
  const end = Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
  el.style.setProperty("--fade-top", `${Math.max(0, el.scrollTop)}px`);
  el.style.setProperty("--fade-end", `${end}px`);
}

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
  // oxlint-disable-next-line gates/effect-needs-reason -- threads arriving, leaving or filtered change how far the list runs with no scroll or resize, so its edge fades are measured after each commit
  useLayoutEffect(() => {
    if (list.current) measureFade(list.current);
  });
  // why: one callback for the list's life; a new one each render would re-attach the listeners.
  const ref = useRef((el: HTMLElement | null) => {
    list.current = el;
    return fadeEdges(el);
  }).current;
  // oxlint-disable-next-line gates/effect-needs-reason -- drops the hover preload, which lives in the session, when the list unmounts
  useEffect(() => () => preloadThread(null), []);
  const threads = useStore((s) => s.threads);
  const q = useStore((s) => s.search.trim().toLowerCase());
  const searching = q !== "";
  const on = useStore((s) => (s.view === "thread" ? s.threadId : null));
  const running = useStore(runningThreads);
  const menuFor = useStore((s) => (s.pop?.id === "thread" ? s.pop.thread : null));
  const now = useNow(30_000);
  const drawerWidth = useMedia("(max-width: 1023px)");
  const boot = useStore(booting);
  const waiting = useStore(notStarted);
  const ordered = listOrder(threads, running, waitingSince(waiting));
  const shown = searching ? ordered.filter((t) => t.title.toLowerCase().includes(q)) : ordered;
  // why: row-shaped placeholders until the first read lands, so the list keeps its shape.
  if (boot && threads.length === 0) {
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
      {searching ? <div className="sb-group">{shown.length} {shown.length === 1 ? "thread" : "threads"}</div> : null}
      {shown.map((t) => {
        const w = when(t.updatedAt, now);
        const dateGroup = !searching && w.group !== last ? <div className="sb-group">{w.group}</div> : null;
        last = w.group;
        // why: a Fragment, as a wrapper would make .sb-group:first-child match every heading.
        return (
          <Fragment key={t.id}>
            {dateGroup}
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
              <button type="button" className="sb-thread" data-testid="sidebar.thread.open" onClick={() => closeDrawer(() => openThread(t.id), true)} onKeyDown={(e) => rowMenuKey(e, t.id)}
                // why: a keyboard pause on a row reads it ahead, as a mouse pause does.
                onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) preloadThread(t.id); }}
                onBlur={() => preloadThread(null)}>
                <span className="t">{searching ? marked(t.title, q) : t.title}</span>
                <span className="sb-status">
                  {running.has(t.id) ?<span className="live" aria-label="Reply in progress" /> : <span className="ago">{drawerWidth ? shortAge(t.updatedAt, now) : w.ago}</span>}
                </span>
              </button>
              <button
                type="button"
                className="ibtn xs sb-menu"
                data-testid="sidebar.thread.menu"
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
      <div className="sb-top">
        <label className="sb-search">
          <Icon id="search" />
          <input
            id="searchIn"
            data-testid="sidebar.search.input"
            type="text"
            placeholder="Search"
            aria-label="Search threads"
            autoComplete="off"
            spellCheck={false}
            value={search}
            onChange={(e) => setState({ search: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // why: an empty field has nothing to clear, so the same Escape goes on and closes the drawer.
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
              data-testid="sidebar.search.clear"
              aria-label="Clear search"
              data-tip="Clear · Esc"
              // why: the field keeps its focus through the press.
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
          <button type="button" className="ibtn" data-testid="sidebar.top.new-thread" aria-label="New thread" data-tip="New thread · Ctrl N" onClick={goNew}>
            <Icon id="pen" />
          </button>
        </div>
      </div>
      <ThreadList />
    </div>
  );
}

export function SettingsNav({ inDialog = false }: { inDialog?: boolean }) {
  const section = useStore((s) => s.section);
  // why: Models is a pop-up of its own, so the Settings pop-up leaves it out.
  const sections = inDialog ? SECTIONS.filter(([id]) => id !== "models") : SECTIONS;
  // why: no Back to chat in the pop-up, which has its own Close.
  const list = (
    <div className="snav">
      {inDialog ? null : (
        <button type="button" className="sb-act back" data-testid="settings.nav.back-to-chat" data-tip="Back to chat · Esc" onClick={() => closeDrawer(leaveSettings, true)}>
          <Icon id="left" />
          <span className="grow">Back to chat</span>
        </button>
      )}
      {sections.map(([id, label, icon]) => (
        <button key={id} type="button" className={`sb-act${section === id ? " on" : ""}${id === "runtime" ? " gap" : ""}`} data-testid={`settings.nav.open-${id}`}
          // why: a narrow pop-up shows the sections as icons only, so the hidden name is the tip.
          data-tipt={inDialog ? label : undefined}
          onClick={() => closeDrawer(() => openSettings(id), true)}>
          <Icon id={icon} />
          <span className="grow t">{label}</span>
        </button>
      ))}
    </div>
  );
  return inDialog ? <nav className="dlg-nav" aria-label="Settings sections">{list}</nav> : <nav className="sb-body">{list}</nav>;
}

function plain(n: ReactNode): string {
  if (n === null || n === undefined || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(plain).join("");
  return isValidElement<{ children?: ReactNode }>(n) ? plain(n.props.children) : "";
}

// why: Models is a pop-up of its own, with the bot lit for it, not the gear.
const gearLit = (s: ReturnType<typeof getState>) => s.view === "settings" && s.section !== "models";

function SettingsButton() {
  const lit = useStore(gearLit);
  const conn = useStore((s) => s.conn);
  const runtime = useStore((s) => s.runtime);
  const settings = useStore((s) => s.settings);
  const boot = useStore(booting);
  const none = useStore(unread);
  // why: before the runtime's first answer the gear claims nothing about it, past the boot bound too.
  const info = boot || none || rtOf({ conn, runtime, settings }) === "ready" ? null : rtInfo({ conn, runtime, settings });
  const g = settingsIcon(info && { text: plain(info.text), tip: info.tip, dot: info.dot });
  return (
    <FootButton
      testId="sidebar.foot.settings"
      icon="gear"
      label={g.label}
      tip={g.tip}
      {...(lit ? { tone: "on" as const } : {})}
      pressed={lit}
      dot={g.dot}
      onClick={() =>
        closeDrawer(() => {
          if (gearLit(getState())) return leaveSettings();
          if (g.opensRuntime) return openSettings("runtime");
          // why: a phone opens Settings on its section list.
          setState({ setList: true });
          openSettings();
        }, true)
      }
    />
  );
}

// why: a WeakSet, as a new attempt's failure is a new store object and so shows again.
const seenFailures = new WeakSet<PullProgress>();
const running = (p: PullProgress) => p.state === "queued" || p.state === "downloading" || p.state === "verifying";

function ModelsButton() {
  const pulls = useStore((s) => s.pulls);
  const catalog = useStore((s) => (s.catalog === NA ? undefined : s.catalog));
  const inModels = useStore((s) => s.view === "settings" && s.section === "models");
  const all = Object.values(pulls);
  // why: a failure on show in Settings › Models is seen, and the icon draws it seen in this render.
  if (inModels) for (const p of all) if (p.state === "error") seenFailures.add(p);
  const burst = useRef<readonly PullProgress[]>([]);
  burst.current = finishedInBurst(burst.current, all);
  const m = modelsIcon(all.filter((p) => p.state !== "error" || !seenFailures.has(p)), (tag) => describeModel(tag, catalog).name, burst.current);
  return (
    <FootButton
      testId="sidebar.foot.models"
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

function UsageButton() {
  const open = useStore((s) => s.panel === "usage");
  return (
    <FootButton
      testId="sidebar.foot.usage"
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

function PicturesButton() {
  const open = useStore((s) => s.view === "pictures");
  return (
    <FootButton
      testId="sidebar.foot.pictures"
      icon="image"
      label="Pictures"
      tip="Pictures"
      cls="pics-btn"
      {...(open ? { tone: "on" as const } : {})}
      pressed={open}
      onClick={() => closeDrawer(togglePictures, true)}
    />
  );
}

export function Sidebar() {
  const phone = useMedia(PHONE);
  // why: wider than a phone Settings is a pop-up, and the sidebar under it keeps its threads.
  const inSettings = useStore((s) => s.view === "settings") && phone;
  return (
    <aside className="sb">
      <div className="sb-head">
        <svg className="mark" aria-hidden="true">
          <use href="#i-mark" />
        </svg>
        <span className="wordmark">Gates Local</span>
        <button type="button" className="ibtn sb-x" data-testid="sidebar.drawer.close" aria-label="Close threads" onClick={() => { cancelPendingSettings(); closeDrawer(); }}>
          <Icon id="x" />
        </button>
      </div>
      {inSettings ? <SettingsNav /> : <ChatNav />}
      <div className="sb-foot">
        <SettingsButton />
        <ModelsButton />
        <UsageButton />
        <PicturesButton />
        <SidebarUpdate via={(then) => closeDrawer(then, true)} />
      </div>
    </aside>
  );
}
