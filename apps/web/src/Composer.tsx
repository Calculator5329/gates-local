// Layout adapts T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.); full notice in LICENSES/T3-Code-MIT.txt.
// The composer (shell.md F01, F02, F15, F28-F31, F34, F37b, F43b): the text
// box, model and context chips, Thinking and Image pills, the context meter,
// Send or Stop, and the popovers it opens (model picker, + menu).
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ContextSize, ModelInfo } from "@gates-local/contracts";
import { PLACEHOLDER, rtOf } from "./Banner.tsx";
import { openFit } from "./FitPanel.tsx";
import { CONTEXT_SIZES, type Verdict, describeModel, gb, k, modelFacts, verdictOf } from "./format.ts";
import { Icon, SendArrow } from "./icons.tsx";
import { canThink, chatModels, pickRuleText, pickedModel } from "./pick.ts";
import { focusComposer } from "./Sidebar.tsx";
import { ensureFit, firstPull, openSettings, pickModel, pull, queueReason, send, setContext, stop } from "./session.ts";
import { NA, type State, fitKey, getState, setState, streaming, useStore } from "./store.ts";
import { closePop, closeTip, esc, place, togglePop } from "./ui.tsx";

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
  // a tag the catalog does not know is its own name: say it once, and its quant only when the tag does not
  const head = name === tag ? `<b class="mono">${esc(tag)}</b>` : `<b>${esc(name)}</b> · <span class="mono">${esc(tag)}</span>`;
  return `${head}${q && !tag.toLowerCase().includes(q.toLowerCase()) ? ` · ${esc(q)}` : ""}`;
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
  const loading = loadState === "loading";
  // The verdict holds still: between an invalidation and the fresh answer the last one for this
  // model and context stays, and while the model loads it keeps the one from before the load
  // (its own memory filling the GPU, not yet listed by Ollama, is no reason to refuse it).
  // A failed check ends the hold: the old verdict no longer says anything about memory now.
  const fitAt = model === undefined ? "" : fitKey(model, numCtx);
  const failed = fit === "error";
  const fresh = fit === undefined || failed ? undefined : verdictOf(fit);
  const held = useRef<{ at: string; v: Verdict } | undefined>(undefined);
  if (failed) held.current = undefined;
  const kept = held.current?.at === fitAt ? held.current.v : undefined;
  const v = loading ? (kept ?? fresh) : (fresh ?? kept);
  if (!loading && fresh !== undefined) held.current = { at: fitAt, v: fresh };
  const text = draft.trim();
  const noModel = model === undefined && !queueable;
  // During setup the gate style already greys every control; otherwise the pill says why it is off.
  const thinkNa = blocked ? null : thinkUnavailable(models?.find((m) => m.name === model), name, first !== undefined);

  const modelLbl =
    rt === "installing" ? `${name} · downloads next` : first !== undefined ? `${name} · downloading ${firstProgress}%` : name;
  const modelTip =
    shownTag === undefined
      ? "No model is installed yet. Download one in Settings › Models."
      : loading
        ? `${tagTip(name, info, shownTag)}<br>Loading into GPU memory…`
        : `${tagTip(name, info, shownTag)}${info ? ` · ${gb(info.sizeBytes)} on disk` : ""}`;

  const pct = Math.min(1, used / numCtx);
  const meterHidden = pct < 0.5 || blocked || view !== "thread";

  const placeholder = first !== undefined && !blocked ? "Type now; it sends when the download finishes" : noModel && ready ? "Download a model to start chatting" : PLACEHOLDER[rt];

  let sendTip = "Send (Enter)";
  if (queueable) sendTip = `${text ? "Send (Enter). It goes out when " : "Type now; it sends when "}${wait === "download" ? "the download finishes" : "setup finishes"}`;
  else if (blocked) sendTip = "Chat starts when Ollama is ready";
  else if (noModel) sendTip = "Download a model to start chatting";
  else if (v?.k === "no" && v.limit !== undefined) sendTip = `${esc(name)} supports up to ${k(v.limit)} of context. Pick another model.`;
  else if (v?.k === "no") sendTip = `${esc(name)}: not enough memory at ${k(numCtx)}. It needs an estimated ${gb(v.amt)} more. Pick a smaller model or context.<br>Click for GPU memory in Settings › Advanced.`;
  else if (!text) sendTip = "Type a message to send";
  const sendDisabled = (blocked && !queueable) || (!blocked && v?.k === "no") || noModel || !text;
  // Refused for memory: the button stays focusable and clickable, and the click opens the why.
  const memRefused = !blocked && !queueable && !noModel && v?.k === "no" && v.limit === undefined;

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
              aria-busy={loading ? true : undefined}
              data-tip={modelTip}
              onClick={() => togglePop("picker")}
            >
              {/* loading shows in the tile, never in the label: the trigger keeps its width */}
              {shownTag === undefined ? null : <Mark name={name} busy={loading && first === undefined} />}
              <span>{modelLbl}</span>
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
                data-tip={`Context used: ${(used / 1000).toFixed(1)}k of ${k(numCtx)} tokens`}
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
              <button
                type="submit"
                className="send"
                aria-label="Send message"
                data-tip={sendTip}
                disabled={sendDisabled && !memRefused}
                aria-disabled={memRefused ? true : undefined}
                onClick={(e) => {
                  if (!memRefused) return;
                  e.preventDefault();
                  openFit();
                }}
              >
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
    // at the picker's context, as installed rows are (the catalog's own fit is at the saved default)
    const v = verdictFor(s, p.name);
    groups[v?.k ?? "unknown"].push({ tag: p.name, name: d.name, purpose: d.purpose, v, downloading: pctOf(p.completedBytes, p.totalBytes), info: undefined });
  }
  return groups;
}

