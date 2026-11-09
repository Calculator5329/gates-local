// Header layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The app shell (shell.md F05, F22, F51): sidebar, one header, the stage
// (new-thread draft or the timeline with the composer docked under it) or
// Settings, first run, popovers and the tooltip layer.
// Global keys follow the design's Escape order: popover, drawer, the
// runtime confirm, the download page, then Settings itself.
import type { Message } from "@gates-local/contracts";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Banner, type Rt, rtOf } from "./Banner.tsx";
import { Composer, OptsMenu, PlusMenu } from "./Composer.tsx";
import { FirstRunLoading, NoServer } from "./FirstRunShell.tsx";
import { describeModel } from "./format.ts";
import { Icon, type IconId, Sprite } from "./icons.tsx";
import { ScreenError, firstRunScreen, pickerScreen, preloadScreens, settingsScreen, threadScreen, useScreen } from "./screens.tsx";
import { SECTIONS, Sidebar, closeDrawer, focusComposer, goNew, onDrawerPop, openDrawer, openSearch } from "./Sidebar.tsx";
import { UpdateNote } from "./UpdateNote.tsx";
import { call, cancelPendingSettings, deleteThread, leaveSettings, newThread, openSettings, openThread, renameThread, threadFromHash, threadMarkdown } from "./session.ts";
import { NA, type Section, type State, getState, setState, useStore } from "./store.ts";
import { syncWindowTitle } from "./titlebar.ts";
import { keepSheetFocus } from "./sheet-focus.ts";
import { PHONE, POP_EL, SheetHead, Tip, anchorOf, closePop, isPhone, isTouch, menuKeys, place, tabStops, useMedia } from "./ui.tsx";

interface Card {
  readonly icon: IconId;
  readonly t: string;
  readonly d: string;
  readonly q: string;
  readonly img?: boolean;
}

const hasSources = (s: State) => Array.isArray(s.sources) && s.sources.length > 0;
const noSources = (s: State) => Array.isArray(s.sources) && s.sources.length === 0;
const imageGenOf = (s: State) => s.settings !== NA && s.settings?.imageGen === true;
const imageSetupOf = (s: State) => s.settings !== NA && s.settings !== undefined && !s.settings.imageGen;

