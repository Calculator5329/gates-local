// Layout A: scope first. Editors and installed defaults stay separate so the page can be rearranged.
import { useEffect, useRef, useState } from "react";
import { MODEL_CONTROL_BOUNDS, type ModelDefaults, type ModelSettings, type ModelSettingsPatch } from "@gates-local/contracts";
import { describeModel } from "./format.ts";
import { Icon } from "./icons.tsx";
import { applyServerEvent, call, updateModelSettings, updateSettings } from "./session.ts";
import { NA, useStore } from "./store.ts";
import { Grp, Head, Row, Seg2, useOutside, walk } from "./settings-ui.tsx";
import { closeTip, esc } from "./ui.tsx";
import { controlPatch, controlValues, editControl, type ControlDraft, type ControlKey } from "./instruction-draft.ts";

const WHEN = "Saved changes apply to your next message, including in existing chats. A reply already running keeps its settings.";
const PROMPT_TIP = "Instructions for how the model should answer. They use part of its context window. Gates Local's tool instructions stay in place. An empty custom prompt uses no user or model instructions.";

/** A fixed-height status slot and constant button labels keep save/error states from moving controls. */
function Status({ text, error = false }: { text: string; error?: boolean }) {
  return <div className={`inst-status${error ? " act-err" : ""}`} role={error ? "alert" : "status"}>{text || "\u00a0"}</div>;
}

function PromptEditor({ value, inherited, model, locked }: { value: string | undefined; inherited: string; model?: string; locked: boolean }) {
  const [draft, setDraft] = useState<{ custom: boolean; text: string } | null>(null);
  const [status, setStatus] = useState({ text: "", error: false });
  const [busy, setBusy] = useState(false);
  const custom = draft?.custom ?? value !== undefined;
  const text = draft?.text ?? value ?? "";
  const save = async (reset = false) => {
    setBusy(true); setStatus({ text: "Saving…", error: false });
    const next = reset || !custom ? null : text;
    const error = model === undefined ? await updateSettings({ systemPrompt: next }) : await updateModelSettings(model, { systemPrompt: next });
    setBusy(false);
    if (error === null) { setDraft(null); setStatus({ text: "Saved", error: false }); }
    else setStatus({ text: error, error: true });
  };
  return <Grp title="System prompt">
    <div className="inst-prompt" aria-busy={busy}>
      <label className="inst-check" data-tip={esc(PROMPT_TIP)}>
        <input type="checkbox" checked={custom} disabled={busy || locked} onChange={e => { setDraft({ custom: e.target.checked, text }); setStatus({ text: "", error: false }); }} />
        {model === undefined ? "Use custom instructions for all chats" : "Override all-chat instructions for this model"}
      </label>
      <textarea aria-label="System prompt" className="inp inst-text" value={custom ? text : inherited} placeholder={custom ? "Leave empty for no user or model prompt" : model === undefined ? "Use each model's own instructions" : "Use all-chat instructions, or the model's own"} disabled={!custom || busy || locked} onChange={e => { setDraft({ custom: true, text: e.target.value }); setStatus({ text: "", error: false }); }} />
      <div className="inst-actions">
        <Status {...status} />
        <button type="button" className="btn ghost" disabled={busy || locked} data-tip="Restore inherited instructions." onClick={() => void save(true)}>Reset</button>
        <button type="button" className="btn outline" disabled={busy || locked || draft === null} onClick={() => void save()}>Save instructions</button>
      </div>
    </div>
  </Grp>;
}

const CONTROLS = [
  { key: "temperature", label: "Temperature", hint: "Higher values make replies more varied." },
  { key: "top_p", label: "Top p", hint: "Consider words up to this share of their combined likelihood." },
  { key: "top_k", label: "Top k", hint: "Consider this many likely words at each step. 0 removes this limit." },
  { key: "repeat_penalty", label: "Repeat penalty", hint: "Higher values discourage repeating words. 1 leaves repetition unchanged." },
  { key: "seed", label: "Seed", hint: "Reuse a number to make replies more repeatable. -1 chooses a random seed." },
  { key: "num_predict", label: "Maximum reply length", hint: "Maximum reply tokens. -1 removes the limit; -2 fills the context window. 0 is not valid." },
  { key: "keep_alive", label: "Keep loaded", hint: "Seconds to keep the model in memory after a reply. 0 unloads it; -1 keeps it loaded. Gates Local may reclaim idle models when another load needs memory." },
] as const;
const MODES = [["default", "Default"], ["custom", "Custom"]] as const;

