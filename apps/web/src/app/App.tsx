// Header layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The app shell (shell.md F05, F22, F51): sidebar, one header, the stage
// (new-thread draft or the timeline with the composer docked under it) or
// Settings, first run, popovers and the tooltip layer.
// Global keys follow the design's Escape order: popover, drawer, the
// runtime confirm, the download page, then Settings itself.
import type { Message } from "@gates-local/contracts";
import { useEffect, useRef, useState } from "react";
import { Banner } from "../runtime/Banner.tsx";
import { type Rt, failWords, installStep, rtOf } from "../runtime/words.tsx";
import { Composer, CountMenu, OptsMenu, PlusMenu } from "../composer/Composer.tsx";
import { ImageUnset } from "../image/ImageUnset.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { FirstRunLoading, NoServer } from "../first-run/FirstRunShell.tsx";
import { describeModel } from "../lib/words/format.ts";
import { Icon, type IconId, Sprite } from "../lib/ui/icons.tsx";
import { imageMode } from "../image/image-choice.ts";
import { ScreenError, firstRunScreen, imagePickerScreen, pickerScreen, settingsScreen, threadScreen, useScreen } from "./screens.tsx";
import { SECTIONS, SettingsNav, Sidebar, closeDrawer, goNew, onDrawerPop, openDrawer, openSearch } from "../sidebar/Sidebar.tsx";
import { UpdateNote } from "../updates/UpdateNote.tsx";
import { Dialog, DialogHead } from "../lib/ui/Panel.tsx";
import { picturesScreen, usageScreen } from "./screen-loaders.ts";
import { call, cancelPendingSettings, closeUsage, deleteThread, leavePictures, leaveSettings, pictures, togglePictures, newThread, onScreenPop, openSettings, openThread, preloadThread, renameThread, threadFromHash, threadMarkdown, waitForThreadDeletion } from "../lib/session/index.ts";
import { NA, type Section, type State, getState, overChat, setState, useStore } from "../lib/store/store.ts";
import { useDraft } from "../lib/store/drafts.ts";
import { syncWindowTitle } from "./titlebar.ts";
import { keepSheetFocus } from "./sheet-focus.ts";
import { useReadAloud } from "../voice/talk.ts";
import { useCovering } from "../pages/cover.ts";
import { PHONE, POP_EL, SheetHead, Tip, TurnSkel, anchorOf, closePop, isPhone, isTouch, menuKeys, place, tabStops, useMedia } from "../lib/ui/ui.tsx";
import { downloadBlob, withTimeout } from "../lib/ui/kit/async.ts";
import { CommitJobs } from "../lib/ui/kit/focus.ts";
import { usePopover } from "../lib/ui/kit/popover.ts";
import { useDocumentEvent } from "../lib/ui/kit/events.ts";
import { watch } from "../lib/ui/kit/watch.ts";

interface Unset { readonly lib: boolean; readonly img: boolean }

const SHAPE_KEY = "gates-local:card-shape";
const NEW_UNSET: Unset = { lib: true, img: true };

function savedUnset(): Unset {
  try {
    const v = JSON.parse(localStorage.getItem(SHAPE_KEY) ?? "null") as { libLink?: unknown; imgLink?: unknown } | null;
    if (v === null || typeof v !== "object") return NEW_UNSET;
    return { lib: typeof v.libLink === "boolean" ? v.libLink : true, img: typeof v.imgLink === "boolean" ? v.imgLink : true };
  } catch {
    return NEW_UNSET;
  }
}

function unsetNow(s: State, saved: Unset): Unset & { readonly known: boolean } {
  return {
    lib: s.sources === undefined ? saved.lib : Array.isArray(s.sources) && s.sources.length === 0,
    img: s.settings === undefined ? saved.img : s.settings !== NA && !s.settings.imageGen,
    known: s.sources !== undefined && s.settings !== undefined,
  };
}

const shapeNow = (s: State): string | null => {
  const now = unsetNow(s, NEW_UNSET);
  return now.known ? JSON.stringify({ libLink: now.lib, imgLink: now.img }) : null;
};

function keepShape(shape: string | null): void {
  if (shape === null) return;
  try {
    localStorage.setItem(SHAPE_KEY, shape);
  } catch {
    // external: a browser's private window may refuse storage
  }
}

