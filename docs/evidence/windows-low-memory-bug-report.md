# Windows low-memory setup and model switching bug report

Reported: 2026-11-13. Documentation only; no fixes are included or claimed.

The user abandoned image generation and returned to LLMs after repeated memory
refusals, manual engine management, a long first render, and confusing setup.
The main expectation is to switch between chat and images without manually
unloading models, while using supported GPU/system-RAM offloading and explaining
genuine resource limits. This report records the observed failures for triage.

## Environment and evidence scope

| Component | Observed configuration |
| --- | --- |
| App | Installed Gates Local 0.2.3; executable version 0.2.3.0 |
| OS | Windows 10 Home, 10.0.19045; the setup runbook lists Windows 11, so reproduction on the supported OS is also needed |
| GPU | NVIDIA GeForce GTX 1660 Ti, 6,144 MiB VRAM; driver 580.97 |
| System RAM | Approximately 16 GiB physical (15.92 GiB reported) |
| Storage | C: SSD initially approximately 4.6 GiB free; F: HDD approximately 876 GiB free |
| Text runtime | Separately installed Ollama; examples involved `qwen3.5:4b` and `gemma4:e4b` |
| Image runtime | Existing portable ComfyUI 0.37.0, Python 3.12.10, PyTorch 2.13.0+cu126 |
| Image allocator | DynamicVRAM enabled; comfy-aimdo 0.5.5; comfy-kitchen 0.2.35 |
| Image endpoint | `http://127.0.0.1:8188` |
| Default image setup | FLUX.2 Klein 4B compact, General, 512x512, four sampling steps |
| Later failed setup | FLUX.2 Klein 4B compact pixel art, 640x640 |

Evidence reviewed: user screenshots/error text; redirected ComfyUI stdout/stderr;
Ollama `/api/ps`; ComfyUI `/system_stats` and `/queue`; GPU and available-RAM
readings; model locations and sizes; and source at dev commit `670993c`.
Source references below are investigation leads, not proof that this exact source
matches every behavior of the installed release. No persistent Gates server log
was found in the inspected installed-data/profile locations. This is a session
report, not an exhaustive trace of every app request.

Raw chat data, screenshots containing prompts, local account names, machine
identifiers, and full process paths are intentionally omitted from this public
report. Measurements from different moments are identified as such and should
not be combined into one memory snapshot. GB is decimal; GiB/MiB are binary.

## Triage overview

| ID | Suggested priority | Failure |
| --- | --- | --- |
| WIN-MEM-01 | High | Switching text models leaves the previous model resident while the next is refused |
| WIN-MEM-02 | High | Fit refusals do not provide a usable path through supported RAM spill, smaller context, or reclaim |
| WIN-MEM-03 | High | A successful image is followed by warm/repeated image refusals with zero ComfyUI resident credit |
| WIN-MEM-04 | High | Image setup and chat/image handoff require manual engine lifecycle management |
| WIN-MEM-05 | Medium | Memory-holder diagnostics contain unknown sizes and broken application names |
| WIN-MEM-06 | Medium | Long first render looks stuck; default suitability and phase progress are unclear |
| WIN-SETUP-01 | Medium | Low-disk/existing-install setup and shared download progress are confusing |

Priorities describe user impact, not confirmed root causes. Some entries overlap
and may be resolved together.

## WIN-MEM-01: text-model switching does not reclaim the previous idle model

**Reproduction:** Load `qwen3.5:4b`, finish its chat turn, select `gemma4:e4b`
with a 16,384-token context, and attempt to use it under memory pressure.

**Observed:** The selected model was refused while Qwen remained in `/api/ps`.
Qwen reported `size` and `size_vram` of 3,553,760,377 bytes. A corresponding
GPU snapshot showed 5,481 MiB used and 486 MiB free; available system RAM was
approximately 2.66 GiB. The UI error began:

```text
gemma4:e4b at num_ctx 16384 needs 8.20 GB (estimate);
VRAM usable 0.00 GB (0.53 GB free minus 0.54 GB margin)
```