/** The quiet fit word at the end of a picker row. */
function fitWord(v: Verdict | undefined): string {
  if (v === undefined) return "Checking…";
  if (v.k === "gpu") return "Fits";
  if (v.k === "spill") return "Slower";
  return v.limit !== undefined ? `Up to ${k(v.limit)}` : "Not enough memory";
}

/** "Qwen 3.5 9B" → "Qwen": the rail groups models by the first word of their name. */
const familyOf = (name: string): string => name.split(" ")[0] ?? name;

/** A model's monogram tile: the first letter of its family, or a spinner in the same tile while it loads. */
function Mark({ name, busy = false }: { name: string; busy?: boolean }) {
  return (
    <i className="mmark" aria-hidden="true">
      {busy ? <Icon id="spin" cls="spin" /> : familyOf(name).charAt(0).toUpperCase()}
    </i>
  );
}

function ctxTip(name: string, c: number, v: Verdict | undefined): string {
  const at = `<b>${esc(name)}</b> at ${k(c)}`;
  if (v === undefined) return `${at}: checking GPU memory…`;
  if (v.k === "gpu") return `${at} fits on the GPU: est. ${gb(v.need)} of ${gb(v.avail)} available.`;
  if (v.k === "spill") return `${at} spills ${gb(v.amt)} into system memory, so replies are slower.`;
  if (v.limit !== undefined) return `${at} is past its limit. It supports up to ${k(v.limit)}.`;
  return `${at}: not enough memory. It needs an estimated ${gb(v.amt)} more.`;
}

function pickCtx(c: ContextSize): void {
  closeTip();
  setContext(c);
}

/** The picker's foot: the context size, with the highlighted model's fit at each size. */
function CtxPick({ model }: { model: string | undefined }) {
  const numCtx = useStore((s) => s.numCtx);
  const fits = useStore((s) => s.fits);
  const catalog = useStore(catalogOf);
  useEffect(() => {
    for (const c of CONTEXT_SIZES) ensureFit(model, c);
  }, [model, fits]);
  const name = model === undefined ? "" : describeModel(model, catalog).name;
  return (
    <div className="pk-foot">
      <div className="pk-ctx">
        <span className="pk-ft" id="pkCtxL">
          Context
        </span>
        <div
          className="mini-seg"
          role="radiogroup"
          aria-labelledby="pkCtxL"
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const i = CONTEXT_SIZES.indexOf(numCtx as ContextSize);
            const next = CONTEXT_SIZES[(i + (e.key === "ArrowRight" ? 1 : -1) + CONTEXT_SIZES.length) % CONTEXT_SIZES.length];
            if (next === undefined) return;
            pickCtx(next);
            requestAnimationFrame(() => document.querySelector<HTMLElement>(`#picker [data-ctx="${next}"]`)?.focus());
          }}
        >
          {CONTEXT_SIZES.map((c) => {
            const r = model === undefined ? undefined : fits[fitKey(model, c)];
            const v = r === undefined || r === "error" ? undefined : verdictOf(r);
            return (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={c === numCtx}
                tabIndex={c === numCtx ? 0 : -1}
                className={c === numCtx ? "on" : ""}
                data-ctx={c}
                data-tip={model === undefined ? `${k(c)} of context` : ctxTip(name, c, v)}
                onClick={() => pickCtx(c)}
              >
                <span className={`vd ${v?.k ?? "off"}`} />
                {k(c)}
              </button>
            );
          })}
        </div>
      </div>
      <p className="pk-help">How much of the chat the model can read at once.</p>
    </div>
  );
}