/** The app's own listbox (as Models' default card): arrows, letters to find, Enter, Escape back to the button. */
function ModelMenu({ models, value, onPick }: { models: readonly { name: string; text: string }[]; value: string | undefined; onPick: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null), btn = useRef<HTMLButtonElement>(null);
  const close = (refocus = true) => { setOpen(false); if (refocus) btn.current?.focus(); };
  useOutside(box, open, () => close(false));
  useEffect(() => {
    if (open) (box.current?.querySelector<HTMLElement>("[role=option][aria-selected=true]") ?? box.current?.querySelector<HTMLElement>("[role=option]"))?.focus();
  }, [open]);
  const current = models.find(m => m.name === value);
  const choose = (name: string) => { onPick(name); close(); };
  return <div className="inst-pick" ref={box} onKeyDown={e => open && walk(e, box.current, "[role=option]", close)}>
    <button ref={btn} type="button" className={`mp-select${open ? " on" : ""}`} aria-haspopup="listbox" aria-expanded={open} aria-label={`Installed model: ${current?.text ?? "none"}`} disabled={!models.length} onClick={() => { closeTip(); setOpen(o => !o); }}>
      <span className="mp-sv"><span className="mp-nmn">{current?.text ?? "No installed chat models"}</span></span>
      <Icon id="down" cls="s14" />
    </button>
    {open ? <div className="mp-dd" role="listbox" aria-label="Installed chat models">
      {models.map(m => <div key={m.name} role="option" tabIndex={-1} aria-selected={m.name === value} aria-label={m.text} data-tip={esc(m.name)} className="mp-opt" onClick={() => choose(m.name)}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); choose(m.name); } }}>
        {m.name === value ? <Icon id="check" cls="s14 mp-ck" /> : <span />}
        <span className="mp-nmx"><span className="mp-nmn">{m.text}</span></span>
      </div>)}
    </div> : null}
  </div>;
}

function ReplyControls({ model, saved, defaults, locked }: { model: string; saved: ModelSettings; defaults: ModelDefaults | undefined; locked: boolean }) {
  const [draft, setDraft] = useState<ControlDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ text: "", error: false });
  const values = controlValues(saved, draft ?? {});
  const change = (key: ControlKey, value: string | null) => {
    const next = editControl(saved, draft ?? {}, key, value);
    setDraft(Object.keys(next).length ? next : null);
    setStatus({ text: "", error: false });
  };
  const save = async (reset = false) => {
    const patch: ModelSettingsPatch = reset ? Object.fromEntries(CONTROLS.map(({ key }) => [key, null])) : controlPatch(draft ?? {});
    if (!reset && CONTROLS.some(({ key }) => values[key] !== null && (values[key]?.trim() === "" || !Number.isFinite(Number(values[key])) || (key === "num_predict" && Number(values[key]) === 0) || (key === "keep_alive" && Number(values[key]) < 0 && Number(values[key]) !== -1)))) {
      setStatus({ text: "Enter a valid number for each custom control.", error: true }); return;
    }
    setBusy(true); setStatus({ text: "Saving…", error: false });
    const error = await updateModelSettings(model, patch);
    setBusy(false);
    if (error === null) { setDraft(null); setStatus({ text: "Saved", error: false }); }
    else setStatus({ text: error, error: true });
  };
  return <form className="inst-controls" aria-label="Reply controls" aria-busy={busy} onSubmit={e => { e.preventDefault(); void save(); }}>
    <Grp title="Reply controls">
      {CONTROLS.map(control => {
        const key = control.key, custom = values[key] !== null;
        const bounds = MODEL_CONTROL_BOUNDS[key];
        const shipped = key === "keep_alive" ? undefined : defaults?.parameters.split("\n").find(line => line.trim().startsWith(`${key} `))?.trim().split(/\s+/)[1];
        const owner = key === "keep_alive" ? "Ollama's" : "the model's";
        return <Row key={key} label={control.label} tip={`${control.hint} Default uses ${owner} own value. Range: ${bounds.min} to ${bounds.max}.`}>
          <Seg2 label={`${control.label} mode`} disabled={busy || locked} value={custom ? "custom" : "default"} options={MODES}
            onPick={mode => { if (mode !== (custom ? "custom" : "default")) change(key, mode === "default" ? null : (shipped ?? (key === "num_predict" ? "2048" : key === "keep_alive" ? "300" : key === "repeat_penalty" ? "1" : "0"))); }} />
          <input className="inp inst-number" type="number" aria-label={control.label} value={values[key] ?? ""} placeholder={shipped ?? ""} min={key === "num_predict" ? -2 : key === "keep_alive" ? -1 : bounds.min} max={bounds.max} step={bounds.integer ? 1 : "any"} required={custom} disabled={!custom || busy || locked} onChange={e => change(key, e.target.value)} />
          <button type="button" className="btn ghost inst-reset" aria-label={`Reset ${control.label}`} data-tip="Use the default after saving controls." disabled={!custom || busy || locked} onClick={() => change(key, null)}>Reset</button>
        </Row>;
      })}
    </Grp>
    <div className="inst-actions"><Status {...status} /><button type="button" className="btn ghost" disabled={busy || locked} onClick={() => void save(true)}>Reset controls</button><button type="submit" className="btn outline" disabled={busy || locked || draft === null}>Save controls</button></div>
  </form>;
}

