import type { UpdateCheck, UpdateStatus } from "@gates-local/contracts";
import { useEffect, useRef, useState } from "react";
import { Icon, type IconId } from "../lib/ui/icons.tsx";
import { canUpdateHere, checkForUpdates, dismissUpdateResult, downloadUpdate, openSettings, readUpdateStatus, updateAndRestart } from "../lib/session/index.ts";
import { NA, getState, useStore } from "../lib/store/store.ts";
import { closeTip, esc } from "../lib/ui/ui.tsx";
import { useDocumentEvent } from "../lib/ui/kit/events.ts";
import { useChange } from "../lib/ui/kit/popover.ts";
import { RESTART, restartable, type UpdateClick, type UpdateIcon, type UpdateInput, outdated, updateIcon, ver } from "./update-state.ts";
import { updateWork, workLines } from "./update-work.ts";

export function Ring({ progress }: { progress: number | null }) {
  return (
    <svg className={`ring${progress === null ? " spin" : ""}`} viewBox="0 0 26 26" aria-hidden="true">
      <circle cx="13" cy="13" r="11" style={{ stroke: "var(--border-strong)" }} />
      <circle cx="13" cy="13" r="11" pathLength={100} strokeDasharray={progress === null ? "25 75" : `${Math.round(progress * 100)} 100`} transform="rotate(-90 13 13)" />
    </svg>
  );
}

export interface FootProps {
  readonly testId: `sidebar.foot.${string}`;
  readonly icon: IconId;
  readonly label: string;
  readonly tip: string;
  readonly tone?: "fg" | "red" | "green" | "on";
  readonly dot?: "amber" | "red" | "green" | null;
  readonly ring?: number | null | undefined;
  readonly spin?: boolean;
  readonly busy?: boolean;
  readonly cls?: string;
  readonly current?: boolean;
  readonly pressed?: boolean;
  readonly onClick: () => void;
}

export function FootButton({ testId, icon, label, tip, tone, dot = null, ring, spin = false, busy = false, cls, current = false, pressed, onClick }: FootProps) {
  const ringed = ring !== undefined;
  return (
    <button
      type="button"
      className={["ibtn", tone, cls].filter(Boolean).join(" ")}
      data-testid={testId}
      aria-label={label}
      data-tip={tip}
      aria-disabled={busy || undefined}
      aria-current={current ? "page" : undefined}
      aria-pressed={pressed}
      onClick={busy ? undefined : onClick}
    >
      {ringed ? <Ring progress={ring} /> : null}
      <Icon id={icon} cls={ringed ? "s12" : spin ? "spin" : undefined} />
      {dot === null ? null : <span className={`fdot ${dot}`} />}
    </button>
  );
}

const LOOK: Record<UpdateIcon["state"], { icon: IconId; tone?: FootProps["tone"]; spin?: boolean }> = {
  idle: { icon: "refresh" },
  checking: { icon: "refresh", spin: true },
  available: { icon: "fetch", tone: "fg" },
  downloading: { icon: "fetch", tone: "fg" },
  ready: { icon: "up", tone: "green" },
  waiting: { icon: "up", tone: "fg" },
  updating: { icon: "spin", spin: true },
  failed: { icon: "alert", tone: "red" },
  external: { icon: "external", tone: "fg" },
};

const SETTLE_MS = 1000;

