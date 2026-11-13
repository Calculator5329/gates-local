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

Each thread keeps its own choice (`Thread.imageChoice`): the picker's pick in
an open thread (`threads.setImageChoice`), else what its last image send ran.
A job with no choice of its own, the image tool's included, runs the
thread's, else Settings' `imageChoice` (the last pick anywhere, which a new
thread starts from). A retry runs its card's choice and leaves the thread's
alone. An unset default is not kept at send; once its picture is done,
the thread keeps what it settled to, unless the thread took a choice of
its own meanwhile.

The presets are in `presets.ts`. With no choice saved, a job runs the
first of `DEFAULT_ORDER` whose files ComfyUI's own `/object_info` list
names and whose memory fits the card: FLUX.2 Klein 4B, then its compact
setup, then Z-Image Turbo int8, then MOSS-Image, each at 1024x1024. The card
is the GPU's total memory to the nearest GB, as cards are sold (`imageRoom`,
`cardBytes`: 8188 MiB is an 8 GB card), never what is free now; what other
programs hold is shown, and the job's own fit check judges it when the job
runs. Under a 4 GB card, or with ComfyUI on the CPU, there is no default:
`image.presets` says "Image mode needs a GPU with 4 GB" and an unset send is
refused with that reason; a picked setup still runs. The picker's General
group shows each tier's setup for the card (`tiersFor`): Fast is Klein from
8 GB, else compact; Balanced is Z-Image from 6 GB, else compact; Best is
MOSS from 4 GB. The default settles before
the first fit, so the fit and any unload judge the setup that will run; when
the list has never been read, the job starts (or finds) ComfyUI and reads it
first. The job reads the list again before it renders, so a default whose
files went missing is passed over without a word; a saved choice is never
swapped. A job that settles to another choice keeps the one it was sent with
as `sent`, and the card's box keeps that shape. The theme rows (portraits,
pixel art, sprites, backgrounds) run only when picked. Each setup is a
ComfyUI workflow file in `setups/` (origins and adaptations in its README),
filled in by graph shape (see "Workflows" below). Missing files produce an install-and-retry
message naming the file; the picker can download a built-in setup's files,
each checked against its SHA-256 in `setups/files.json`. The **memory figures
are caps, not measurements**: 8 GiB for Klein, 6 GiB for Z-Image int8, 4 GiB
for compact and MOSS, the owner's tier thresholds. None is a measured peak;
the coordinator must measure a setup before treating its fit as proven. When ComfyUI answers
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

## Workflows

Every setup, built in or not, is a ComfyUI workflow file. `convert.ts` turns
the file ComfyUI saves (the UI format, subgraphs included) into the API graph
ComfyUI runs; an API-format file passes through. It was written from the file
format and ComfyUI's `/object_info` answer, not from ComfyUI's frontend code.
Every node class must be one `/object_info` lists, or the setup is refused
naming it.

`controls.ts` then finds what Image mode fills in, by the graph's shape: the
one Save Image or Preview Image node, the one text that reaches a sampler's
positive input, the one empty-latent node's width and height (and any node
that repeats them, like Flux2Scheduler), and the one seed. A workflow with
none or several of one, a Load Image node, or a value worked out by another
node is refused with that reason, and the picker lists it greyed out. The
batch size is always one.

`presets.ts` matches each loader's file against the list ComfyUI gives for
that input (exact name, then the same name in a subfolder). A setup whose
files are all listed is ready; one missing files lists them as `needs`.

The app's own setups come first, grouped by theme (General, Portraits and
people, Pixel art, Game sprites, Backgrounds); a theme writes its words
around the person's prompt. After them come the workflows ComfyUI has
(`sources.ts`): its template list (`/templates/index.json`, picture
templates that start from words and do not use a paid cloud node) and the
person's saved workflows (`/userdata?dir=workflows`). They are read when the
picker asks and ComfyUI is running, converted with its `/object_info`, and
kept in `image-files.json` beside the file lists, so they stay listed while
ComfyUI is stopped. A list that cannot be read keeps the last one. Such a
workflow runs at the size it was saved with; its memory is an estimate (the
largest file it loads plus 1.5 GiB, or 10 GiB when no file's size is known).
A loader's `properties.models` says where each missing file comes from.

Last come the model files already in the folders of a ComfyUI on this
computer (`installed.ts`, group "Your models"). For each checkpoint and LoRA
ComfyUI lists, only the safetensors header is read, inside the folders its
`/internal/folder_paths` names. The family comes from the header's metadata,
else from its tensor names and shapes. An SDXL or SD 1.5 checkpoint becomes a
setup with its family's plain settings. A LoRA becomes a style at 0.8 on its
family's base, which may need that base's files. A file of a family with no
setup is listed with that reason. Inpainting and audio files are left out.

## Downloads

`image.download` fetches the files a setup needs (`download.ts`), one after
another. They go into a `gates-local/` folder inside the local ComfyUI's
first folder of each kind, which ComfyUI lists as `gates-local/<file>`.

- An address must be Hugging Face's, and may redirect once, to its own file
  hosts.
- The size comes from a HEAD request. The free space is checked first.
- The bytes go to `<file>.part`, and the file is renamed once complete. A part
  already there resumes with a Range request on a fresh link.
- The sha256 is checked against the app's record (`setups/files.json`). For a
  file with no record, the first download pins it in `image-pins.json`, and a
  later download that differs ends with a warning.
- Progress goes out on the `image.download` push: the `PullProgress` shape the
  chat-model downloads use, plus the setup, the file's place in its list, and
  `ended` on the last word (every file in, or stopped or failed on this one).
  `image.presets` carries the running download, so a picker opened later shows
  it.
- A row in `others` has `needs.download` only when every missing file has a
  Hugging Face address and a folder kind; the picker shows Download then.
- `image.stopDownload` stops that setup's download. The part is kept, and the
  next download carries on from it.
- `image.start` is the empty picker's Start ComfyUI (or Check again): it
  starts the app's ComfyUI with no job, the idle stop still applies, and
  answers `image.presets`. Nothing starts when the picker opens.

Browser tests download from the fake ComfyUI, never Hugging Face: the e2e stack
always sets `GATES_LOCAL_IMAGE_DOWNLOAD_ORIGIN` (`fetchFrom`), to the fake's
address or to a closed port. The address is still checked as Hugging Face's
first; only the origin is swapped, and only for an http address on this
computer.