function ModelEditors({ model, name, saved, shared, locked }: { model: string; name: string; saved: ModelSettings; shared: string | undefined; locked: boolean }) {
  const [read, setRead] = useState<{ value?: ModelDefaults; error?: string }>({});
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    void call("settings.modelDefaults", { model }).then(value => { applyServerEvent(() => { if (current) setRead({ value }); }); }, (error: unknown) => { applyServerEvent(() => { if (current) setRead({ error: error instanceof Error ? error.message : "Could not read model defaults." }); }); });
    return () => { current = false; };
  }, [model, retry]);
  return <>
    <PromptEditor value={saved.systemPrompt} inherited={shared ?? read.value?.system ?? ""} model={model} locked={locked} />
    <ReplyControls model={model} saved={saved} defaults={read.value} locked={locked} />
    <div className="grp box inst-defaults"><details><summary>What {name} ships with</summary>
      <div className="inst-actions"><Status text={read.error ?? (read.value ? "Read only" : "Loading…")} error={read.error !== undefined} /><button type="button" className="btn ghost" disabled={!read.error} onClick={() => { setRead({}); setRetry(n => n + 1); }}>Retry</button></div>
      <b>System prompt</b><pre className="inst-shipped" aria-label="Model system prompt">{read.value?.system || (read.value ? "No system prompt reported." : "")}</pre>
      <b>Parameters</b><pre className="inst-shipped" aria-label="Model parameters">{read.value?.parameters || (read.value ? "No parameters reported. Ollama defaults apply." : "")}</pre>
    </details></div>
  </>;
}

export default function Instructions() {
  const settings = useStore(s => s.settings), models = useStore(s => s.models), catalog = useStore(s => s.catalog), chatModel = useStore(s => s.model);
  const unavailable = useStore(s => s.unavailable["settings.update"] || s.unavailable["settings.model.update"]);
  const [scope, setScope] = useState<"all" | "model">("all");
  const [picked, setPicked] = useState<string | null>(null);
  const installed = (models ?? []).filter(m => m.capabilities.includes("completion"));
  const model = installed.find(m => m.name === (picked ?? chatModel))?.name ?? installed[0]?.name;
  const current = settings === NA ? undefined : settings;
  const name = model === undefined ? "" : describeModel(model, catalog === NA ? undefined : catalog).name;
  const locked = current === undefined || unavailable === true;
  return <div className="instructions">
    <Head title="Instructions" />
    <div className="inst-top"><div className="mp-tabs" role="group" aria-label="Instruction scope">
      <button type="button" className={`mp-tab${scope === "all" ? " on" : ""}`} aria-pressed={scope === "all"} onClick={() => setScope("all")}>All chats</button>
      <button type="button" className={`mp-tab${scope === "model" ? " on" : ""}`} aria-pressed={scope === "model"} onClick={() => { setPicked(model ?? null); setScope("model"); }}>Per model</button>
    </div><span tabIndex={0} role="note" className="btn ghost" aria-label="When changes apply" aria-description={WHEN} data-tip={esc(WHEN)}>?</span></div>
    {scope === "all" ? <PromptEditor value={current?.systemPrompt} inherited="" locked={locked} /> : <>
      <Grp><Row label="Installed model"><ModelMenu value={model} onPick={setPicked} models={installed.map(m => ({ name: m.name, text: describeModel(m.name, catalog === NA ? undefined : catalog).name }))} /></Row></Grp>
      {model === undefined ? null : <ModelEditors key={model} model={model} name={name} saved={current?.modelSettings?.[model] ?? {}} shared={current?.systemPrompt} locked={locked} />}
    </>}
  </div>;
}
