// Layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The banner docked above the composer, one per runtime state; its words are words.tsx.
import type { ReactNode } from "react";
import { describeModel, gb } from "../lib/words/format.ts";
import { Icon } from "../lib/ui/icons.tsx";
import { modelNameKey } from "../models/pick.ts";
import { firstModelOffer } from "./first-offer.ts";
import { firstPull, openSettings, pull, recheckRuntime } from "../lib/session/index.ts";
import { NA, type State, useStore, waitingReplies } from "../lib/store/store.ts";
import { booting, FAIL_FALLBACK, failWhy, failWords, INSTALL_TITLE, type InstallSize, installStep, ownCopyNote, portOf, rtOf, searching, STALLED, underTitle, unread, useInstallStall } from "./words.tsx";

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

// why: the switch keeps its own confirm in Settings, so the banner opens it rather than switching
function UseOwnButton() {
  const can = useStore((s) => s.settings !== NA && s.settings !== undefined && s.settings.runtimeMode !== "app" && s.runtime?.noAppCopy !== true && s.unavailable["settings.update"] !== true);
  return can ? <button type="button" className="btn primary" data-testid="chat.banner.use-own" onClick={() => openSettings("runtime", false, true)}>Use Gates Local's Ollama</button> : null;
}

const RetryButton = ({ primary }: { primary?: boolean }) => (
  <button type="button" className={primary ? "btn primary" : "btn outline"} data-testid="chat.banner.retry" onClick={() => void recheckRuntime()}>
    Retry
  </button>
);

const waitsHere = (s: State): boolean => s.threadId !== null && waitingReplies(s).some((q) => q.threadId === s.threadId && q.draw === undefined);

function FirstModel() {
  const entry = useStore(firstModelOffer);
  const downloading = useStore((s) => firstPull(s) !== undefined);
  const catalog = useStore((s) => (s.catalog === NA ? undefined : s.catalog));
  const waits = useStore(waitsHere);
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

function Installing({ install }: { install: InstallSize | undefined }) {
  const { stalled, words, retry } = useInstallStall(install);
  return (
    <Shell icon={stalled ? <Icon id="alert" cls="warn" /> : <Icon id="download" />} role="status" title={INSTALL_TITLE}>
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

export function Banner() {
  const rt = useStore(rtOf);
  const baseUrl = useStore((s) => s.runtime?.baseUrl);
  const detail = useStore((s) => s.runtime?.detail);
  const own = useStore(ownCopyNote);
  const install = useStore((s) => s.runtime?.install);
  const failure = useStore((s) => s.runtime?.failure);
  const firstRun = useStore((s) => s.view === "firstrun");
  const boot = useStore(booting);
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
        <Shell icon={<Icon id="alert" cls="err" />} role="alert" title="Another program is where Ollama should be">
          <div className="bm" data-why={`Another program answers on localhost:${port}.`}>
            Gates Local won't stop it. It can run its own Ollama instead.
          </div>
          <div className="ba">
            <UseOwnButton />
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
          <div className="bm" data-why={failWhy(detail, failure)}>{underTitle(detail, failure) ?? FAIL_FALLBACK[failure ?? "start"]}</div>
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