const titleNow = (s: State): string | null => (s.view === "new" || s.threadId === null ? null : s.threads.find((t) => t.id === s.threadId)?.title ?? "");

function forgetSectionList(view: State["view"]): void {
  if (view !== "settings" && getState().setList) setState({ setList: false });
}

// why: started once by the entry, so a change from any path in lib/session is heard
export function watchApp(): () => void {
  const stops = [watch(shapeNow, keepShape), watch(titleNow, syncWindowTitle), watch((s) => s.view, forgetSectionList)];
  return () => {
    for (const stop of stops) stop();
  };
}

// why: one identity at module level, so the text is selected only on the commit that draws it
const selectOnDraw = (el: HTMLInputElement | null): void => {
  el?.select();
};

function SetupIcons() {
  const [saved] = useState(savedUnset);
  const lib = useStore((s) => unsetNow(s, saved).lib);
  const img = useStore((s) => unsetNow(s, saved).img);
  const icons: [Section, IconId, string][] = [];
  if (lib) icons.push(["library", "book", "Library search"]);
  if (img) icons.push(["images", "image", "Image generation"]);
  return (
    <div className="setup-row">
      {icons.map(([go, icon, name]) => (
        <button key={go} type="button" className="setup-ic" data-go={go} data-testid={`chat.setup.open-${go}`} data-tip={name} aria-label={`Set up ${name.toLowerCase()}`} onClick={() => openSettings(go)}>
          <Icon id={icon} />
          <span className="unset" />
        </button>
      ))}
    </div>
  );
}

function Draft({ under }: { under: boolean }) {
  return (
    <div className="draft">
      <div className="draft-in">
        <h1 className="start-mark">
          <svg role="img" aria-label="Gates Local">
            <use href="#i-mark" />
          </svg>
        </h1>
        <div className="banner-slot">
          {under ? null : <UpdateNote />}
          <Banner />
        </div>
        <div id="draftComposerSlot">
          <Composer />
        </div>
        <SetupIcons />
      </div>
    </div>
  );
}

function MenuButton() {
  const open = useStore((s) => s.drawer);
  return (
    <button type="button" className="ibtn hb" id="menuBtn" data-testid="chat.header.open-threads" aria-label="Open threads" aria-expanded={open} onClick={openDrawer}>
      <Icon id="menu" cls="s18" />
    </button>
  );
}

function settingsBack(): void {
  document.querySelector(".set")?.scrollTo(0, 0);
  setState({ setList: true });
}

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
        <button type="button" className="bk" data-testid="settings.shell.back" aria-label="Back to Settings" onClick={settingsBack}>
          <Icon id="left" cls="s18" />
          Settings
        </button>
      )}
      <h2>{title}</h2>
      {root ? (
        <button type="button" className="set-done" data-testid="settings.shell.done" onClick={leaveSettings}>
          Done
        </button>
      ) : (
        <span className="hb sp" />
      )}
    </header>
  );
}

const RT_WORD: Record<Rt, string> = { ready: "Running", installing: "Installing", starting: "Starting", missing: "Not installed", wrong: "Port busy", stopped: "Stopped", error: "Didn't start", offline: "Reconnecting" };