/** Starter cards under the new-thread composer (F43): inert while chat is blocked. */
function Cards() {
  const lib = useStore(hasSources);
  const libLink = useStore(noSources);
  const img = useStore(imageGenOf);
  const imgLink = useStore(imageSetupOf);
  const blocked = useStore((s) => rtOf(s) !== "ready");
  const phone = useMedia(PHONE);
  const cards: Card[] = [
    { icon: "chat", t: "Explain something", d: "Plain answers, step by step.", q: "Explain how cron decides which programs it can find." },
    { icon: "pencil", t: "Draft or rewrite", d: "Emails, notes and READMEs, written here.", q: "Rewrite this paragraph so it is shorter and clearer: " },
  ];
  if (lib) cards.push({ icon: "book", t: "Search my library", d: "Books and notes you added.", q: "Which books in the library are about databases?" });
  if (img) cards.push({ icon: "image", t: "Generate an image", d: "ComfyUI on this GPU.", q: "Make an image of ", img: true });
  const links: [Section, string][] = [];
  if (libLink) links.push(["library", "Set up library search…"]);
  if (imgLink) links.push(["images", "Set up image generation…"]);
  return (
    <>
      <div className={`cards${cards.length === 3 ? " c3" : ""}${blocked ? " off" : ""}`} inert={blocked}>
        {cards.map((c) => (
          <button
            key={c.t}
            type="button"
            className="card"
            onClick={() => {
              setState({ draft: c.q, ...(c.img ? { image: true } : {}) });
              focusComposer(true);
            }}
          >
            <Icon id={c.icon} />
            <span>
              <span className="ct">{c.t}</span>
              <span className="cd">{c.d}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="card-links">
        {phone && links.length === 2 ? (
          <button
            type="button"
            className="link"
            onClick={() => {
              setState({ setList: true });
              openSettings();
            }}
          >
            Set up library and images…
          </button>
        ) : (
          links.map(([go, label]) => (
            <button key={go} type="button" className="link" data-go={go} onClick={() => openSettings(go)}>
              {label}
            </button>
          ))
        )}
      </div>
    </>
  );
}

function Draft() {
  return (
    <div className="draft">
      <div className="draft-in">
        <h1 className="hero">What would you like help with?</h1>
        <p className="hero-sub">Runs on your computer. Nothing leaves your own network.</p>
        <div className="banner-slot">
          <UpdateNote />
          <Banner />
        </div>
        <div id="draftComposerSlot">
          <Composer />
        </div>
        <Cards />
      </div>
    </div>
  );
}

/** Below 1024 px: opens the thread drawer. Hidden on the desktop, where the sidebar is always there. */
function MenuButton() {
  const open = useStore((s) => s.drawer);
  return (
    <button type="button" className="ibtn hb" id="menuBtn" aria-label="Open threads" aria-expanded={open} onClick={openDrawer}>
      <Icon id="menu" cls="s18" />
    </button>
  );
}

/** A phone's Settings Back: every section goes to the list, and the Models page's two tabs are one section. */
function settingsBack(): void {
  document.querySelector(".set")?.scrollTo(0, 0);
  setState({ setList: true });
}

/** Settings' top bar below 1024 px: the drawer button on a tablet; on a phone the page's name, a Back that says where it goes, and Done on the list. */
function SettingsBar() {
  const phone = useMedia(PHONE);
  const root = useStore((s) => s.setList);
  const section = useStore((s) => s.section);
  const title = !phone || root ? "Settings" : (SECTIONS.find(([id]) => id === section)?.[1] ?? "Settings");
  return (
    <header className="hdr set-bar">
      <MenuButton />
      {root ? (
        <span className="hb sp" />
      ) : (
        <button type="button" className="bk" aria-label="Back to Settings" onClick={settingsBack}>
          <Icon id="left" cls="s18" />
          Settings
        </button>
      )}
      <h2>{title}</h2>
      {root ? (
        <button type="button" className="set-done" onClick={leaveSettings}>
          Done
        </button>
      ) : (
        <span className="hb sp" />
      )}
    </header>
  );
}

const RT_WORD: Record<Rt, string> = { ready: "Running", installing: "Installing", starting: "Starting", missing: "Not installed", wrong: "Port busy", stopped: "Stopped", error: "Didn't start", offline: "Reconnecting" };

/** What a section is set to, at the end of its row in a phone's Settings list. */
function listValue(s: State, id: Section): string {
  const settings = s.settings === NA ? undefined : s.settings;
  switch (id) {
    case "general":
      return settings === undefined ? "" : settings.theme.charAt(0).toUpperCase() + settings.theme.slice(1);
    case "models": {
      const tag = settings?.defaultModel ?? s.model;
      return tag === undefined ? "" : describeModel(tag, s.catalog === NA ? undefined : s.catalog).name;
    }
    case "runtime":
      return RT_WORD[rtOf(s)];
    case "tools":
      return settings === undefined ? "" : settings.tools ? "On" : "Off";
    case "images":
      return settings === undefined ? "" : settings.imageGen ? "On" : "Off";
    case "library":
      return Array.isArray(s.sources) ? `${s.sources.length} ${s.sources.length === 1 ? "source" : "sources"}` : "";
    default:
      return "";
  }
}

function ListValue({ id }: { id: Section }) {
  const v = useStore((s) => listValue(s, id));
  return v === "" ? null : <span className="val">{v}</span>;
}

/** A phone's Settings home: the sections as one list; a tap opens one with Back to here. */
function SettingsList() {
  return (
    <nav className="set-list" aria-label="Settings sections">
      <div className="box">
        {SECTIONS.map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            className="sl-r"
            onClick={() => {
              document.querySelector(".set")?.scrollTo(0, 0);
              setState({ setList: false });
              openSettings(id);
            }}
          >
            <Icon id={icon} />
            <span className="mn">{label}</span>
            <ListValue id={id} />
            <Icon id="right" cls="s14" />
          </button>
        ))}
      </div>
    </nav>
  );
}

function Header({ isNew }: { isNew: boolean }) {
  const threadId = useStore((s) => s.threadId);
  const emptyDraft = useStore((s) => s.draft === "");
  const title = useStore((s) => s.threads.find((t) => t.id === s.threadId)?.title ?? "");
  const renaming = useStore((s) => s.renaming);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    syncWindowTitle(isNew ? null : title);
    if (renaming) input.current?.select();
  }, [renaming, isNew, title]);
  const done = (save: boolean) => {
    const value = input.current?.value.trim() ?? "";
    if (save && threadId !== null && value !== "" && value !== title) void renameThread(threadId, value);
    setState({ renaming: false });
  };
  return (
    <header className="hdr">
      <MenuButton />
      {renaming && !isNew ? (
        <input
          ref={input}
          className="inp hdr-in"
          aria-label="Thread title"
          defaultValue={title}
          onBlur={() => done(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") done(true);
            if (e.key === "Escape") {
              e.stopPropagation();
              done(false);
            }
          }}
        />
      ) : (
        <h2 className={isNew ? "muted" : undefined}>{isNew ? "New thread" : title}</h2>
      )}
      <button type="button" className="ibtn hb nb" aria-label="New thread" disabled={isNew && emptyDraft} onClick={goNew}>
        <Icon id="pen" cls="s18" />
      </button>
    </header>
  );
}

