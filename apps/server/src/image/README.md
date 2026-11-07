# Image generation

`createImageModule` implements discovery, GPU fit, optional start of the
Linux `comfyui.service` user unit, one image with progress/cancel, saved
PNG and thread attachment. `createImageHandlers` matches the existing
contracts. `ws/server.ts` serves `/files/images/<jobId>.png` with the same
launch token and Origin admission as WebSocket upgrades.

The module reads settings through `settings()`, app-loaded chat models
through `appLoadedModels()`, and GPU room through `readGpu()`. Production
defaults use `fit/gpu.ts`; tests inject every runtime dependency. A custom
ComfyUI URL is discovery-only. Windows never runs systemctl. CPU-only
machines fail the default NVIDIA fit reader; a remote ComfyUI deployment
needs a GPU reader for that machine before generating there.

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

The default graph is copied from
`ai/local-ai-lab/workflows/sdxl-lightning.json` at
`c092f4d2bba88c4c76b37e34c31f9c2e28643c9c` (origin and adaptations in
`workflow.ts`). It uses the checkpoint and LoRA advertised by ComfyUI's
own `/object_info` list, 768x512, four steps. Missing files produce an
install-and-retry message. No models are downloaded. The **9 GiB image
budget is an estimate**, conservatively above the lab's 7.86 GiB warm
reading at 768x512. It is not a measured peak; the coordinator must measure
the real preset before treating its fit as proven. Fit remeasures after
unloading only app-owned chat models and after ComfyUI startup. It names
the need, free bytes, shortfall and occupants when refusing. Other programs
can allocate between a measurement and submission; this app-local lease
cannot prevent that race.

Cancellation removes a waiter locally. Submitted prompts are removed from
ComfyUI's queue or interrupted only if their prompt id is running. Cleanup
waits for that prompt to leave both queues before releasing the lease.
Progress frames are filtered by prompt id and history polling covers
cache hits. Socket errors, HTTP errors and the ten-minute job timeout
produce an error event. Saved images use an unserved `.pending` file
until the write completes, then an atomic rename. No file is deleted.

Idle stop checks app ownership, an empty job registry, an idle ComfyUI
queue, and an unchanged MainPID immediately before stopping the unit.
An external restart drops ownership. Shutdown cancels jobs, then applies
the same idle-stop rules. There are unavoidable races with another
process starting a unit or submitting work between the final check and
systemctl/interrupt; ComfyUI/systemd provide no atomic owner claim.

`pnpm verify:image` uses injected fakes plus a fake HTTP/WebSocket server
and fake Ollama, never the real services or GPU. New tests in this lane
are diagnostic probes, not independent acceptance evidence. Full
`pnpm verify` also runs the repository's pre-existing checks.

The coordinator can run the deliberately separate real check:

```sh
node apps/server/src/image/real-check.ts --execute
```

It requires whisper already running and measurable, records its PID
and GPU bytes, checks room without unloading any model, generates one
image, checks progress, thread persistence and authenticated HTTP serving,
closes only the ComfyUI it started with the same PID, then compares whisper
again even on a failed generation. It keeps its DB and image under
`~/.cache/gates-local-lanes/build-image/real-check`. It has **not** been run
by the implementation lane. Real cancel, lazy chat reload and Windows
remain coordinator integration checks.