**Manual diagnostic:** An explicit Ollama unload request for Qwen
(`keep_alive: 0`) emptied `/api/ps`. A subsequent GPU reading showed 1,297 MiB
used and 4,670 MiB free; available RAM increased to approximately 3.73 GiB.
This confirms that reclaimable text-model memory existed. It does not prove
that Gemma would fit after reclaim; see WIN-MEM-02.

**Expected:** For an idle model the app is authorized to unload, serialize the
handoff, unload it, wait for the runtime to acknowledge release, remeasure, and
then decide whether the requested model fits. Show which stage is running.
Preserve active turns and ownership boundaries; do not kill unrelated runtimes.

**Investigation leads:** `apps/server/src/runtime/load.ts`, runtime services,
`apps/server/src/fit/fit.ts`, and the model-selection/admission callers. Check
whether fit happens before reclaim and whether models already resident when
the app connects are distinguished from models it may unload.

## WIN-MEM-02: conservative admission leaves no practical fallback

**Observed after manual Qwen unload:** A source-level, read-only fit calculation
still refused Gemma. These are diagnostic estimates, not a successful or failed
Ollama load attempt:

| Setting | Estimate / reading |
| --- | --- |
| Context 16,384 | Estimated need 8,200,560,697 bytes |
| Free VRAM | Approximately 4.93 GB; approximately 4.39 GB usable after reserve |
| Available RAM | Approximately 4.32 GB; approximately 2.17 GB usable after reserve |
| Verdict at 16,384 | Refused; estimated shortfall approximately 1.63 GB |
| Context 4,096 | Estimated need 7,848,239,161 bytes; refused, approximately 1.29 GB short |

The inspected source already implements RAM spill. It reserves 512 MiB VRAM
and 2 GiB available RAM, and includes runtime overhead in the estimate. The
user experienced this as system RAM being ignored because switching and retrying
still led to refusals without a useful recovery path.

**Expected:** Reclaim eligible idle memory before the final decision; explain
GPU memory, available system RAM, reserves, and estimated shortfall clearly.
Offer a supported smaller context/model or slower offload mode when one actually
fits. Investigate estimate/reserve calibration on this hardware. Do not assume
all installed RAM is available, promise that Gemma fits, or bypass real limits.

**Unproven:** No controlled Ollama load established that this particular Gemma
configuration could succeed in the available memory. No evidence here justifies
removing all safety margins or forcing CPU-only execution.

**Investigation leads:** `apps/server/src/fit/constants.ts`, `fit.ts`, runtime
admission, and the UI's refusal/fallback presentation.

## WIN-MEM-03: warm image requests fail after one successful image

**Reproduction:** Finish downloading the compact setup, render one General
512x512 image successfully, then request two more images in the same session.

**Observed:** The first image completed. Both subsequent image cards failed
(`0 of 2`), initially saying 4.0 GiB was needed and 2.6 GiB was free. The full
diagnostic later said:

```text
Image generation needs 4.0 GiB, 2.5 GiB free, 1.5 GiB short
(estimated total 4.0 GiB, credited ComfyUI resident 0.0 GiB).
```

No second `got prompt` appeared in the inspected ComfyUI log after those
failures, consistent with refusal before submission rather than a render OOM.
At a separate post-render `/system_stats` snapshot, CUDA reported:

```text
vram_total:       6442123264
vram_free:        3757325224
torch_vram_total:   33554432
torch_vram_free:    24394664
```

ComfyUI reported DynamicVRAM and async weight offloading. Windows per-process
GPU usage was unavailable. The inspected app source uses measured resident
bytes for the managed PID, falling back to `torch_vram_total`. A possible cause
is that this fallback under-represents reusable allocations with this allocator;
that remains a hypothesis. Global used VRAM cannot safely be credited to ComfyUI
because it also includes other applications.

**Later evidence:** The user also supplied a single-image refusal for the
640x640 compact pixel-art preset: `The image needs 4.0 GiB and 3.9 GiB is free.`
These rounded values do not establish the exact deficit or prove the image
would fit, but demonstrate another hard refusal near the threshold with no
visible automatic fallback.