function rowTip(r: Row, sysBytes: number | undefined): string {
  let tip = tagTip(r.name, r.info, r.tag);
  if (r.v) {
    tip += "<br>";
    if (r.v.k === "no" && r.v.limit !== undefined) tip += `${esc(r.name)} supports up to ${k(r.v.limit)} of context.`;
    else if (r.v.k === "no") tip += `Estimated need ${gb(r.v.need)}. Available to this model: ${gb(r.v.avail)} of GPU${sysBytes !== undefined ? ` plus ${gb(sysBytes)} of system memory` : ""}.`;
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
  for (const kid of Array.from(list.querySelectorAll(".pk-r, .pk-gt, .pk-dr"))) {
    if (!(kid instanceof HTMLElement)) continue;
    const b = kid.offsetTop + kid.offsetHeight;
    if (b + 4 > cap) break;
    if (!kid.classList.contains("pk-gt")) end = b;
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
  const [fam, setFam] = useState<string | null>(null);
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
    setFam(null);
    setHl(-1);
    setKb(pop?.kb ?? false);
    const t = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, pop?.kb]);
  const catalogRaw = useStore((st) => st.catalog);
  const catalog = catalogRaw === NA ? undefined : catalogRaw;
  useEffect(() => {
    if (!open) return;
    const installed = chatModels(getState().models ?? []);
    for (const m of installed) ensureFit(m.name, numCtx);
    // download and downloading rows too: the fit check gives a model not installed yet the pre-download estimate
    for (const c of catalog ?? []) if (!c.installed && !installed.some((m) => m.name === c.name)) ensureFit(c.name, numCtx);
  }, [open, numCtx, fits, catalog]);
  const query = q.trim().toLowerCase();
  const all = pickerRows({ models, pulls, fits, numCtx, catalog: catalogRaw }, query);
  const inFam = (name: string) => fam === null || familyOf(name) === fam;
  const groups = Object.fromEntries(GROUPS.map((g) => [g, all[g].filter((r) => inFam(r.name))])) as Record<GroupKey, Row[]>;
  const sys = gpu === NA || gpu === undefined ? undefined : gpu.systemMemoryAvailableBytes;
  const selectable = GROUPS.flatMap((g) => groups[g].filter((r) => r.downloading === undefined && r.v?.k !== "no"));
  // the rail: every family among installed and downloadable models, "All" first
  const listed = chatModels(models ?? []).map((m) => describeModel(m.name, catalog).name);
  const offered = (catalog ?? []).filter((c) => !c.installed && !(models ?? []).some((m) => m.name === c.name));
  const families = [...new Set([...listed, ...offered.map((c) => c.label)].map(familyOf))];
  const pulling = (tag: string) => {
    const p = pulls[tag];
    return p !== undefined && (p.state === "queued" || p.state === "downloading" || p.state === "verifying");
  };
  const downloads = offered.filter(
    (c) => !pulling(c.name) && inFam(c.label) && (query === "" || c.name.toLowerCase().includes(query) || c.label.toLowerCase().includes(query) || c.purpose.toLowerCase().includes(query)),
  );
  const picked = pickedModel(models)?.name;
  const ctxModel = (hl >= 0 ? selectable[hl]?.tag : undefined) ?? selected;

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

  const rec = <span className="pk-rec" data-tip={pickRuleText(numCtx)}>Recommended</span>;
  let idx = 0;
  // Installed models first, best fit first; the fit word ends each row and the tooltip says the numbers.
  const body = GROUPS.flatMap((g) =>
    groups[g].map((r) => {
      const loaded = loads[r.tag]?.state === "ready" && loads[r.tag]?.numCtx === numCtx;
      const size = r.info ? gb(r.info.sizeBytes) : "";
      if (r.downloading !== undefined) {
        return (
          <div key={r.tag} className="pk-r dis" role="option" aria-selected={false} aria-disabled="true" data-tip={`${tagTip(r.name, r.info, r.tag)}<br>${ctxTip(r.name, numCtx, r.v)}<br>You can pick it when the download finishes.`}>
            <span className="pk-c" />
            <Mark name={r.name} />
            <div className="pk-m">
              <div className="pk-n">
                <span className="pk-nm">{r.name}</span>
              </div>
            </div>
            <span className="pk-v">Downloading · {r.downloading}%</span>
          </div>
        );
      }
      const tip = `${rowTip(r, sys)}${loaded ? "<br>Loaded now" : ""}`;
      if (r.v?.k === "no") {
        return (
          <div key={r.tag} className="pk-r dis" role="option" aria-selected={false} aria-disabled="true" data-m={r.tag} data-tip={tip}>
            <span className="pk-c" />
            <Mark name={r.name} />
            <div className="pk-m">
              <div className="pk-n">
                <span className="pk-nm">{r.name}</span>
                <small>{size}</small>
              </div>
            </div>
            <span className="pk-v no">{fitWord(r.v)}</span>
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
          <Mark name={r.name} />
          <div className="pk-m">
            <div className="pk-n">
              <span className="pk-nm">{r.name}</span>
              <small>{size}</small>
              {r.tag === picked ? rec : null}
            </div>
          </div>
          <span className={`pk-v ${r.v?.k ?? ""}`}>{fitWord(r.v)}</span>
        </button>
      );
    }),
  );
  const dlRows = downloads.map((c) => {
    // the fit at the picker's context, not the catalog's at the saved default
    const v = verdictFor({ fits, numCtx }, c.name);
    // Recommended is "runs on the GPU" at this context; with no GPU, the catalog's lightest pick while it still runs
    const recTip =
      v?.k === "gpu"
        ? `Runs on your GPU with room for ${k(numCtx)} of context.`
        : c.recommended && c.fit?.verdict === "spills" && v?.k === "spill"
          ? `The lightest choice: at ${k(numCtx)} it runs partly in system memory, so replies are slower.`
          : undefined;
    return (
      <div key={c.name} className="pk-dr" data-dl={c.name} data-tip={`${ctxTip(c.label, numCtx, v)}<br>Estimated before download.`}>
        <Mark name={c.label} />
        <div className="pk-m">
          <div className="pk-n">
            <span className="pk-nm">{c.label}</span>
            <small>{gb(c.downloadBytes)}</small>
            {recTip !== undefined ? <span className="pk-rec" data-tip={recTip}>Recommended</span> : null}
          </div>
        </div>
        <span className={`pk-v ${v?.k ?? ""}`}>{fitWord(v)}</span>
        <button type="button" className="qa" disabled={v?.k === "no"} aria-label={`Download ${c.label}`} onClick={() => void pull(c.name)}>
          Download
        </button>
      </div>
    );
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
        </div>
      </div>
      <div className="pk-body">
        <div className="pk-rail" role="group" aria-label="Model families">
          {[null, ...families].map((f) => (
            <button
              key={f ?? "all"}
              type="button"
              className={`pk-fam${fam === f ? " on" : ""}`}
              aria-pressed={fam === f}
              onClick={() => {
                setFam(f);
                setHl(-1);
              }}
            >
              <i className="mmark" aria-hidden="true">
                {f === null ? "All" : f.charAt(0).toUpperCase()}
              </i>
              <span>{f ?? "All"}</span>
            </button>
          ))}
        </div>
        <div className="pk-wrap">
          <div
            className="pk-list"
            ref={list}
            onScroll={() => {
              if (list.current && sb.current && th.current) thumb(list.current, sb.current, th.current);
            }}
          >
            <div id="pkList" role="listbox" aria-label="Models">
              {body.length > 0 ? body : <div className="pk-empty">No installed model matches.</div>}
            </div>
            {dlRows.length > 0 ? (
              <div className="pk-dl" role="group" aria-labelledby="pkDlT">
                <div className="pk-gt" id="pkDlT">
                  Download
                </div>
                {dlRows}
              </div>
            ) : null}
          </div>
          <div className="pk-sb" ref={sb} aria-hidden="true">
            <i ref={th} />
          </div>
        </div>
      </div>
      <CtxPick model={ctxModel} />
    </div>
  );
}