const UNSEEN = { position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" } as const;
const BRIGHT = { color: "var(--foreground)" } as const;

function Confirm({ status, check, before, onCancel, onGo }: { status: UpdateStatus; check: Extract<UpdateCheck, { state: "available" | "newer" }>; before: readonly string[] | null; onCancel: () => void; onGo: (shown: readonly string[]) => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  const goButton = useRef<HTMLButtonElement>(null);
  const lines = () => workLines(updateWork(status.activity));
  const [read, setRead] = useState<string | null | undefined>(undefined);
  const [work, setWork] = useState(lines);
  const [prev, setPrev] = useState(before);
  const [settle, setSettle] = useState(before === null ? 0 : 1);
  const [wait, setWait] = useState(before !== null);
  const seen = useRef(status.approval);
  const changed = (next: string[]) => {
    if (document.activeElement === goButton.current) cancel.current?.focus();
    setPrev(work);
    setWork(next);
    setSettle((n) => n + 1);
  };
  // oxlint-disable-next-line gates/effect-needs-reason -- the ask opens from several places; on its mount Cancel takes focus and the status is read once
  useEffect(() => {
    cancel.current?.focus();
    void readUpdateStatus().then(setRead);
  }, []);
  // oxlint-disable-next-line gates/effect-needs-reason -- a new approval arrives pushed from the server while the ask is open; changed() also moves focus off Go, which a render cannot do
  useEffect(() => {
    if (status.approval === seen.current) return;
    seen.current = status.approval;
    changed(lines());
  }, [status.approval]);
  // oxlint-disable-next-line gates/effect-needs-reason -- holds Go off for a moment after the list changed, and drops the timer on the next change or unmount
  useEffect(() => {
    if (settle === 0) return;
    setWait(true);
    // oxlint-disable-next-line gates/timer-needs-reason -- the pause that lets a changed list be read before Go works again
    const t = window.setTimeout(() => setWait(false), SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [settle]);
  const press = () => {
    const now = lines();
    if (status.approval !== seen.current) {
      seen.current = status.approval;
      return changed(now);
    }
    if (now.join("\n") !== work.join("\n")) return changed(now);
    onGo(work);
  };
  const fresh = wait && prev !== null ? work.filter((w) => !prev.includes(w)) : [];
  return (
    <div className="cfm" role="group" aria-label="Confirm update">
      <b>Update to {ver(check.target)} and restart?</b>
      {work.length === 0 ? null : (
        <ul>
          {work.map((w) => (
            <li key={w} style={fresh.includes(w) ? BRIGHT : undefined}>
              {w}
            </li>
          ))}
        </ul>
      )}
      <span role="status" style={UNSEEN}>
        {wait && prev !== null ? ["Changed:", ...fresh].join(" ") : ""}
      </span>
      {typeof read === "string" ? (
        <p className="act-err" role="alert">
          {read}
        </p>
      ) : null}
      <div className="ca">
        <button ref={cancel} type="button" className="btn ghost" data-testid="sidebar.update.cancel" onClick={onCancel}>
          Cancel
        </button>
        <button ref={goButton} type="button" className="btn primary" data-testid="sidebar.update.go" disabled={read !== null || wait} onClick={press}>
          {RESTART}
        </button>
      </div>
    </div>
  );
}

export function SidebarUpdate({ via }: { via: (then: () => void) => void }) {
  const status = useStore((s) => s.update);
  const checking = useStore((s) => s.updateChecking);
  const installing = useStore((s) => s.updateInstalling);
  const error = useStore((s) => s.updateError);
  const drawer = useStore((s) => s.drawer);
  const [asking, setAsking] = useState(false);
  const [before, setBefore] = useState<readonly string[] | null>(null);
  const [clickError, setClickError] = useState<UpdateInput["clickError"]>(null);
  const [downloading, setDownloading] = useState(false);
  const button = useRef<HTMLSpanElement>(null);
  const known = status === NA || status === undefined ? null : status;
  const desktop = canUpdateHere();
  const u = updateIcon({ status: known, desktop, checking, installing, error, clickError, downloading, canRestart: restartable(known, desktop) });
  const click = u?.click ?? null;
  useChange(click, (now) => { if (now !== "update" && now !== "restart") setAsking(false); });
  useChange(drawer, (now) => { if (!now) setAsking(false); });
  const lastCheck = known?.lastCheck;
  if (clickError != null && outdated(clickError, lastCheck)) setClickError(null);
  useDocumentEvent("pointerdown", (e) => {
    if (!(e.target instanceof Element && e.target.closest(".sb-foot .cfm, .sb-foot .upd"))) setAsking(false);
  }, { capture: true, when: asking });
  useDocumentEvent("keydown", (e) => {
    if (e.key !== "Escape" || getState().pop !== null) return;
    e.stopPropagation();
    if (document.getElementById("tip")?.classList.contains("open")) return closeTip();
    const inside = document.activeElement?.closest(".sb-foot .cfm") != null;
    setAsking(false);
    if (inside) button.current?.querySelector("button")?.focus();
  }, { capture: true, when: asking });
  if (u === null) return null;
  const check = known?.lastCheck;
  const approval = known?.approval;
  const focusButton = () => button.current?.querySelector("button")?.focus();
  const since = check?.checkedAt ?? null;
  const restart = async () => {
    closeTip();
    setBefore(null);
    if (asking) return setAsking(false);
    const read = await readUpdateStatus();
    const s = getState();
    const now = s.update === NA ? undefined : s.update;
    const idle = read === null && now?.activity !== undefined && now.activity.length === 0;
    if (idle && now?.approval !== undefined) return void go(now.approval, workLines(updateWork(now.activity)), u.dismiss === true);
    setAsking(true);
  };
  const run: Record<UpdateClick, () => void> = {
    check: () => {
      setClickError(null);
      void checkForUpdates().then((message) => setClickError(message === null ? null : { click: "check", message, since }));
    },
    update: () => void restart(),
    restart: () => void restart(),
    download: () => {
      setClickError(null);
      setDownloading(true);
      void downloadUpdate().then((message) => {
        setDownloading(false);
        if (message !== null) setClickError({ click: "download", message, since });
      });
    },
    page: () => {
      if (u.page !== undefined) window.open(u.page, "_blank", "noopener,noreferrer");
    },
    settings: () => via(() => openSettings("general")),
  };
  const go = async (shown: string, lines: readonly string[], dismiss: boolean) => {
    setAsking(false);
    focusButton();
    if (dismiss) void dismissUpdateResult();
    await updateAndRestart(shown);
    const s = getState();
    const now = s.update === NA ? undefined : s.update;
    const again = now?.lastCheck?.state === "available" || (now?.lastCheck?.state === "newer" && now.lastCheck.restart === true);
    if (!s.updateInstalling && s.updateError === null && now?.approval !== undefined && now.approval !== shown && again) {
      setBefore(lines);
      setAsking(true);
    }
  };
  const look = LOOK[u.state];
  return (
    <>
      {asking && known !== null && approval !== undefined && ((u.click === "update" && check?.state === "available") || (u.click === "restart" && check?.state === "newer")) ? (
        <Confirm
          status={known}
          check={check}
          before={before}
          onCancel={() => {
            setAsking(false);
            focusButton();
          }}
          onGo={(lines) => void go(approval, lines, u.dismiss === true)}
        />
      ) : null}
      <span ref={button} className="end">
        <FootButton
          testId="sidebar.foot.update"
          icon={look.icon}
          label={u.label}
          tip={esc(u.label)}
          {...(look.tone === undefined ? {} : { tone: look.tone })}
          dot={u.dot}
          {...(u.state === "downloading" ? { ring: u.progress ?? null } : {})}
          spin={look.spin === true}
          busy={u.busy}
          cls="upd"
          onClick={() => {
            if (u.click === null) return;
            if (u.dismiss === true && u.click !== "update" && u.click !== "restart") void dismissUpdateResult();
            run[u.click]();
          }}
        />
      </span>
    </>
  );
}
export { UpdateNote, UpdateNoteView } from "./UpdateNote.tsx";