**Diagnostic intervention:** With the ComfyUI queue confirmed empty, a manual
`POST /free` using `unload_models: true` and `free_memory: true` was sent.
No successful retry was established afterward; this is not a confirmed fix.

**Expected:** Repeated and batch requests should account for known reusable
memory, or safely release eligible idle cache and remeasure before refusing.
Keep admission consistent across the first and later images. Unknown ownership
must remain unknown; never assign all GPU usage to this process. Explain a real
deficit and offer a smaller supported preset when available.

**Investigation leads:** `apps/server/src/image/module.ts`, `client.ts`,
`presets.ts`, Windows GPU measurement, external-versus-managed endpoint handling,
and batch-job memory sequencing. Validate with the actual DynamicVRAM allocator,
not only a fake whose resident value equals the Torch reservation.

## WIN-MEM-04: downloads and chat/image transitions require manual lifecycle work

**Observed during setup:** The external ComfyUI process used approximately
0.7-1.0 GiB working set while model files were still downloading. The user
reported being unable to comfortably use LLMs. Stopping that process allowed
the Gates download to continue on F: without the image engine running. It was
restarted after all three files completed. Downloading did not require keeping
the heavy runtime alive.

The setup page initially showed an unconnected endpoint and directed the user
to install ComfyUI separately, although a portable installation already existed.
Manual discovery, launch, model-path configuration, and stop/restart steps were
needed. Chat/image switching also led to manual text-model unloads and an image
cache-release request. Seamless round-trip handoff was not demonstrated.

The diagnostic ComfyUI launch used:

```text
--windows-standalone-build --lowvram --fp32-vae
--listen 127.0.0.1 --port 8188 --disable-auto-launch
```

**Expected:** A file transfer should not require loading model weights or
keeping an otherwise unnecessary app-managed engine resident. Chat -> image ->
chat should coordinate eligible idle resources, report progress, and recover
from cancellation or failure. For an existing external runtime, provide clear
connection and ownership status and an explicit opt-in managed setup if needed.
Do not silently adopt or stop a process the app did not start; preserve whisper,
other applications, and active work.

**Investigation leads:** `apps/server/src/image/own.ts`, `engine.ts`,
`service.ts`, `module.ts` (`stopIdle`), download orchestration, and chat admission.
Confirm which Windows lifecycle capabilities are enabled in the installed build.

## WIN-MEM-05: memory-holder errors do not identify actionable applications

**Observed:** The full refusal listed entries such as `[Insufficient (unknown)`,
`C:\Program (unknown)`, Windows shell components, Discord, desktop applications,
and Python. It repeated unknown sizes and included long executable paths.
This did not identify which application held a meaningful amount of RAM or
VRAM, nor what the user could safely close. Some names were truncated at spaces.

**Expected:** Show a friendly application name, reliable process identity,
measured RAM and VRAM separately, and whether each value is unavailable.
Rank known consumers by the relevant resource; show unknowns separately without
inventing sizes. Explain Windows/WDDM measurement limitations. Avoid dumping
full personal paths or suggesting that users close protected system processes.
Offer an actionable summary such as a measured application's consumption, rather
than an unqualified list of every GPU-associated process.

**Investigation leads:** GPU/process command parsing, Windows memory readings,
`imageFitError`, and the fit-error UI. Cover names with spaces and unavailable
NVML values. System RAM consumption is not a substitute for measured VRAM.

## WIN-MEM-06: cold rendering appears stuck and default performance is unclear

**Observed:** The UI showed a spinner and elapsed time at 91 seconds without
enough phase information for the user to know whether work was progressing.
The ComfyUI log shows a successful job, not a hang:

```text
Requested to load Flux2TEModel_
Requested to load Flux2
Model Initializing ...
Model Initialization complete!   [approximately 43 seconds in sampling display]
4/4                            [approximately 67 seconds in sampling display]
Requested to load AutoencoderKL
Prompt executed in 199.40 seconds
```

The full job includes loading, initialization, sampling, and decoding; the
sampling display is not a complete breakdown. Logs show emulated FP4/FP8
operations, manual casting to float32 for the diffusion model, CPU offloading,
and `fast_disk=False` for models on the secondary HDD. These are performance
investigation leads, not independently measured causes of the 199-second total.

