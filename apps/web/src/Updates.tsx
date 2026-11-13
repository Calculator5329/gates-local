// Eager update surfaces only. Settings controls live in SettingsUpdates.tsx.
import type { UpdateCheck, UpdateStatus } from "@gates-local/contracts";
import { useEffect, useRef, useState } from "react";
import { Icon, type IconId } from "./icons.tsx";
import { canUpdateHere, checkForUpdates, dismissUpdateResult, downloadUpdate, openSettings, readUpdateStatus, updateAndRestart } from "./session.ts";
import { NA, getState, useStore } from "./store.ts";
import { closeTip } from "./ui.tsx";
import { restartable, type UpdateClick, type UpdateIcon, type UpdateInput, outdated, updateIcon } from "./update-state.ts";
import { updateWork, workLines } from "./update-work.ts";

/** A progress ring around a footer icon: a share from 0 to 1, or null for a turning arc. It sits inside the box and never changes it. */
export function Ring({ progress }: { progress: number | null }) {
  return (
    <svg className={`ring${progress === null ? " spin" : ""}`} viewBox="0 0 26 26" aria-hidden="true">
      <circle cx="13" cy="13" r="11" style={{ stroke: "var(--border-strong)" }} />
      <circle cx="13" cy="13" r="11" pathLength={100} strokeDasharray={progress === null ? "25 75" : `${Math.round(progress * 100)} 100`} transform="rotate(-90 13 13)" />
    </svg>
  );
}

export interface FootProps {
  readonly icon: IconId;
  readonly label: string;
  readonly tip: string;
  readonly tone?: "fg" | "red" | "green" | "on";
  readonly dot?: "amber" | "red" | "green" | null;
  readonly ring?: number | null | undefined;
  readonly spin?: boolean;
  /** Busy: focusable and keeps its tooltip, but a click does nothing. */
  readonly busy?: boolean;
  readonly cls?: string;
  readonly current?: boolean;
  /** A toggle (Settings, Models, Usage open and close what they name): aria-pressed, true while that is open. */
  readonly pressed?: boolean;
  readonly onClick: () => void;
}

