// Layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The banner docked above the composer, one per runtime state; its words are words.tsx.
import type { ReactNode } from "react";
import type { CatalogEntry } from "@gates-local/contracts";
import { describeModel, gb } from "../lib/words/format.ts";
import { rowOf } from "../fit/fit-table.ts";
import { Icon } from "../lib/ui/icons.tsx";
import { canChat, chatBlockedReason, modelNameKey } from "../models/pick.ts";
import { firstPull, pull, recheckRuntime } from "../lib/session/index.ts";
import { NA, type State, useStore } from "../lib/store/store.ts";
import { booting, FAIL_FALLBACK, failWords, INSTALL_TITLE, type InstallSize, installStep, ownCopyNote, portOf, rtOf, searching, STALLED, underTitle, unread, useInstallStall } from "./words.tsx";

function Shell({ icon, role, title, children }: { icon: ReactNode; role: "status" | "alert"; title: string; children: ReactNode }) {
  return (
    <div className="banner" role={role}>
      {icon}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="bt">{title}</div>
        {children}
      </div>
    </div>
  );
}

const RetryButton = ({ primary }: { primary?: boolean }) => (
  <button type="button" className={primary ? "btn primary" : "btn outline"} data-testid="chat.banner.retry" onClick={() => void recheckRuntime()}>
    Retry
  </button>
);

