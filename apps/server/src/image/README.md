# Image generation

`createImageModule` implements discovery, GPU fit, optional start of the
Linux `comfyui.service` user unit, one image with progress/cancel, saved
PNG and thread attachment. `createImageHandlers` matches the existing
contracts. `ws/server.ts` serves `/files/images/<jobId>.png` with the same
launch token and Origin admission as WebSocket upgrades.

The module reads settings through `settings()`, app-loaded chat models
through `appLoadedModels()`, and GPU room through `readGpu()`. Production
defaults use `fit/gpu.ts`; tests inject every runtime dependency. A custom
ComfyUI URL is discovery-only. Windows never runs systemctl. Local GPU fit
and chat unloading apply only to a ComfyUI on this machine (`isLocalHost`
in `module.ts`). The check compares addresses, not names: it drops a
trailing dot, brackets and a zone id, turns an IPv4-mapped IPv6 address
into its IPv4 form, and resolves any host name through DNS. An address is
local when it is loopback (`127.0.0.0/8`, `::1`), the `0.0.0.0` or `::`
that ComfyUI prints when started with `--listen`, or one of this
machine's interface addresses. `localhost` and `*.localhost` are local
without a lookup. A name is local when any address it resolves to is
local, and a name that does not resolve counts as local, so the fit runs
rather than being skipped. Every other address skips both entirely. A healthy local
ComfyUI reporting only `cpu` devices also skips VRAM fit; the setup lane
will add the RAM check. Other unreadable local GPU reports still refuse
generation.

ComfyUI's resident memory is credited from the managed unit's MainPID rows
in nvidia-smi; when that pid has no measured row, from ComfyUI's own
`/system_stats` `torch_vram_total`. A prompt of ours that outlives the
30 s cancel deadline is remembered: the next image is refused in words
that say it is ours, and the idle stop (and app exit) still stops an
app-started ComfyUI while only that prompt runs.

Service inspection preserves the raw `ActiveState`. Only `inactive` and
`failed` units may be started and adopted by the app. An `active`,
`activating`, `deactivating` or `reloading` unit with HTTP not yet ready
reports `starting`, owner `external`; generation waits within the startup
deadline and never adopts or starts that unit.

Coordinator integration in `main.ts` deliberately defaults `imageGen` to
false and `appLoadedModels` to empty until the other lanes merge. Bind
those two callbacks to the settings store and runtime's ownership registry,
and bind `onModelUnloaded` to remove a model from that registry. Pass the
same `gpuLease` to chat. No contracts change is needed. Reloading chat is
lazy on its next normal request, so this module never warms a chat model
while ComfyUI still holds memory. Before chat fit, call `image.stopIdle()`
to release an idle app-owned ComfyUI immediately; the default image idle
timeout otherwise stops it after five minutes. External ComfyUI is never
stopped. A busy external ComfyUI refuses the image without interruption.

