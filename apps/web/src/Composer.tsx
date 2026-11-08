// Layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The composer (shell.md F01, F02, F15, F28-F31, F34, F37b, F43b): the text
// box, model and context chips, Thinking and Image pills, the context meter,
// Send or Stop, and the popovers it opens (model picker, + menu).
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ModelInfo } from "@gates-local/contracts";
import { PLACEHOLDER, rtOf } from "./Banner.tsx";
import { closeFit, openFit } from "./FitPanel.tsx";
import { type Verdict, ctxFor, describeModel, gb, k, modelFacts, verdictOf } from "./format.ts";
import { Icon, SendArrow } from "./icons.tsx";
import { canThink, chatBlockedReason, chatModels } from "./pick.ts";
import { focusComposer } from "./Sidebar.tsx";
import { ensureFit, firstPull, openSettings, pickModel, queueReason, send, stop } from "./session.ts";
import { NA, type State, fitKey, getState, setState, streaming, useStore } from "./store.ts";
import { VLabel, closePop, closeTip, esc, place, togglePop } from "./ui.tsx";

const catalogOf = (s: Pick<State, "catalog">) => (s.catalog === NA ? undefined : s.catalog);
const imageGenOf = (s: State) => s.settings !== NA && s.settings?.imageGen === true;
const pctOf = (done: number, total: number | undefined) => (total ? Math.round((done / total) * 100) : 0);

/** Tokens the open thread holds: the last reply's prompt plus its answer. */
function usedTokens(s: State): number {
  if (s.view !== "thread" || s.threadId === null) return 0;
  const last = (s.messages[s.threadId] ?? []).findLast((m) => m.role === "assistant" && m.stats !== undefined);
  return (last?.stats?.promptTokens ?? 0) + (last?.stats?.completionTokens ?? 0);
}

function verdictFor(s: Pick<State, "fits" | "numCtx">, model: string): Verdict | undefined {
  const r = s.fits[fitKey(model, s.numCtx)];
  return r === undefined || r === "error" ? undefined : verdictOf(r);
}

/**
 * Why the Thinking pill cannot be used now, or null when it can. It
 * depends on the model's "thinking" capability, so it waits for a chat
 * model to be installed (F70) and greys for a model without it.
 */
export function thinkUnavailable(model: ModelInfo | undefined, name: string, downloading: boolean): string | null {
  if (downloading || model === undefined) return "Available when the model finishes downloading.";
  if (!canThink(model)) return `<b>Thinking</b> is not available: ${esc(name)} does not reason before answering. Pick a model that does, such as Qwen 3.5 9B.`;
  return null;
}

function tagTip(name: string, m: ModelInfo | undefined, tag: string): string {
  const q = modelFacts(m).quant;
  return `<b>${esc(name)}</b> · <span class="mono">${esc(tag)}</span>${q ? ` · ${esc(q)}` : ""}`;
}