**Expected:** Report connection, queueing, model loading, initialization,
sampling progress, and decoding when the backend exposes them. Distinguish a
slow first run from an actual stall, keep cancellation clear, and describe the
recommended preset's tested hardware/performance limitations. A four-step model
should not imply a fast end-to-end cold start. Warm-run timing was not measured.

## WIN-SETUP-01: disk planning and download presentation add setup confusion

**Observed:** The three required default files total 8,255,049,810 bytes
(approximately 8.3 GB), exceeding the initial 4.6 GiB free on C:. F: had ample
space. The user explicitly chose F: and later asked to cancel any C: downloads
because the system drive was almost full. C: readings subsequently reached
approximately 0.07-0.11 GiB free, but the cause of that decrease was not isolated.
The inspected active new transfer was on F:, so duplicate downloads onto C:
are not established by this report.

| Required file | Bytes |
| --- | ---: |
| `flux-2-klein-4b-fp8.safetensors` | 4,070,624,520 |
| `qwen_3_4b_fp4_flux2.safetensors` | 3,848,213,998 |
| `flux2-vae.safetensors` | 336,211,292 |

An external-model-path configuration pointing to `F:/AI/ComfyUI/models` was
added manually. Fifteen existing ComfyUI model files totaling approximately
26.65 GiB were moved from the system drive with hash verification; this restored
approximately 41 GiB free. Ollama's installation and model store were retained.
This migration was a manual setup intervention, not an automatic app feature.

The picker displayed the same `File 1/3 - 26% - 68 min left` progress under
General, People, Characters, Pixel art, Game sprites, Backgrounds, and Icons.
These presets share dependencies; the screenshot does not prove separate
downloads. Ordinary Windows file listings also showed a stale small file length
while reading the open file showed gigabytes already written, so apparent lack
of growth was not sufficient evidence of a stalled transfer.

**Expected:** Before a large transfer, show the actual destination, total
remaining bytes, temporary/cache-space needs, and space available on the
affected volume. Let users choose an existing installation/model directory or
secondary drive before downloading. Explain shared preset dependencies and
show one clear aggregate transfer state with cancel/resume behavior. Cancellation
should explain partial-file handling without deleting unrelated models.

**Investigation leads:** Image setup/discovery, model-path selection, download
destination and temporary files, progress accounting, and disk-space preflight.

## Reproduction and acceptance matrix

Use this hardware class with a supported Windows version as well as the reported
Windows 10 environment. Collect synchronized pre/post readings, runtime ownership,
active jobs, selected context/preset, admission estimates, reserves, and results.

| Scenario | Expected validation |
| --- | --- |
| Idle text A -> text B | Eligible A is released before the final measurement; B loads or gives a specific actionable refusal |
| Text -> image -> text | Coordinated handoff without user-issued unload commands; no interference with active or foreign work |
| Cold image -> warm image -> batch of two | Correct resident accounting/reclaim; no false refusal solely because the preceding job left reusable memory |
| Near-threshold 640x640 image | Explain exact estimated deficit and offer a supported smaller option if it fits |
| Insufficient VRAM, sufficient usable RAM | Use supported partial offload, with slower-mode expectations and bounded memory use |
| Insufficient combined usable memory | Refuse safely with a useful context/model/preset alternative when available |
| Download while chatting | Transfers continue without unnecessary model residency; destination and shared progress stay clear |
| WDDM reports unavailable per-process VRAM | Friendly names, explicit unknown measurements, no fabricated reusable-memory credit |
| Other applications consume memory | Identify measured consumers separately for RAM/VRAM; never terminate them automatically |
| External runtime / active whisper | Ownership and protection rules remain intact through switching, cancellation, and retries |
| Low C: space, ample secondary disk | Select the secondary destination up front; account for temporary storage on every affected volume |
| Rapid switches, cancellation, failed load | No stale ownership, stranded loads, permanent busy state, or double admission |

Success means a practical recovery path and honest diagnostics on a constrained
machine. It does not mean every model must fit or that unrelated processes may
be evicted. No implementation, successful warm retry, or performance improvement
is asserted by this report.
