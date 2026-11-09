# Instructions: layout A and the server contract

The owner requested a separate Settings section for system prompts and related
model behaviour. Models keeps its existing jobs. Context stays in Advanced and
the chat's GPU panel.

The owner chose Instructions (layout A): all-chat and per-model views in the
existing Settings shell. Model behaviour and Prompts were the other explored
layouts. A later design pass is expected; this implementation keeps the prompt
editor, reply controls and installed defaults separate so they are easy to move.

## Server contract

- `settings.update({systemPrompt})` saves the shared prompt. `null` restores each
  model's shipped prompt. An empty string explicitly requests no user/model prompt.
- `settings.model.update({model, patch})` merges fields for one model. A missing
  field stays as saved, `null` clears that field, and a null patch resets that model.
  Model tags without a tag suffix are stored with `:latest`.
- Per-model fields: `systemPrompt`, `temperature`, `top_p`, `top_k`,
  `repeat_penalty`, `seed`, `num_predict`, `keep_alive`. An unset prompt inherits
  the shared prompt, then the installed model's prompt. An empty per-model prompt
  overrides the shared prompt with no user/model prompt. Tool instructions remain.
- `settings.modelDefaults({model})` returns `{system, parameters}` directly from
  `/api/show`, read only. Empty strings mean not reported. Parameters stay raw so
  repeated entries, including stop sequences, are not lost. Unreported parameters
  use Ollama defaults; keep alive is an Ollama runtime setting, not a model parameter.
- Each accepted message snapshots the saved overrides before admission waits.
  Later settings changes apply to the next accepted message. Already accepted or
  running messages retain their prompt and controls throughout tool rounds.
- `keep_alive` is seconds, `0` unloads after a reply and `-1` keeps loaded.
  Gates Local may still reclaim an idle model when another load needs memory.
  `num_predict` is a positive token limit, `-1` unlimited or `-2` fill context.
  Optional controls are omitted from Ollama requests, never filled with invented defaults.

The implementation explicitly allows only these generation fields. It never
passes `num_gpu`, and the fit path alone selects `num_ctx`. Both plain and tool
requests budget the prompt and retain reply room; system instructions are never
silently cut. Tool transport combines the prompt and built-in instructions in
one system message because some model templates use only one system message.

Controls save only fields edited in that form. Untouched fields follow incoming
settings changes; an active draft keeps the person's text or number. Prompt
editors likewise send only `systemPrompt`. Reset controls intentionally clears
all seven controls; Reset all intentionally clears every model entry.
Returning a control to its original value removes its pending edit, so a later
save of a different field cannot resend that reverted value over another change.

Numeric limits are shared by the contract and interface: temperature 0–5, top p
0–1, top k 0–262144, repeat penalty 0–10, seed -1–2147483647, maximum reply length
1–65536 (also -1 and -2), and keep loaded 0–604800 seconds (also -1). Top k, seed
and reply length are integers. These allow highly varied sampling, a broad token
pool, strong repetition control, the full supported chat context as a reply,
and up to a week loaded; the existing unlimited sentinels remain available.

New values outside those limits are refused. Finite legacy file values still
load: effective controls are clamped to these limits, preserving prompts and
valid sentinels. Original legacy values survive loading only. Any later settings
save, including an unrelated theme change, writes the normalized values and
replaces the original out-of-range numbers without changing their effective value.
Legacy fractional integer controls are truncated
after clamping. Both chat transports also clamp at send, so an old reader cannot
forward overflowing numbers. Malformed file types still follow
the existing bad-file recovery path.

The custom-instructions checkbox distinguishes inheritance from an explicitly
empty prompt. Controls have default/custom states and a reset, and use explanatory
tooltips. Installed defaults are read only. A tooltip beside the scope buttons says
when saves apply. Buttons keep their labels during saving and errors; textareas,
numeric inputs, defaults panels and status slots reserve their space.

Reset all sends `systemPrompt: null` and `modelSettings: null` together through
`settings.update`, clearing every model entry atomically. It still leaves the
runtime mode alone. Individual reset buttons restore inheritance for a prompt
or a control; Reset controls leaves the model's prompt alone.

References: [Ollama Modelfile parameters](https://docs.ollama.com/modelfile),
[chat options and keep alive](https://docs.ollama.com/api/chat).

## Verification and review

Focused tests inspect HTTP requests received by a fake Ollama: default/shared/model/
empty prompts, native and text tools, no tools, controls on every tool round,
settings edits during replies, old-file loading, persistence, reset and bad values.
These are diagnostic probes; the existing verify gate and contract round trips
also run. Mutations that allow invalid top p and remove built-in tool instructions
were observed failing the probes, then reverted.

Browser checks exercise saves through the real client and server against a fake
runtime, including reset, overflow refusal and stable control geometry. The
existing Settings, context and ready-to-chat journeys passed (18 checks). The
phone row-height probe caught an inherited 200 px label basis before it was fixed.
Real runtime and GPU checks remain separate from these fake-runtime checks.
