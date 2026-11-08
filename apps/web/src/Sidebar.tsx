// Layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The sidebar (shell.md F05, F33): thread list grouped by day with search, or
// the Settings section nav, and the footer with the download and runtime rows.
import { Fragment, type KeyboardEvent, type MouseEvent, useEffect, useState } from "react";
import { rtInfo, rtOf } from "./Banner.tsx";
import { describeModel, gb, when } from "./format.ts";
import { Icon, type IconId } from "./icons.tsx";
import { leaveSettings, newThread, openSettings, openThread } from "./session.ts";
import { NA, type Section, type State, getState, setState, streaming, useStore } from "./store.ts";
import { closeTip, esc } from "./ui.tsx";

export const SECTIONS: readonly (readonly [Section, string, IconId])[] = [
  ["general", "General", "sliders"],
  ["models", "Models", "cpu"],
  ["library", "Library", "folder"],
  ["tools", "Tools", "wrench"],
  ["images", "Image generation", "image"],
  ["runtime", "Runtime", "server"],
  ["advanced", "Advanced", "gear"],
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

export function focusComposer(): void {
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>("#ta")?.focus());
}

export function goNew(): void {
  newThread();
  focusComposer();
}

/** Ctrl K and the Search button: show the search field (leaving Settings first). */
export function openSearch(): void {
  const s = getState();
  if (s.view === "firstrun") return;
  if (s.view === "settings") leaveSettings();
  setState({ searchOpen: true });
  requestAnimationFrame(() => document.querySelector<HTMLInputElement>("#searchIn")?.focus());
}

const closeSearch = () => setState({ searchOpen: false, search: "" });

/** The thread menu (the header's ⋯ menu) for a sidebar row, at a point. */
function openThreadMenu(thread: string, at: { x: number; y: number }, kb: boolean): void {
  closeTip();
  setState({ pop: { id: "more", kb, thread, at } });
}

function rowMenuKey(e: KeyboardEvent<HTMLButtonElement>, thread: string): void {
  if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
  e.preventDefault();
  const r = e.currentTarget.getBoundingClientRect();
  openThreadMenu(thread, { x: r.left + 12, y: r.bottom }, true);
}

function rowMenuClick(e: MouseEvent<HTMLButtonElement>, thread: string): void {
  e.preventDefault();
  const p = getState().pop;
  // the context-menu key also sends this event after its keydown opened the menu
  if (p?.thread === thread && p.kb) return;
  openThreadMenu(thread, { x: e.clientX, y: e.clientY }, false);
}
const liveThreadOf = (s: State) => (streaming(s) ? (s.live?.threadId ?? null) : null);

function ThreadList() {
  const threads = useStore((s) => s.threads);
  const q = useStore((s) => s.search.trim().toLowerCase());
  const on = useStore((s) => (s.view === "thread" ? s.threadId : null));
  const live = useStore(liveThreadOf);
  // the row whose thread menu is open stays marked while the menu acts on it
  const menuFor = useStore((s) => (s.pop?.id === "more" ? (s.pop.thread ?? null) : null));
  const now = useNow(30_000);
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
            <button
              type="button"
              className={`sb-row${on === t.id ? " on" : ""}`}
              data-thread={t.id}
              data-tipt={t.title}
              aria-haspopup="menu"
              aria-expanded={menuFor === t.id}
              onClick={() => openThread(t.id)}
              onContextMenu={(e) => rowMenuClick(e, t.id)}
              onKeyDown={(e) => rowMenuKey(e, t.id)}
            >
              <span className="t">{t.title}</span>
              {live === t.id ? <span className="live" aria-label="Reply in progress" /> : <span className="ago">{w.ago}</span>}
            </button>
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
        <button type="button" className="sb-act back" onClick={leaveSettings}>
          <Icon id="left" />
          <span className="grow">Back to chat</span>
          <span className="ks">Esc</span>
        </button>
        {SECTIONS.map(([id, label, icon]) => (
          <button key={id} type="button" className={`sb-act${section === id ? " on" : ""}${id === "runtime" ? " gap" : ""}`} onClick={() => openSettings(id)}>
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
  const tip = `<b>${esc(name)}</b> · ${p.totalBytes ? `${gb(p.completedBytes).replace(" GB", "")} of ${gb(p.totalBytes)}` : "starting"}. Opens the downloads in Settings.`;
  return (
    <button type="button" className="rt" data-tip={tip} onClick={() => openSettings("models", true)}>
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
    <button type="button" className="rt" data-tip={info.tip} onClick={() => openSettings("runtime")}>
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
      {inSettings ? null : (
        <div className="sb-head">
          <svg className="mark" aria-hidden="true">
            <use href="#i-mark" />
          </svg>
          <span className="wordmark">Gates Local</span>
        </div>
      )}
      {inSettings ? <SettingsNav /> : <ChatNav />}
      <div className="sb-foot">
        <DownloadRow />
        <RuntimeRow />
        {inSettings ? null : (
          <button type="button" className="sb-set" onClick={() => openSettings()}>
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