function listValue(s: State, id: Section): string {
  const settings = s.settings === NA ? undefined : s.settings;
  switch (id) {
    case "general":
      return settings === undefined ? "" : settings.theme.charAt(0).toUpperCase() + settings.theme.slice(1);
    case "models": {
      const tag = settings?.defaultModel ?? s.model;
      return tag === undefined ? "" : describeModel(tag, s.catalog === NA ? undefined : s.catalog).name;
    }
    case "runtime": {
      const rt = rtOf(s);
      return rt === "installing" ? installStep(s.runtime?.install) : rt === "error" ? failWords(s.runtime?.failure).stat : RT_WORD[rt];
    }
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

function SettingsList() {
  return (
    <nav className="set-list" aria-label="Settings sections">
      <div className="box">
        {SECTIONS.map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            className="sl-r"
            data-testid={`settings.sections.open-${id}`}
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
  const emptyDraft = useDraft(d => d.text === "");
  const title = useStore((s) => s.threads.find((t) => t.id === s.threadId)?.title ?? "");
  const renaming = useStore((s) => s.renaming);
  const done = (save: boolean, field: HTMLInputElement) => {
    const value = field.value.trim();
    if (save && threadId !== null && value !== "" && value !== title) void renameThread(threadId, value);
    setState({ renaming: false });
  };
  return (
    <header className="hdr">
      <MenuButton />
      {renaming && !isNew ? (
        <input
          ref={selectOnDraw}
          className="inp hdr-in"
          data-testid="chat.header.title"
          aria-label="Thread title"
          defaultValue={title}
          onBlur={(e) => done(true, e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === "Enter") done(true, e.currentTarget);
            if (e.key === "Escape") {
              e.stopPropagation();
              done(false, e.currentTarget);
            }
          }}
        />
      ) : (
        <h2 className={isNew ? "muted" : undefined}>{isNew ? "New thread" : title}</h2>
      )}
      <button type="button" className="ibtn hb nb" data-testid="chat.header.new-thread" aria-label="New thread" disabled={isNew && emptyDraft} onClick={goNew}>
        <Icon id="pen" cls="s18" />
      </button>
    </header>
  );
}

function exportThread(threadId: string, messages: readonly Message[]): void {
  const s = getState();
  const title = s.threads.find((t) => t.id === threadId)?.title ?? "thread";
  downloadBlob(new Blob([threadMarkdown(threadId, messages)], { type: "text/markdown" }), `${title.replace(/[^\w\- ]+/g, "").trim() || "thread"}.md`);
}

const act = (fn: (threadId: string) => void) => () => {
  const s = getState();
  const id = s.pop?.id === "thread" ? s.pop.thread : null;
  closePop();
  if (id !== null) fn(id);
};

function renameFromMenu(id: string): void {
  const s = getState();
  if (s.view !== "thread" || s.threadId !== id) openThread(id);
  setState({ renaming: true });
}

const EXPORT_WAIT_MS = 8000;

async function exportFromMenu(id: string): Promise<void> {
  preloadThread(null);
  const title = getState().threads.find((t) => t.id === id)?.title ?? "this thread";
  const read = call("threads.get", { threadId: id }).finally(() => waitForThreadDeletion(id));
  const got = await withTimeout(read, EXPORT_WAIT_MS, () => "late" as const).catch(() => "failed" as const);
  const fail = (why: string) => setState({ notice: `Couldn't export “${title}”: ${why}` });
  if (!getState().threads.some((t) => t.id === id)) return fail("it was deleted.");
  if (got === "late") return fail("it took too long to load. Try again.");
  if (got === "failed") return fail("it didn't load. Try again.");
  exportThread(id, got.messages);
}

function placeAt(pop: HTMLElement, at: { x: number; y: number }): void {
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const top = at.y + ph + 8 <= window.innerHeight ? at.y : Math.max(8, at.y - ph);
  pop.style.top = `${top}px`;
  pop.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - pw - 8))}px`;
}

function ThreadMenu() {
  const pop = useStore((s) => (s.pop?.id === "thread" ? s.pop : null));
  const canDelete = useStore((s) => s.unavailable["threads.delete"] !== true);
  const open = pop !== null;
  const ref = useRef<HTMLDivElement>(null);
  usePopover(ref, pop !== null, (el) => {
    if (pop === null) return;
    const anchor = anchorOf("thread");
    if (pop.at) placeAt(el, pop.at);
    else if (anchor) place(el, anchor, "end", "below");
    if (pop.kb) el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [pop]);
  return (
    <div className={`pop menu${open ? " open" : ""}`} id="threadMenu" data-testid="sidebar.thread-menu.menu" role="menu" aria-label="Thread actions" ref={ref} onKeyDown={menuKeys}>
      <SheetHead title="Thread" />
      <button type="button" className="mi" data-testid="sidebar.thread-menu.rename" role="menuitem" onClick={act((id) => closeDrawer(() => renameFromMenu(id)))}>
        <Icon id="pencil" />
        <b>Rename</b>
      </button>
      <button type="button" className="mi" data-testid="sidebar.thread-menu.export" role="menuitem" onClick={act((id) => void exportFromMenu(id))}>
        <Icon id="download" />
        <b>Export as Markdown</b>
      </button>
      {canDelete ? (
        <>
          <div className="msep" />
          <button type="button" className="mi danger" data-testid="sidebar.thread-menu.delete" role="menuitem" onClick={act((id) => void deleteThread(id))}>
            <Icon id="trash" />
            <b>Delete thread</b>
          </button>
        </>
      ) : null}
    </div>
  );
}

const settingsDialog = (s: Pick<State, "view">, phone: boolean) => s.view === "settings" && !phone;

function modalBox(s: State): HTMLElement | null {
  if (s.pop !== null) return isPhone() ? document.getElementById(POP_EL[s.pop.id]) : null;
  if (s.panel !== null || settingsDialog(s, isPhone())) return document.querySelector<HTMLElement>(".dlg");
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

let swipeFrom: number | null = null;

function onTouchStart(e: TouchEvent): void {
  swipeFrom = null;
  const t = e.target instanceof Element ? e.target : null;
  if (t === null || !isPhone() || t.closest("button") !== null || t.closest(".sh-h") === null) return;
  swipeFrom = e.touches[0]?.clientY ?? null;
}

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
    if (s.panel !== null) {
      e.preventDefault();
      return closeUsage();
    }
    if (s.view === "settings" && s.ownerConfirm) return setState({ ownerConfirm: false });
    if (s.view === "settings" && s.addPage) return setState({ addPage: false });
    if (s.view === "settings") return leaveSettings();
    if (s.view === "pictures") {
      e.preventDefault();
      return pictures.get().large ? pictures.setLarge(false) : leavePictures();
    }
    return;
  }
  if (!(e.ctrlKey || e.metaKey) || s.view === "firstrun") return;
  const key = e.key.toLowerCase();
  if (key === "p" && e.shiftKey) {
    e.preventDefault();
    togglePictures();
  } else if (key === "n") {
    e.preventDefault();
    goNew();
  } else if (key === "k") {
    e.preventDefault();
    openSearch();
  } else if (key === "m") {
    e.preventDefault();
    if (!overChat(s.view) && s.panel === null) setState({ pop: { id: imageMode(s) ? "images" : "picker", kb: true } });
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
  const hydrated = useStore((s) => s.hydrationSettled);
  const drawer = useStore((s) => s.drawer);
  const pageCover = useCovering();
  const setList = useStore((s) => s.setList);
  useReadAloud();
  const popId = useStore((s) => s.pop?.id ?? null);
  const settings = useScreen(settingsScreen, view === "settings");
  const firstRun = useScreen(firstRunScreen, !noServer && view === "firstrun");
  const picker = useScreen(pickerScreen, popId === "picker");
  const imagePicker = useScreen(imagePickerScreen, popId === "images");
  const pickerPending = useStore(s => s.pop?.id === "picker" && !s.pop.ready);
  const popOpen = popId !== null && (popId !== "picker" || picker.kind === "error" || !pickerPending);
  const thread = useScreen(threadScreen, view === "thread" || (overChat(view) && threadId !== null));
  const pics = useScreen(picturesScreen, view === "pictures");
  const panel = useStore((s) => s.panel);
  const usage = useScreen(usageScreen, panel === "usage");
  const phone = useMedia(PHONE);
  // oxlint-disable-next-line gates/effect-needs-reason -- a focus trap on the open sheet's node, held for as long as the sheet is drawn
  useEffect(() => {
    if (popId === null || !isPhone()) return;
    const sheet = document.getElementById(POP_EL[popId]);
    if (sheet !== null) return keepSheetFocus(sheet);
  }, [popId, popOpen]);
  useDocumentEvent("keydown", onKey);
  useDocumentEvent("touchstart", onTouchStart, { passive: true });
  useDocumentEvent("touchend", onTouchEnd, { passive: true });
  useDocumentEvent("mousedown", onMouseDown);
  useDocumentEvent("resize", onResize, { on: "window" });
  useDocumentEvent("hashchange", onHash, { on: "window" });
  // why: the drawer hears a Back before the screens do
  useDocumentEvent("popstate", onDrawerPop, { on: "window" });
  useDocumentEvent("popstate", onScreenPop, { on: "window" });
  const dialog = useStore((s) => settingsDialog(s, phone));
  const section = useStore((s) => s.section);
  const isSet = view === "settings" && !dialog;
  const isPics = view === "pictures";
  const under = isSet || isPics;
  const isNew = view === "new" || threadId === null;
  const covered = noServer || view === "firstrun";
  return (
    <>
      <Sprite />
      <div className={`app${drawer ? " drawer" : ""}`} id="app" data-ready={hydrated ? "" : undefined} inert={(popOpen && phone) || dialog || panel !== null}>
        <div style={{ display: "contents" }} inert={covered || pageCover}>
          <Sidebar />
        </div>
        {drawer ? <div className="scrim" data-testid="sidebar.drawer.scrim" aria-hidden="true" onClick={() => { cancelPendingSettings(); closeDrawer(); }} /> : null}
        <main className="main" inert={covered || drawer || pageCover}>
          {isSet ? <SettingsBar /> : isPics ? null : <Header isNew={isNew} />}
          <div className="work">
            <div className={`stage${under ? " under" : ""}`} inert={under}>
                {isNew || threadId === null ? (
                  <Draft under={under || view === "settings"} />
                ) : (
                  <>
                    <ErrorBoundary key={threadId} scope="thread">
                    {thread.kind === "ready" ? <thread.value.Timeline threadId={threadId} /> : (
                      <div className="tl" aria-busy={thread.kind === "pending" || undefined}>
                        {thread.kind === "error" ? <ScreenError /> : <div className="col"><TurnSkel /></div>}
                      </div>
                    )}
                    </ErrorBoundary>
                    <div className="cw">
                      <div className="banner-slot">
                        {under || view === "settings" ? null : <UpdateNote />}
                        <Banner />
                      </div>
                      <Composer />
                    </div>
                  </>
                )}
            </div>
            {isSet ? (
              <div className={`set${setList ? " listing" : ""}`}>
                <UpdateNote />
                <div className="set-in">
                  <SettingsList />
                  {settings.kind === "ready" ? <settings.value.SettingsView /> : <ScreenError />}
                </div>
              </div>
            ) : null}
            {isPics ? pics.kind === "ready" ? <pics.value.Pictures /> : <div className="pics"><ScreenError /></div> : null}
          </div>
        </main>
        {!isNew && !under && threadId !== null && thread.kind === "ready" ? (
          <div style={{ display: "contents" }} inert={covered || drawer}>
            <thread.value.PagePanel threadId={threadId} />
          </div>
        ) : null}
        {covered ? (
          <div className="first">
            {noServer ? <NoServer /> : firstRun.kind === "ready" ? <firstRun.value.FirstRun /> : firstRun.kind === "error" ? <ScreenError /> : <FirstRunLoading />}
          </div>
        ) : null}
      </div>
      {dialog && section === "models" ? (
        <Dialog label="Models" onClose={leaveSettings}>
          {settings.kind === "ready" ? <settings.value.SettingsView /> : <><DialogHead title="Models" onClose={leaveSettings} /><ScreenError /></>}
        </Dialog>
      ) : dialog ? (
        <Dialog label="Settings" onClose={leaveSettings}>
          <DialogHead title="Settings" onClose={leaveSettings} />
          <div className="dlg-cols">
            <SettingsNav inDialog />
            <div className="dlg-body set">
              <UpdateNote />
              <div className="set-in">{settings.kind === "ready" ? <settings.value.SettingsView /> : <ScreenError />}</div>
            </div>
          </div>
        </Dialog>
      ) : null}
      {panel === "usage" && usage.kind !== "pending" ? (
        <Dialog label="Usage" onClose={() => closeUsage()}>
          {usage.kind === "ready" ? <usage.value.Usage /> : <><DialogHead title="Usage" onClose={() => closeUsage()} /><ScreenError /></>}
        </Dialog>
      ) : null}
      {popOpen ? <div className="scrim pop-scrim" data-testid="ui.pop.scrim" aria-hidden="true" onClick={() => closePop(true)} /> : null}
      {popId === "picker" ? picker.kind === "ready" ? <picker.value.Picker /> : picker.kind === "error" ? <div id="picker" className="model-picker open picker-error" role="dialog" aria-label="Choose a model"><button className="btn" data-testid="models.picker.back-to-chat" onClick={() => closePop(true)}>Back to chat</button><ScreenError /></div> : null : null}
      {popId === "images" ? imagePicker.kind === "ready" ? <imagePicker.value.ImagePicker /> : imagePicker.kind === "error" ? <div id="imagePicker" className="model-picker open picker-error" role="dialog" aria-label="Choose an image model"><button className="btn" data-testid="image.picker.back-to-chat" onClick={() => closePop(true)}>Back to chat</button><ScreenError /></div> : null : null}
      <PlusMenu />
      <CountMenu />
      <ImageUnset />
      <OptsMenu />
      <ThreadMenu />
      <Tip />
      <CommitJobs />
    </>
  );
}