function exportThread(threadId: string, messages: readonly Message[]): void {
  const s = getState();
  const title = s.threads.find((t) => t.id === threadId)?.title ?? "thread";
  const url = URL.createObjectURL(new Blob([threadMarkdown(threadId, messages)], { type: "text/markdown" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title.replace(/[^\w\- ]+/g, "").trim() || "thread"}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Close a thread menu, then act on the row it opened from. */
const act = (fn: (threadId: string) => void) => () => {
  const s = getState();
  const id = s.pop?.id === "thread" ? s.pop.thread : null;
  closePop();
  if (id !== null) fn(id);
};

/** Rename edits the header title, so a thread from the sidebar opens first. */
function renameFromMenu(id: string): void {
  const s = getState();
  if (s.view !== "thread" || s.threadId !== id) openThread(id);
  setState({ renaming: true });
}

/** How long Export as Markdown waits for its thread to load before it gives up. */
const EXPORT_WAIT_MS = 8000;

/**
 * Export loads the thread it was asked for and makes the file from that load, even when a copy
 * is cached: another client may have added to it. A failed or slow load, or a thread deleted
 * meanwhile, says so instead.
 */
async function exportFromMenu(id: string): Promise<void> {
  const title = getState().threads.find((t) => t.id === id)?.title ?? "this thread";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((done) => {
    timer = setTimeout(() => done("late"), EXPORT_WAIT_MS);
  });
  const got = await Promise.race([call("threads.get", { threadId: id }), late])
    .catch(() => "failed" as const)
    .finally(() => clearTimeout(timer));
  const fail = (why: string) => setState({ notice: `Couldn't export “${title}”: ${why}` });
  if (!getState().threads.some((t) => t.id === id)) return fail("it was deleted.");
  if (got === "late") return fail("it took too long to load. Try again.");
  if (got === "failed") return fail("it didn't load. Try again.");
  exportThread(id, got.messages);
}

/** Opened at a point (a right-click or a row's menu key): below it, or above when it would leave the window. */
function placeAt(pop: HTMLElement, at: { x: number; y: number }): void {
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const top = at.y + ph + 8 <= window.innerHeight ? at.y : Math.max(8, at.y - ph);
  pop.style.top = `${top}px`;
  pop.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - pw - 8))}px`;
}

function ThreadMenu() {
  const pop = useStore((s) => (s.pop?.id === "thread" ? s.pop : null));
  const open = pop !== null;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || pop === null) return;
    const anchor = anchorOf("thread");
    if (pop.at) placeAt(el, pop.at);
    else if (anchor) place(el, anchor, "end", "below");
    if (pop.kb) el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [pop]);
  return (
    <div className={`pop menu${open ? " open" : ""}`} id="threadMenu" role="menu" aria-label="Thread actions" ref={ref} onKeyDown={menuKeys}>
      <SheetHead title="Thread" />
      <button type="button" className="mi" role="menuitem" onClick={act((id) => closeDrawer(() => renameFromMenu(id)))}>
        <Icon id="pencil" />
        <b>Rename</b>
      </button>
      <button type="button" className="mi" role="menuitem" onClick={act((id) => void exportFromMenu(id))}>
        <Icon id="download" />
        <b>Export as Markdown</b>
      </button>
      <div className="msep" />
      <button type="button" className="mi danger" role="menuitem" onClick={act((id) => void deleteThread(id))}>
        <Icon id="trash" />
        <b>Delete thread</b>
      </button>
    </div>
  );
}

/** What Tab must stay inside right now: a phone's sheet or the drawer. */
function modalBox(s: State): HTMLElement | null {
  if (s.pop !== null) return isPhone() ? document.getElementById(POP_EL[s.pop.id]) : null;
  if (s.drawer) return document.querySelector<HTMLElement>(".sb");
  return null;
}

function trapTab(e: Pick<KeyboardEvent, "shiftKey" | "preventDefault">, box: HTMLElement): void {
  const items = tabStops(box);
  const first = items[0];
  const last = items.at(-1);
  const at = document.activeElement;
  if (first === undefined || last === undefined) return e.preventDefault();
  if (at === null || !box.contains(at)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey ? at === first : at === last) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
}

/** Where a swipe started, when it started on a sheet's title row. */
let swipeFrom: number | null = null;

function onTouchStart(e: TouchEvent): void {
  swipeFrom = null;
  const t = e.target instanceof Element ? e.target : null;
  if (t === null || !isPhone() || t.closest("button") !== null || t.closest(".sh-h") === null) return;
  swipeFrom = e.touches[0]?.clientY ?? null;
}

/** A swipe of 48 px or more down a sheet's title row closes the sheet. */
function onTouchEnd(e: TouchEvent): void {
  const from = swipeFrom;
  swipeFrom = null;
  const to = e.changedTouches[0]?.clientY;
  if (from === null || to === undefined || to - from < 48) return;
  if (getState().pop !== null) closePop(true);
}

export function onKey(e: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "preventDefault">): void {
  const s = getState();
  if (e.key === "Tab") {
    const box = modalBox(s);
    if (box !== null) trapTab(e, box);
    return;
  }
  if (e.key === "Escape") {
    if (cancelPendingSettings()) e.preventDefault();
    if (s.pop !== null) {
      e.preventDefault();
      return closePop(true);
    }
    if (s.drawer) {
      e.preventDefault();
      return closeDrawer();
    }
    if (s.view === "settings" && s.ownerConfirm) return setState({ ownerConfirm: false });
    if (s.view === "settings" && s.addPage) return setState({ addPage: false });
    if (s.view === "settings") return leaveSettings();
    return;
  }
  if (!(e.ctrlKey || e.metaKey) || s.view === "firstrun") return;
  const key = e.key.toLowerCase();
  if (key === "n") {
    e.preventDefault();
    goNew();
  } else if (key === "k") {
    e.preventDefault();
    openSearch();
  } else if (key === "m") {
    e.preventDefault();
    if (s.view !== "settings") setState({ pop: { id: "picker", kb: true } });
  } else if (key === ",") {
    e.preventDefault();
    openSettings();
  }
}

function onMouseDown(e: MouseEvent): void {
  const p = getState().pop;
  if (p === null || !(e.target instanceof Node)) return;
  const pop = document.getElementById(POP_EL[p.id]);
  const anchor = anchorOf(p.id);
  if (pop?.contains(e.target) || anchor?.contains(e.target)) return;
  closePop();
}

let lastWidth = window.innerWidth;
/** A resize closes popovers (they would sit in the wrong place), except a touch keyboard opening: it changes only the height, and sheets sit on the bottom edge. */
function onResize(): void {
  if (window.innerWidth === lastWidth && isTouch()) return;
  lastWidth = window.innerWidth;
  closePop("if-inside");
  if (window.innerWidth >= 1024) closeDrawer();
}

function onHash(): void {
  const id = threadFromHash();
  if (id !== null && id !== getState().threadId) openThread(id);
  else if (id === null && getState().view === "thread") newThread();
}

export function App() {
  const view = useStore((s) => s.view);
  const threadId = useStore((s) => s.threadId);
  const noServer = useStore((s) => s.conn.kind === "no-server");
  const drawer = useStore((s) => s.drawer);
  const popOpen = useStore((s) => s.pop !== null);
  const setList = useStore((s) => s.setList);
  const popId = useStore((s) => s.pop?.id ?? null);
  const settings = useScreen(settingsScreen, view === "settings");
  const firstRun = useScreen(firstRunScreen, !noServer && view === "firstrun");
  const picker = useScreen(pickerScreen, popId === "picker");
  const thread = useScreen(threadScreen, view === "thread");
  useEffect(preloadScreens, []);
  const phone = useMedia(PHONE);
  // A phone's sheet stays modal through live updates; Ctrl+M's search focuses itself after opening.
  useEffect(() => {
    if (popId === null || !isPhone()) return;
    const sheet = document.getElementById(POP_EL[popId]);
    if (sheet !== null) return keepSheetFocus(sheet);
  }, [popId]);
  useEffect(() => {
    document.addEventListener("keydown", onKey);
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("resize", onResize);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onDrawerPop);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onDrawerPop);
    };
  }, []);
  // A cold click keeps the existing chat layout until the whole screen is ready.
  const isSet = view === "settings";
  // the section list is a phone's Settings home; leaving Settings forgets it
  useEffect(() => {
    if (view !== "settings" && getState().setList) setState({ setList: false });
  }, [view]);
  const isNew = view === "new" || threadId === null;
  // first run covers the app; what is underneath takes no focus or clicks
  const covered = noServer || view === "firstrun";
  return (
    <>
      <Sprite />
      <div className={`app${drawer ? " drawer" : ""}`} id="app" inert={popOpen && phone}>
        <div style={{ display: "contents" }} inert={covered}>
          <Sidebar />
        </div>
        {drawer ? <div className="scrim" aria-hidden="true" onClick={() => { cancelPendingSettings(); closeDrawer(); }} /> : null}
        <main className="main" inert={covered || drawer}>
          {isSet ? <SettingsBar /> : <Header isNew={isNew} />}
          <div className="work">
            {isSet ? (
              <div className={`set${setList ? " listing" : ""}`}>
                <div className="set-in">
                  <SettingsList />
                  {settings.kind === "ready" ? <settings.value.SettingsView /> : <ScreenError />}
                </div>
              </div>
            ) : (
              <div className="stage">
                {isNew || threadId === null ? (
                  <Draft />
                ) : (
                  <>
                    {thread.kind === "ready" ? <thread.value.Timeline threadId={threadId} /> : <div className="tl">{thread.kind === "error" ? <ScreenError /> : null}</div>}
                    <div className="cw">
                      <div className="banner-slot">
                        <UpdateNote />
                        <Banner />
                      </div>
                      <Composer />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </main>
        {covered ? (
          <div className="first">
            {noServer ? <NoServer /> : firstRun.kind === "ready" ? <firstRun.value.FirstRun /> : firstRun.kind === "error" ? <ScreenError /> : <FirstRunLoading />}
          </div>
        ) : null}
      </div>
      {/* a phone's sheets sit over a scrim; on the desktop it is not drawn */}
      {popOpen ? <div className="scrim pop-scrim" aria-hidden="true" onClick={() => closePop(true)} /> : null}
      {popId === "picker" ? picker.kind === "ready" ? <picker.value.Picker /> : picker.kind === "error" ? <div id="picker" className="model-picker open" role="dialog" aria-label="Choose a model"><button className="btn" onClick={() => closePop(true)}>Back to chat</button><ScreenError /></div> : null : null}
      <PlusMenu />
      <OptsMenu />
      <ThreadMenu />
      <Tip />
    </>
  );
}