export function Composer() {
  const rt = useStore(rtOf);
  const model = useStore((s) => s.model);
  const numCtx = useStore((s) => s.numCtx);
  const think = useStore((s) => s.think);
  const image = useStore((s) => s.image);
  const draft = useStore((s) => s.draft);
  const notice = useStore((s) => s.notice);
  const fit = useStore((s) => (s.model === undefined ? undefined : s.fits[fitKey(s.model, s.numCtx)]));
  const models = useStore((s) => s.models);
  const catalog = useStore(catalogOf);
  const imageGen = useStore(imageGenOf);
  const isStreaming = useStore(streaming);
  const wait = useStore(queueReason);
  const first = useStore(firstPull);
  const firstProgress = useStore((s) => {
    const p = first === undefined ? undefined : s.pulls[first];
    return p ? pctOf(p.completedBytes, p.totalBytes) : 0;
  });
  const loadState = useStore((s) => (s.model === undefined ? undefined : s.loads[s.model]?.state));
  const used = useStore(usedTokens);
  const pop = useStore((s) => s.pop?.id ?? null);
  const fitOpen = useStore((s) => s.fitPanel.open);
  const view = useStore((s) => s.view);
  const ta = useRef<HTMLTextAreaElement>(null);

  const ready = rt === "ready";
  useEffect(() => {
    if (ready) ensureFit(model, numCtx);
  }, [ready, model, numCtx, fit]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [draft]);

  const blocked = !ready;
  const queueable = wait !== null;
  const shownTag = first ?? model;
  const info = models?.find((m) => m.name === shownTag);
  const name = shownTag === undefined ? "No model" : describeModel(shownTag, catalog).name;
  const v = fit === undefined || fit === "error" ? undefined : verdictOf(fit);
  const text = draft.trim();
  const why = chatBlockedReason(models, model); // a download would not help: old Ollama, or the model is still being checked
  const noModel = (model === undefined || why !== undefined) && !queueable;
  // During setup the gate style already greys every control; otherwise the pill says why it is off.
  const thinkNa = blocked ? null : thinkUnavailable(models?.find((m) => m.name === model), name, first !== undefined);

  const modelLbl =
    rt === "installing" ? `${name} · downloads next` : first !== undefined ? `${name} · downloading ${firstProgress}%` : loadState === "loading" ? `${name} · loading` : name;
  const modelTip =
    shownTag === undefined
      ? "No model is installed yet. Download one in Settings › Models."
      : loadState === "loading"
        ? `${tagTip(name, info, shownTag)}<br>Loading into GPU memory…`
        : `${tagTip(name, info, shownTag)}${info ? ` · ${gb(info.sizeBytes)} on disk` : ""}`;

  const ctx = ctxFor(numCtx, models, model);
  const pct = Math.min(1, used / ctx);
  const meterHidden = pct < 0.5 || blocked || view !== "thread";

  const placeholder = first !== undefined && !blocked ? "Type now; it sends when the download finishes" : noModel && ready ? (why ?? "Download a model to start chatting") : PLACEHOLDER[rt];

  let sendTip = "Send (Enter)";
  if (queueable) sendTip = `${text ? "Send (Enter). It goes out when " : "Type now; it sends when "}${wait === "download" ? "the download finishes" : "setup finishes"}`;
  else if (blocked) sendTip = "Chat starts when Ollama is ready";
  else if (noModel) sendTip = why ?? "Download a model to start chatting";
  else if (v?.k === "no") sendTip = `${esc(name)}: not enough memory at ${k(ctx)}. It needs an estimated ${gb(v.amt)} more. Pick a smaller model or context.`;
  else if (!text) sendTip = "Type a message to send";
  const sendDisabled = (blocked && !queueable) || (!blocked && v?.k === "no") || noModel || !text;

  const submit = () => {
    if (isStreaming) return stop();
    if (sendDisabled) return;
    void send(draft);
  };

  return (
    <>
      <form
        className={`composer${blocked ? " blocked" : ""}`}
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="att" />
        <textarea
          ref={ta}
          id="ta"
          className="ta"
          rows={1}
          placeholder={placeholder}
          aria-label="Message"
          value={draft}
          onChange={(e) => setState({ draft: e.target.value, notice: null })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!isStreaming) submit();
            }
          }}
        />
        <div className="cf">
          <div className="cf-l">
            <button
              type="button"
              className="ctl sq gate"
              id="plusBtn"
              aria-haspopup="menu"
              aria-expanded={pop === "plus"}
              aria-label="Add"
              data-tip="Attach a file, add to your library, images"
              onClick={() => togglePop("plus")}
            >
              <Icon id="plus" />
            </button>
            <button
              type="button"
              className="ctl gate"
              id="modelBtn"
              aria-haspopup="dialog"
              aria-expanded={pop === "picker"}
              data-tip={modelTip}
              onClick={() => togglePop("picker")}
            >
              <span>{modelLbl}</span>
              <Icon id="down" cls="chev" />
            </button>
            <button
              type="button"
              className="ctl gate"
              id="fitBtn"
              aria-haspopup="dialog"
              aria-expanded={fitOpen}
              data-tip={
                blocked
                  ? "GPU memory is checked once Ollama is ready."
                  : v === undefined
                    ? "Checking GPU memory…"
                    : `<b>${esc(name)}</b> at ${k(ctx)}: ${v.word.replace(/ at \d+k$/, "")}. Click for GPU memory.`
              }
              onClick={() => {
                const s = getState();
                if (s.fitPanel.open && s.fitPanel.model !== null) openFit();
                else if (s.fitPanel.open) closeFit(false);
                else openFit();
              }}
            >
              <span className={`vd ${blocked || v === undefined ? "off" : v.k}`} />
              <span className="tab">
                {k(ctx)}
                {!blocked && v !== undefined ? (
                  <>
                    {" · "}
                    <span className={`vtxt ${v.k}`}>{v.chip}</span>
                  </>
                ) : null}
              </span>
              <Icon id="down" cls="chev" />
            </button>
            <button
              type="button"
              className={`pill gate${thinkNa !== null ? " unavail" : ""}`}
              aria-pressed={thinkNa !== null ? false : think}
              aria-label="Thinking"
              aria-disabled={thinkNa !== null ? true : undefined}
              data-tip={
                thinkNa ??
                (think
                  ? "<b>Thinking on.</b> The model reasons first; shown as one collapsed line. Click to turn off."
                  : "<b>Thinking off.</b> Faster first token. Click to turn on.")
              }
              onClick={() => {
                if (thinkNa !== null) return;
                setState({ think: !think });
                closeTip();
              }}
            >
              <Icon id="bulb" cls="lead" />
              <span className="plbl">Thinking</span>
            </button>
            {imageGen ? (
              <button
                type="button"
                className="pill gate"
                aria-pressed={image}
                aria-label="Image"
                data-tip={
                  image
                    ? "<b>Image on.</b> The model may queue a ComfyUI job on this GPU. Click to turn off."
                    : "<b>Image off.</b> Click to let the model make images for this chat."
                }
                onClick={() => {
                  setState({ image: !image });
                  closeTip();
                }}
              >
                <Icon id="image" cls="lead" />
                <span className="plbl">Image</span>
              </button>
            ) : null}
            {meterHidden ? null : (
              <button
                type="button"
                className={`meter${pct > 0.85 ? " hi" : ""}`}
                aria-label="Context used"
                data-tip={`Context used: ${(used / 1000).toFixed(1)}k of ${k(ctx)} tokens`}
              >
                <span>Context {Math.round(pct * 100)}% used</span>
              </button>
            )}
          </div>
          <div className="cf-r">
            {isStreaming ? (
              <button type="submit" className="send stop" aria-label="Stop" data-tip="Stop">
                <span className="sqr" />
              </button>
            ) : (
              <button type="submit" className="send" aria-label="Send message" data-tip={sendTip} disabled={sendDisabled}>
                <SendArrow />
              </button>
            )}
          </div>
        </div>
      </form>
      {notice !== null ? (
        <p className="na c-note" role="status">
          {notice}
        </p>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- + menu

export function PlusMenu() {
  const open = useStore((s) => s.pop?.id === "plus");
  const imageGen = useStore(imageGenOf);
  const image = useStore((s) => s.image);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const anchor = document.getElementById("plusBtn");
    if (open && ref.current && anchor) place(ref.current, anchor, "start");
  }, [open]);
  return (
    <div className={`pop menu${open ? " open" : ""}`} id="plusMenu" role="menu" ref={ref}>
      <button type="button" className="mi" role="menuitem" aria-disabled="true" data-attach>
        <Icon id="clip" />
        <span>
          <b>Attach a file</b>
          <small>Not available in this build</small>
        </span>
      </button>
      <button
        type="button"
        className="mi"
        role="menuitem"
        data-lib
        onClick={() => {
          closePop();
          openSettings("library");
        }}
      >
        <Icon id="book" />
        <span>
          <b>Add to library…</b>
          <small>Stays for every chat</small>
        </span>
      </button>
      <div className="msep" />
      {imageGen ? (
        <button
          type="button"
          className="mi"
          role="menuitemcheckbox"
          aria-checked={image}
          data-gen
          onClick={() => {
            closePop();
            setState({ image: !image });
          }}
        >
          <Icon id="image" />
          <span>
            <b>Generate image</b>
            <small>ComfyUI on this GPU, for this chat</small>
          </span>
          <Icon id="check" cls="chk" />
        </button>
      ) : (
        <button
          type="button"
          className="mi"
          role="menuitem"
          data-gen
          onClick={() => {
            closePop();
            openSettings("images");
          }}
        >
          <Icon id="image" />
          <span>
            <b>Set up image generation…</b>
            <small>Off until you set it up</small>
          </span>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- model picker

interface Row {
  readonly tag: string;
  readonly name: string;
  readonly purpose: string;
  readonly v: Verdict | undefined;
  readonly downloading?: number;
  readonly info: ModelInfo | undefined;
}

const GROUPS = ["gpu", "spill", "no", "unknown"] as const;
type GroupKey = (typeof GROUPS)[number];

function pickerRows(s: Pick<State, "models" | "pulls" | "fits" | "numCtx" | "catalog">, q: string): Record<GroupKey, Row[]> {
  const catalog = catalogOf(s);
  const groups: Record<GroupKey, Row[]> = { gpu: [], spill: [], no: [], unknown: [] };
  const hit = (tag: string, name: string, purpose: string) =>
    q === "" || tag.toLowerCase().includes(q) || name.toLowerCase().includes(q) || purpose.toLowerCase().includes(q);
  // Embedding models never chat, so they are never a choice here.
  for (const m of chatModels(s.models ?? [])) {
    const d = describeModel(m.name, catalog);
    if (!hit(m.name, d.name, d.purpose)) continue;
    const v = verdictFor(s, m.name);
    groups[v?.k ?? "unknown"].push({ tag: m.name, name: d.name, purpose: d.purpose, v, info: m });
  }
  for (const p of Object.values(s.pulls)) {
    if (p.state !== "downloading" && p.state !== "queued" && p.state !== "verifying") continue;
    if ((s.models ?? []).some((m) => m.name === p.name)) continue;
    const d = describeModel(p.name, catalog);
    if (!hit(p.name, d.name, d.purpose)) continue;
    const c = catalog?.find((e) => e.name === p.name);
    const v = c?.fit ? verdictOf(c.fit) : undefined;
    groups[v?.k ?? "unknown"].push({ tag: p.name, name: d.name, purpose: d.purpose, v, downloading: pctOf(p.completedBytes, p.totalBytes), info: undefined });
  }
  return groups;
}

function rowSub(r: Row, numCtx: number, loaded: boolean): string {
  const est = r.v === undefined ? "checking memory" : r.v.k === "gpu" ? `est. ${gb(r.v.need)} at ${k(numCtx)}` : r.v.k === "spill" ? `est. ${r.v.detail}` : r.v.detail;
  return [r.purpose, est].filter((x) => x !== "").join(" · ") + (loaded ? " · loaded" : "");
}

function rowTip(r: Row, sysBytes: number | undefined): string {
  let tip = tagTip(r.name, r.info, r.tag);
  if (r.v) {
    tip += "<br>";
    if (r.v.k === "no") tip += `Estimated need ${gb(r.v.need)}. Available to this model: ${gb(r.v.avail)} of GPU${sysBytes !== undefined ? ` plus ${gb(sysBytes)} of system memory` : ""}.`;
    else if (r.v.k === "spill") tip += `An estimated ${gb(r.v.amt)} runs from system memory, so replies are slower.`;
    else tip += `Estimated need ${gb(r.v.need)} of ${gb(r.v.avail)} available to this model.`;
  }
  if (r.info) tip += `<br>${gb(r.info.sizeBytes)} on disk`;
  return tip;
}

/** Trim the list to end 4 px under the last whole row (F55); returns whether it overflows. */
function sizeList(list: HTMLElement): void {
  list.style.maxHeight = "";
  const cap = Math.min(440, window.innerHeight - 180);
  if (list.scrollHeight <= cap + 1) return;
  let end = 0;
  for (const kid of Array.from(list.children)) {
    if (!(kid instanceof HTMLElement)) continue;
    const b = kid.offsetTop + kid.offsetHeight;
    if (b + 4 > cap) break;
    if (kid.classList.contains("pk-r")) end = b;
  }
  list.style.maxHeight = `${end + 4}px`;
}

function thumb(list: HTMLElement, sb: HTMLElement, th: HTMLElement): void {
  const over = list.scrollHeight > list.clientHeight + 1;
  sb.classList.toggle("on", over);
  if (!over) return;
  const track = list.clientHeight - 8;
  const h = Math.max(24, (track * list.clientHeight) / list.scrollHeight);
  const top = ((track - h) * list.scrollTop) / (list.scrollHeight - list.clientHeight);
  th.style.height = `${h}px`;
  th.style.top = `${top}px`;
}

function choose(tag: string): void {
  closePop();
  closeTip();
  pickModel(tag);
  focusComposer();
}

export function Picker() {
  const pop = useStore((s) => (s.pop?.id === "picker" ? s.pop : null));
  const open = pop !== null;
  const [q, setQ] = useState("");
  const [hl, setHl] = useState(-1);
  const [kb, setKb] = useState(false);
  const numCtx = useStore((s) => s.numCtx);
  const selected = useStore((s) => s.model);
  const models = useStore((s) => s.models);
  const fits = useStore((s) => s.fits);
  const pulls = useStore((s) => s.pulls);
  const loads = useStore((s) => s.loads);
  const gpu = useStore((s) => s.gpu);
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const sb = useRef<HTMLDivElement>(null);
  const th = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // reset on each open; check every installed model's fit at this context
  useEffect(() => {
    if (!open) return;
    setQ("");
    setHl(-1);
    setKb(pop?.kb ?? false);
    for (const m of chatModels(getState().models ?? [])) ensureFit(m.name, getState().numCtx);
    const t = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, pop?.kb]);

  const catalogRaw = useStore((st) => st.catalog);
  const groups = pickerRows({ models, pulls, fits, numCtx, catalog: catalogRaw }, q.trim().toLowerCase());
  const sys = gpu === NA || gpu === undefined ? undefined : gpu.systemMemoryAvailableBytes;
  const selectable = GROUPS.flatMap((g) => groups[g].filter((r) => r.downloading === undefined && r.v?.k !== "no"));

  useLayoutEffect(() => {
    const anchor = document.getElementById("modelBtn");
    if (!open || !ref.current || !list.current || !anchor) return;
    place(ref.current, anchor, "start");
    sizeList(list.current);
    place(ref.current, anchor, "start");
    if (sb.current && th.current) thumb(list.current, sb.current, th.current);
  });

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (selectable.length === 0) return;
      setKb(true);
      const next = (hl + (e.key === "ArrowDown" ? 1 : -1) + selectable.length) % selectable.length;
      setHl(next);
      list.current?.querySelector(`[data-i="${next}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = selectable[hl >= 0 ? hl : 0];
      if (r) choose(r.tag);
    } else if (/^[1-9]$/.test(e.key) && q === "" && kb) {
      e.preventDefault();
      const r = selectable[Number(e.key) - 1];
      if (r) choose(r.tag);
    }
  };

  let idx = 0;
  const body = GROUPS.flatMap((g) => {
    const rows = groups[g];
    if (rows.length === 0) return [];
    const head = rows[0]?.v;
    return [
      // Headings are visual only: a listbox owns options, and each option's sub line already says its fit.
      head && g !== "unknown" ? <VLabel key={`g-${g}`} v={head} cls="pk-g" hidden /> : null,
      ...rows.map((r) => {
        const ctx = ctxFor(numCtx, models, r.tag);
        const loaded = loads[r.tag]?.state === "ready" && loads[r.tag]?.numCtx === ctx;
        if (r.downloading !== undefined) {
          return (
            <div key={r.tag} className="pk-r dis" role="option" aria-selected={false} aria-disabled="true" data-tip={`${tagTip(r.name, r.info, r.tag)}<br>You can pick it when the download finishes.`}>
              <span className="pk-c" />
              <div className="pk-m">
                <div className="pk-n">{r.name}</div>
                <div className="pk-s">Downloading · {r.downloading}%</div>
              </div>
            </div>
          );
        }
        const tip = rowTip(r, sys);
        const sub = rowSub(r, ctx, loaded);
        if (r.v?.k === "no") {
          return (
            <div key={r.tag} className="pk-r dis" role="option" aria-selected={false} aria-disabled="true" data-m={r.tag} data-tip={tip}>
              <span className="pk-c" />
              <div className="pk-m">
                <div className="pk-n">{r.name}</div>
                <div className="pk-s">{sub}</div>
              </div>
              <button type="button" className="qa" data-memdet={r.tag} onClick={() => openFit(r.tag)}>
                Memory details
              </button>
            </div>
          );
        }
        const i = idx++;
        const sel = r.tag === selected;
        return (
          <button
            key={r.tag}
            type="button"
            className={`pk-r${sel ? " sel" : ""}${i === hl ? " hl" : ""}`}
            role="option"
            id={`pk-opt-${i}`}
            // While the arrow keys move a highlight, it is the selection a screen reader announces.
            aria-selected={hl >= 0 ? i === hl : sel}
            data-m={r.tag}
            data-i={i}
            data-tip={tip}
            onClick={() => choose(r.tag)}
          >
            <span className="pk-c">{sel ? <Icon id="check" /> : null}</span>
            <span className="pk-k">{i + 1}</span>
            <div className="pk-m">
              <div className="pk-n">{r.name}</div>
              <div className="pk-s">{sub}</div>
            </div>
          </button>
        );
      }),
    ];
  });

  return (
    <div className={`pop${open ? " open" : ""}${kb ? " kb" : ""}`} id="picker" role="dialog" aria-label="Choose a model" ref={ref}>
      <div className="pk-h">
        <div className="pk-hin">
          <Icon id="search" />
          <input
            ref={input}
            id="pkSearch"
            placeholder="Search models"
            aria-label="Search models"
            role="combobox"
            aria-expanded={open}
            aria-controls="pkList"
            aria-autocomplete="list"
            aria-activedescendant={hl >= 0 ? `pk-opt-${hl}` : undefined}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setHl(-1);
            }}
            onKeyDown={onKey}
          />
          <span className="pk-cap">Estimated at {k(numCtx)}</span>
        </div>
      </div>
      <div className="pk-wrap">
        <div
          className="pk-list"
          id="pkList"
          role="listbox"
          aria-label="Models"
          ref={list}
          onScroll={() => {
            if (list.current && sb.current && th.current) thumb(list.current, sb.current, th.current);
          }}
        >
          {body.length > 0 ? body : <div className="pk-empty">No installed model matches.</div>}
        </div>
        <div className="pk-sb" ref={sb} aria-hidden="true">
          <i ref={th} />
        </div>
      </div>
    </div>
  );
}
