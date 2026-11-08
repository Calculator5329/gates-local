// Header layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The app shell (shell.md F05, F22, F51): sidebar, one header, the stage
// (new-thread draft or the timeline with the composer docked under it) or
// Settings, the docked GPU panel, first run, popovers and the tooltip layer.
// Global keys follow the design's Escape order: popover, GPU panel, the
// runtime confirm, the download page, then Settings itself.
import type { Message } from "@gates-local/contracts";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useLayoutEffect, useRef } from "react";
import { Banner, rtOf } from "./Banner.tsx";
import { Composer, Picker, PlusMenu } from "./Composer.tsx";
import { GpuPanel, closeGpuPanel, openGpuPanel } from "./FitPanel.tsx";
import { FirstRun, NoServer } from "./FirstRun.tsx";
import { Icon, type IconId, Sprite } from "./icons.tsx";
import { SettingsView } from "./Settings.tsx";
import { Sidebar, focusComposer, goNew, openSearch } from "./Sidebar.tsx";
import { Timeline } from "./Thread.tsx";
import { UpdateNote } from "./Updates.tsx";
import { call, deleteThread, leaveSettings, newThread, openSettings, openThread, renameThread, threadFromHash, threadMarkdown } from "./session.ts";
import { NA, type Section, type State, getState, setState, useStore } from "./store.ts";
import { POP_ANCHOR, Tip, closePop, place, togglePop } from "./ui.tsx";

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
              focusComposer();
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
        {links.map(([go, label]) => (
          <button key={go} type="button" className="link" data-go={go} onClick={() => openSettings(go)}>
            {label}
          </button>
        ))}
      </div>
    </>
  );
}

function Draft() {
  return (
    <div className="draft">
      <div className="draft-in">
        <h1 className="hero">What would you like help with?</h1>
        <p className="hero-sub">Runs locally on your computer. Nothing you type leaves it.</p>
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

function Header({ isNew }: { isNew: boolean }) {
  const threadId = useStore((s) => s.threadId);
  const title = useStore((s) => s.threads.find((t) => t.id === s.threadId)?.title ?? "");
  const renaming = useStore((s) => s.renaming);
  const moreOpen = useStore((s) => s.pop?.id === "more" && s.pop.thread === undefined);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);
  const done = (save: boolean) => {
    const value = input.current?.value.trim() ?? "";
    if (save && threadId !== null && value !== "" && value !== title) void renameThread(threadId, value);
    setState({ renaming: false });
  };
  return (
    <header className="hdr">
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
        <h2 className={isNew ? "muted" : ""}>{isNew ? "New thread" : title}</h2>
      )}
      {isNew ? null : (
        <button type="button" className="ibtn" id="moreBtn" data-tip="Thread actions" aria-label="Thread actions" aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => togglePop("more")}>
          <Icon id="more" />
        </button>
      )}
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

/** A thread-menu item's click: close the menu, then act on its thread (the sidebar row it opened from, or the open thread). */
const act = (fn: (threadId: string) => void) => () => {
  const s = getState();
  const id = s.pop?.thread ?? s.threadId;
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

/** Up, Down, Home and End move between the menu's items. */
function menuKeys(e: ReactKeyboardEvent<HTMLDivElement>): void {
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  const to = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null;
  if (to === null || items.length === 0) return;
  e.preventDefault();
  items[(to + items.length) % items.length]?.focus();
}

function MoreMenu() {
  const pop = useStore((s) => (s.pop?.id === "more" ? s.pop : null));
  const open = pop !== null;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || pop === null) return;
    const anchor = document.getElementById("moreBtn");
    if (pop.at) placeAt(el, pop.at);
    else if (anchor) place(el, anchor, "end", "below");
    if (pop.kb) el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [pop]);
  return (
    <div className={`pop menu${open ? " open" : ""}`} id="moreMenu" role="menu" aria-label="Thread actions" ref={ref} onKeyDown={menuKeys}>
      <button type="button" className="mi" role="menuitem" onClick={act(renameFromMenu)}>
        <Icon id="pencil" />
        <b>Rename</b>
      </button>
      <button type="button" className="mi" role="menuitem" onClick={act((id) => void exportFromMenu(id))}>
        <Icon id="download" />
        <b>Export as Markdown</b>
      </button>
      <button type="button" className="mi" role="menuitem" onClick={act(openGpuPanel)}>
        <Icon id="cpu" />
        <b>GPU memory</b>
      </button>
      <div className="msep" />
      <button type="button" className="mi danger" role="menuitem" onClick={act((id) => void deleteThread(id))}>
        <Icon id="x" />
        <b>Delete thread</b>
      </button>
    </div>
  );
}

function onKey(e: KeyboardEvent): void {
  const s = getState();
  if (e.key === "Escape") {
    if (s.pop !== null) {
      e.preventDefault();
      return closePop(true);
    }
    if (s.fitPanel.open && s.view !== "settings") {
      e.preventDefault();
      return closeGpuPanel(true);
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
  const pop = document.getElementById(p.id === "plus" ? "plusMenu" : p.id === "more" ? "moreMenu" : "picker");
  const anchor = document.getElementById(POP_ANCHOR[p.id]);
  if (pop?.contains(e.target) || anchor?.contains(e.target)) return;
  closePop();
}

const onResize = () => closePop();

function onHash(): void {
  const id = threadFromHash();
  if (id !== null && id !== getState().threadId) openThread(id);
  else if (id === null && getState().view === "thread") newThread();
}

export function App() {
  const view = useStore((s) => s.view);
  const threadId = useStore((s) => s.threadId);
  const noServer = useStore((s) => s.conn.kind === "no-server");
  useEffect(() => {
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("resize", onResize);
    window.addEventListener("hashchange", onHash);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("hashchange", onHash);
    };
  }, []);
  const isSet = view === "settings";
  const isNew = view === "new" || threadId === null;
  // first run covers the app; what is underneath takes no focus or clicks
  const covered = noServer || view === "firstrun";
  return (
    <>
      <Sprite />
      <div className="app" id="app">
        <div style={{ display: "contents" }} inert={covered}>
          <Sidebar />
        </div>
        <main className="main" inert={covered}>
          {isSet ? null : <Header isNew={isNew} />}
          <div className="work">
            {isSet ? (
              <div className="set">
                <div className="set-in">
                  <SettingsView />
                </div>
              </div>
            ) : (
              <div className="stage">
                {isNew || threadId === null ? (
                  <Draft />
                ) : (
                  <>
                    <Timeline threadId={threadId} />
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
            <GpuPanel />
          </div>
        </main>
        {noServer ? (
          <div className="first">
            <NoServer />
          </div>
        ) : view === "firstrun" ? (
          <div className="first">
            <FirstRun />
          </div>
        ) : null}
      </div>
      <Picker />
      <PlusMenu />
      <MoreMenu />
      <Tip />
    </>
  );
}