/** One 32 px footer button: the icon, an optional ring and an optional dot, words only in data-tip and aria-label. */
export function FootButton({ icon, label, tip, tone, dot = null, ring, spin = false, busy = false, cls, current = false, pressed, onClick }: FootProps) {
  const ringed = ring !== undefined;
  return (
    <button
      type="button"
      className={["ibtn", tone, cls].filter(Boolean).join(" ")}
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
  ready: { icon: "refresh", tone: "green" },
  updating: { icon: "spin", spin: true },
  failed: { icon: "alert", tone: "red" },
  external: { icon: "external", tone: "fg" },
};

/** How long the confirm's button waits after its words change, so a click meant for the old words cannot land on the new. */
const SETTLE_MS = 1000;

/** Heard by a screen reader, never seen: the ask's "Changed" note takes no room, so the mark never moves the panel. */
const UNSEEN = { position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" } as const;
const BRIGHT = { color: "var(--foreground)" } as const;

/**
 * The one ask before the app closes: the target, one line for each piece of
 * work the update stops (update-work.ts, the same lines as the installer's
 * native prompt), read fresh from the server when it opens, and what it falls
 * back to. When those lines change while it is open (a new approval, or this
 * window's queue or drafts, read again at Go) the new ones show brighter, a
 * screen reader hears "Changed", and Go waits a moment; nothing installs on
 * that press. before: the lines shown when it last closed for that reason.
 * An installed copy's Restart asks the same way; it goes back by itself when
 * the new version does not start (docs/design/installed-updates.md, 2).
 */
function Confirm({ status, check, before, onCancel, onGo }: { status: UpdateStatus; check: Extract<UpdateCheck, { state: "available" | "newer" }>; before: readonly string[] | null; onCancel: () => void; onGo: (shown: readonly string[]) => void }) {
  const installed = check.state === "newer";
  const cancel = useRef<HTMLButtonElement>(null);
  const goButton = useRef<HTMLButtonElement>(null);
  const lines = () => workLines(updateWork(status.activity));
  // undefined: reading; null: read; a string: the server's words for why it could not
  const [read, setRead] = useState<string | null | undefined>(undefined);
  const [work, setWork] = useState(lines);
  const [prev, setPrev] = useState(before);
  const [settle, setSettle] = useState(before === null ? 0 : 1);
  const [wait, setWait] = useState(before !== null);
  const seen = useRef(status.approval);
  const changed = (next: string[]) => {
    // Go is about to turn off: focus moves to Cancel, never to the page
    if (document.activeElement === goButton.current) cancel.current?.focus();
    setPrev(work);
    setWork(next);
    setSettle((n) => n + 1);
  };
  useEffect(() => {
    cancel.current?.focus();
    void readUpdateStatus().then(setRead);
  }, []);
  useEffect(() => {
    if (status.approval === seen.current) return;
    seen.current = status.approval;
    changed(lines());
  }, [status.approval]);
  useEffect(() => {
    if (settle === 0) return;
    setWait(true);
    const t = window.setTimeout(() => setWait(false), SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [settle]);
  const press = () => {
    const now = lines();
    // a press that lands before the effect above has seen a new approval installs nothing either
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
      <b>Update to {check.target} and restart?</b>
      <ul>
        {work.map((w) => (
          <li key={w} style={fresh.includes(w) ? BRIGHT : undefined}>
            {w}
          </li>
        ))}
        <li>{installed ? `Goes back to ${check.current} if ${check.target} does not start.` : `Falls back to ${check.current} if a step fails.`}</li>
      </ul>
      <span role="status" style={UNSEEN}>
        {wait && prev !== null ? ["Changed:", ...fresh].join(" ") : ""}
      </span>
      {typeof read === "string" ? (
        <p className="act-err" role="alert">
          {read}
        </p>
      ) : null}
      <div className="ca">
        <button ref={cancel} type="button" className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button ref={goButton} type="button" className="btn primary" disabled={read !== null || wait} onClick={press}>
          {installed ? "Restart to update" : "Update and restart"}
        </button>
      </div>
    </div>
  );
}

/** The update icon at the far right of the sidebar footer: always there in the desktop app, absent in a browser tab and on the phone. */
export function SidebarUpdate({ via }: { via: (then: () => void) => void }) {
  const status = useStore((s) => s.update);
  const checking = useStore((s) => s.updateChecking);
  const installing = useStore((s) => s.updateInstalling);
  const error = useStore((s) => s.updateError);
  const drawer = useStore((s) => s.drawer);
  const [asking, setAsking] = useState(false);
  // the lines the ask showed when Go found the approval moved on; it opens again with them as "before"
  const [before, setBefore] = useState<readonly string[] | null>(null);
  const [clickError, setClickError] = useState<UpdateInput["clickError"]>(null);
  const [downloading, setDownloading] = useState(false);
  const button = useRef<HTMLSpanElement>(null);
  const known = status === NA || status === undefined ? null : status;
  const desktop = canUpdateHere();
  const u = updateIcon({ status: known, desktop, checking, installing, error, clickError, downloading, canRestart: restartable(known, desktop) });
  const click = u?.click ?? null;
  // The ask belongs to an Update or Restart click: it closes when the click stops being one, and with the drawer.
  useEffect(() => {
    if (click !== "update" && click !== "restart") setAsking(false);
  }, [click]);
  useEffect(() => {
    if (!drawer) setAsking(false);
  }, [drawer]);
  // once good news has arrived the error is gone for good, so a later state it does not cover cannot bring it back
  const lastCheck = known?.lastCheck;
  useEffect(() => {
    if (clickError != null && outdated(clickError, lastCheck)) setClickError(null);
  }, [clickError, lastCheck]);
  useEffect(() => {
    if (!asking) return;
    const outside = (e: PointerEvent) => {
      if (!(e.target instanceof Element && e.target.closest(".sb-foot .cfm, .sb-foot .upd"))) setAsking(false);
    };
    // Escape closes the top layer only: an open menu or picker (App's onKey), then a tooltip, then the ask, then the drawer
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || getState().pop !== null) return;
      e.stopPropagation();
      if (document.getElementById("tip")?.classList.contains("open")) return closeTip();
      const inside = document.activeElement?.closest(".sb-foot .cfm") != null;
      setAsking(false);
      if (inside) button.current?.querySelector("button")?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [asking]);
  if (u === null) return null;
  const check = known?.lastCheck;
  const approval = known?.approval;
  const focusButton = () => button.current?.querySelector("button")?.focus();
  // the check this footer saw when it clicked: a newer one that answers anywhere clears the click's error (update-state.ts)
  const since = check?.checkedAt ?? null;
  const run: Record<UpdateClick, () => void> = {
    check: () => {
      setClickError(null);
      void checkForUpdates().then((message) => setClickError(message === null ? null : { click: "check", message, since }));
    },
    update: () => {
      closeTip();
      setBefore(null);
      setAsking(!asking);
    },
    // An installed copy that can replace its file: the same one ask, then it closes, updates and reopens.
    restart: () => {
      closeTip();
      setBefore(null);
      setAsking(!asking);
    },
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
    // the shown result goes with the press that acts on it; Cancel left it
    if (dismiss) void dismissUpdateResult();
    await updateAndRestart(shown);
    // Nothing installed and nothing failed: the server's approval moved on, so the one ask shows its new words.
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
          icon={look.icon}
          label={u.label}
          tip={u.tip}
          {...(look.tone === undefined ? {} : { tone: look.tone })}
          dot={u.dot}
          {...(u.state === "downloading" ? { ring: u.progress ?? null } : {})}
          spin={look.spin === true}
          busy={u.busy}
          cls="upd"
          onClick={() => {
            if (u.click === null) return;
            // a shown result goes once the click acts on it; an Update click only asks, so its Go dismisses it
            if (u.dismiss === true && u.click !== "update" && u.click !== "restart") void dismissUpdateResult();
            run[u.click]();
          }}
        />
      </span>
    </>
  );
}
export { UpdateNote, UpdateNoteView } from "./UpdateNote.tsx";