The presets are in `presets.ts`. With no choice saved, a job runs the
first of `DEFAULT_ORDER` whose files ComfyUI's own `/object_info` list
names: FLUX.2 Klein 4B at 1024x1024 (`flux-workflow.ts`, eight steps),
then SDXL Lightning without the LoRA at 768x512. The default settles before
the first fit, so the fit and any unload judge the setup that will run; when
the list has never been read, the job starts (or finds) ComfyUI and reads it
first. The job reads the list again before it renders, so a default whose
files went missing is passed over without a word; a saved choice is never
swapped. A job that settles to another choice keeps the one it was sent with
as `sent`, and the card's box keeps that shape. The pixel-art row
(SDXL with the LoRA) runs only when picked. The SDXL graph is copied from
`ai/local-ai-lab/workflows/sdxl-lightning.json` at
`c092f4d2bba88c4c76b37e34c31f9c2e28643c9c` (origin and adaptations in
`workflow.ts`), four steps. Missing files produce an install-and-retry
message naming the file. No models are downloaded. The **9 GiB image
budget is an estimate**, conservatively above the lab's 7.86 GiB warm
reading at 768x512. It is not a measured peak; the coordinator must measure
the real preset before treating its fit as proven. When ComfyUI answers
healthy, fit credits memory it already holds: remaining need is
`max(0, estimate - comfyResident)`. For the local unit with a known
MainPID, resident bytes are the sum of compute entries matching that PID
from `fit/gpu.ts`; otherwise they come from `/system_stats`
`devices[0].torch_vram_total`. A cold healthy ComfyUI gets no credit. When
the remaining need fits, no chat model is unloaded. Otherwise fit unloads
only app-owned chat models, and the job's running event carries
`phase: "freeing"` while it does. Ollama answers the unload before its
runner has handed the memory back, so fit then reads the GPU every
`SWAP_POLL_MS` (250 ms) until free memory covers the need or `SWAP_WAIT_MS`
(20 s) pass; a cancel ends the wait at once. It remeasures again after
ComfyUI startup. A refusal's card shows one sentence from `fitSentence`:
the need, the free memory and the largest holder other than ComfyUI. When
that holder is Ollama and Ollama's `/api/ps` still lists chat models of this
app's after the unload and the wait, it names them and says to try again,
never to close another app; a model that is gone from the list is not named.
When a listed setup and size with a lower need would fit (`smallerFit`, the
picker's own list), the sentence names it once; when none would, it says
nothing about size. The status detail
and the log keep the long form: remaining need, free memory, shortfall,
credited resident memory and occupants in GiB with one decimal; error fields
retain raw bytes. A chat model that was already resident when a chat of this
app used it is not app-owned (`runtime/load.ts`) and is never unloaded.
Other programs can allocate between a measurement and submission; this app-local lease
cannot prevent that race.

Cancellation removes a waiter locally. Submitted prompts are removed from
ComfyUI's queue or interrupted only if their prompt id is running;
`POST /interrupt` carries `prompt_id` to avoid interrupting another client.
Cleanup waits up to 30 seconds for that prompt to leave both queues. Its
deadline throws `ComfyCancelTimeoutError` with "ComfyUI did not release the
image job within 30 s", then releases the lease. The original render error
survives cleanup errors. Status `detail` records the cleanup failure and
says ComfyUI may still be running the prompt; chat measures actual free
VRAM before loading, even after that lease release.
Progress frames are filtered by prompt id and history polling covers
cache hits. Socket errors, HTTP errors and the ten-minute job timeout
produce an error event. The job timeout starts when the lease is granted,
so waiting behind chat does not consume it. Once PNG bytes have been
fetched and validated, cancellation is a no-op: saving, atomic rename and
the thread attachment finish with `done`. Saved images use an unserved
`.pending` file until the write completes, then an atomic rename. No file
is deleted.

Idle stop checks app ownership, an empty job registry, an idle ComfyUI
queue, and an unchanged MainPID immediately before stopping the unit.
An external restart drops ownership. Shutdown cancels jobs, then applies
the same idle-stop rules. Transient idle-stop failures re-arm the timer
while the app still owns the unit. There are unavoidable races with another
process starting a unit or submitting work between the final check and
systemctl; systemd provides no atomic owner claim.

`pnpm verify:image` uses injected fakes plus a fake HTTP/WebSocket server
and fake Ollama, never the real services or GPU. New tests in this lane
are diagnostic probes, not independent acceptance evidence. Full
`pnpm verify` also runs the repository's pre-existing checks.
Review-01 fixes and their observed red mutations are recorded in the
lane's evidence outside the repo and summarized in `docs/evidence/2026-11.md`.

The coordinator can run the deliberately separate real check:

```sh
node apps/server/src/image/real-check.ts --execute
```

It requires whisper already running and measurable, records its PID
and GPU bytes, checks room without unloading any model, generates one
image, checks progress, thread persistence and authenticated HTTP serving,
closes only the ComfyUI it started with the same PID, then compares whisper
again even on a failed generation. It keeps its DB and image in
`gates-local-real-check` under the OS temp folder (`--data-dir` changes it). It has **not** been run
by the implementation lane.

The swap, run for real:

```sh
node apps/server/src/image/real-check.ts --execute --swap-model <chat model tag> --num-ctx 16384
```

It first loads that chat model through the app's own loader and fit
planner (the model must be installed and not already resident), so the
image job has to unload it, wait for the memory and render. It fails when
the image fit beside the model (no swap ran), when the job never left its
freeing step, or when the model is still resident afterwards, and prints
how long the unload and the wait took. `--ollama-url` defaults to the
external Ollama address. It has not been run. Real cancel, lazy chat reload and Windows
remain coordinator integration checks.