/** The model to recommend when none is installed: the first pick of the computer's tier that runs here. */
export function recommendedEntry(s: State): CatalogEntry | undefined {
  if (s.catalog === NA || s.catalog === undefined) return undefined;
  const picks = s.catalog.filter((c) => c.recommended).toSorted((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return picks.find((c) => rowOf(s, c.name)?.verdict !== "refuse") ?? picks[0];
}

/**
 * The first model to offer, read from the state and never from a stored flag: Ollama answers, its
 * list is in and holds no chat model, and a download here would give one. Undefined otherwise (an
 * Ollama too old to say which models chat, a build that cannot download).
 */
export function firstModelOffer(s: State): CatalogEntry | undefined {
  if (s.runtime?.state !== "ready" || s.models === undefined || s.models.some(canChat)) return undefined;
  if (chatBlockedReason(s.models, undefined) !== undefined || s.unavailable["models.pull"] === true) return undefined;
  return recommendedEntry(s);
}

/** A message in the open chat that waits for a chat model (a picture does not). */
const waitsHere = (s: State): boolean => s.threadId !== null && s.queued.some((q) => q.threadId === s.threadId && q.draw === undefined);

/**
 * Ollama is ready with no chat model: the first window's offer, in its words and sizes, wherever
 * the person is (first run left early, the new chat, a message waiting), until a model exists.
 * Once its download runs the model button's bar and a waiting message's row show it, so the
 * banner says nothing more.
 */
function FirstModel() {
  const entry = useStore(firstModelOffer);
  const downloading = useStore((s) => firstPull(s) !== undefined);
  const catalog = useStore((s) => (s.catalog === NA ? undefined : s.catalog));
  const waits = useStore(waitsHere);
  // the last try at this model ended in an error: said once, as the Models chip says it
  const failed = useStore((s) => entry !== undefined && Object.values(s.pulls).some((p) => p.state === "error" && modelNameKey(p.name.trim()) === modelNameKey(entry.name)));
  if (entry === undefined || downloading) return null;
  const name = describeModel(entry.name, catalog).name;
  return (
    <Shell icon={<Icon id="download" />} role="status" title={waits ? "Your message waits for a model" : "Download your first model"}>
      <div className="bm">
        {failed ? `${name} did not finish downloading.` : name}
        <span className="fig"> · {gb(entry.downloadBytes)} download</span>
      </div>
      <div className="ba">
        <button type="button" className="btn primary" data-testid="chat.banner.first-model" onClick={() => void pull(entry.name)}>
          Download and start
        </button>
      </div>
    </Shell>
  );
}

/** The engine install: the step and its numbers as the first window says them; a stalled download says so and shows Retry. */
function Installing({ install }: { install: InstallSize | undefined }) {
  const { stalled, words, retry } = useInstallStall(install);
  return (
    <Shell icon={stalled ? <Icon id="alert" cls="warn" /> : <Icon id="download" />} role="status" title={INSTALL_TITLE}>
      {/* words in full, figures in the app's font */}
      <div className="bm">
        {stalled ? STALLED : installStep(install)}
        {words === undefined ? null : <span className="fig"> · {words}</span>}
      </div>
      {stalled ? (
        <div className="ba">
          <button type="button" className="btn primary" data-testid="chat.banner.retry-install" onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}
    </Shell>
  );
}

/** The banner for the current runtime state; nothing when chat is ready and a chat model is in. */
export function Banner() {
  const rt = useStore(rtOf);
  const baseUrl = useStore((s) => s.runtime?.baseUrl);
  const detail = useStore((s) => s.runtime?.detail);
  const own = useStore(ownCopyNote);
  const install = useStore((s) => s.runtime?.install);
  const failure = useStore((s) => s.runtime?.failure);
  // first run tells the runtime story itself; the banner under it stays quiet
  const firstRun = useStore((s) => s.view === "firstrun");
  const boot = useStore(booting);
  // nothing read yet: the composer says Connecting, once
  const none = useStore(unread);
  const looking = useStore(searching);
  const port = portOf(baseUrl);
  if (firstRun || boot || none) return null;
  switch (rt) {
    case "ready":
      return <FirstModel />;
    case "installing":
      return <Installing install={install} />;
    case "wrong":
      return (
        <Shell icon={<Icon id="alert" cls="err" />} role="alert" title={`Port ${port} answers, but not as Ollama`}>
          <div className="bm">
            Another service holds <span className="mono">localhost:{port}</span> and doesn't speak the Ollama API. Gates Local won't stop it.
          </div>
          <div className="ba">
            <RetryButton />
          </div>
        </Shell>
      );
    case "starting":
      return looking ? (
        <Shell icon={<Icon id="spin" cls="spin warn" />} role="status" title="Looking for Ollama">
          <div className="bm">
            Checking <span className="mono">localhost:{port}</span>.
          </div>
        </Shell>
      ) : (
        <Shell icon={<Icon id="spin" cls="spin warn" />} role="status" title="Starting Ollama">
          <div className="bm">
            Waiting for <span className="mono">localhost:{port}</span>. The first start after boot takes a few seconds.
          </div>
        </Shell>
      );
    case "missing":
      return (
        <Shell icon={<Icon id="alert" cls="warn" />} role="alert" title="Ollama isn't installed">
          <div className="bm">
            {own === "" ? "" : `${own} `}Install Ollama from ollama.com, then retry.
          </div>
          <div className="ba">
            <RetryButton primary />
          </div>
        </Shell>
      );
    case "stopped":
      return (
        <Shell icon={<Icon id="alert" cls="warn" />} role="alert" title="Ollama isn't running">
          {own === "" ? (
            <div className="bm">
              Nothing answers on <span className="mono">localhost:{port}</span>. Start Ollama, then retry.
            </div>
          ) : (
            <div className="bm">{own} It starts when Gates Local opens; retry to check again.</div>
          )}
          <div className="ba">
            <RetryButton primary />
          </div>
        </Shell>
      );
    case "error":
      return (
        <Shell icon={<Icon id="alert" cls="err" />} role="alert" title={failWords(failure).title}>
          <div className="bm">{underTitle(detail, failure) ?? FAIL_FALLBACK[failure ?? "start"]}</div>
          <div className="ba">
            <RetryButton primary />
          </div>
        </Shell>
      );
    case "offline":
      return (
        <Shell icon={<Icon id="spin" cls="spin warn" />} role="status" title="Reconnecting to Gates Local">
          <div className="bm">The app's server stopped answering. Your threads are saved; chat picks up when it's back.</div>
        </Shell>
      );
  }
}
