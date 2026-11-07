# Gates Local setup tiers: research, 2026-11-07

Research lane `research-tiers`. Read-only. Every fact has a URL or a local
path. Three labels are used throughout:

- **measured**: someone ran it. Who, on what hardware, and how old it is are given.
- **computed**: worked out from model geometry with the app's own estimator
  (`apps/server/src/fit/estimate.ts`: weights + f16 KV + 1 GiB overhead). The
  script is in the scratchpad (path at the end).
- **est.**: a third-party estimate or a vendor claim, or my own arithmetic from
  a measured neighbour. It is never presented as a measurement.

Source ages: Ollama library pages were read today (relative dates converted to
absolute where the page gave them). Third-party guides are from 2025-12 to
2026-11; each one is dated where it is cited.

---

## 0. What changes the plan (read first)

1. **Qwen-Image-2.1 has a non-commercial licence.** Its model card and Ethan's
   local `~/models/Qwen-Image-2.1/LICENSE` both say "Qwen Research License
   Agreement" (the Comfy-Org repack is tagged `qwen-research`). The app is
   public, so it cannot be a default pick in the tier table. At most it can be
   an opt-in that the user picks after reading the licence.
   [HF card](https://huggingface.co/Qwen/Qwen-Image-2.1),
   [Comfy-Org repack](https://huggingface.co/Comfy-Org/Qwen-Image-2.1)
2. **FLUX 3 Image [klein] came out on 2026-11-02** (HF repos modified
   2026-11-02/03). Three things keep it out of the table for now:
   - The licence is the FLUX Kommunity License: output use is free only for
     "Qualifying Users" under US$5M revenue.
   - The repos are gated (you accept terms with an HF account), which breaks
     unattended setup.
   - BFL's own peak memory at 1024² on a B200 is 25 GB (NVFP4) to 31 GB (BF16).

   Revisit it when someone measures it on a consumer card.
   [model card](https://huggingface.co/black-forest-labs/flux-3-image-klein),
   [comfy repo](https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy).
   FLUX.2 [klein] 9B is non-commercial (FLUX NCL), while 4B is Apache-2.0
   ([BFL blog](https://bfl.ai/blog/flux2-klein-towards-interactive-visual-intelligence),
   [4B card](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B)).
3. **On CPU, the honest default for images is "off".** These are the
   per-image times I found:
   - Z-Image-Turbo at 512², 8 steps, in ComfyUI v0.43.0 took **391 s
     including model load** on a Ryzen 9 9955HX with no dGPU (measured,
     2026-10-31). [PR](https://github.com/alwaldend/src/pull/223)
   - FastSD CPU on an i7-12700 measured these (not ComfyUI; PyTorch path).
     [FastSD CPU](https://github.com/rupeshs/fastsdcpu)
     - SD-Turbo, 1 step, 512²: 7.8 s
     - SDXL-Turbo, 1 step, 512²: 10 s
     - SDXL-Lightning, 2 steps, 768²: 18 s

   The plan's rule, "smallest CPU model, off unless the user says yes", fits
   the evidence. The CPU tier should offer only 1–2 step models.
4. **SD-Turbo and SDXL-Turbo are not freely licensed.** Both are under the
   Stability AI Community License (free for research, non-commercial use, and
   commercial use under US$1M revenue). The SDXL-Turbo repo is tagged
   `sai-nc-community`.
   [sd-turbo LICENSE](https://huggingface.co/stabilityai/sd-turbo/raw/main/LICENSE.md),
   [sdxl-turbo](https://huggingface.co/stabilityai/sdxl-turbo).
   SDXL-Lightning (`openrail++`) and SDXS (`openrail++`) are the permissive
   options for weak hardware.
   [SDXL-Lightning](https://huggingface.co/ByteDance/SDXL-Lightning),
   [SDXS](https://huggingface.co/IDKiro/sdxs-512-0.9)
5. **Two design names do not exist as Ollama tags.** Three more are local
   aliases (section 1.1).
6. **The app's fit estimator overcounts KV for gpt-oss and Gemma 3.** Their
   `/api/show` `model_info` has `attention.sliding_window` but no
   `sliding_window_pattern` (checked locally, Ollama 0.40.4 server). So
   `estimate.ts` treats every layer as full attention.
   - **gpt-oss:20b at 16k:** computed 15.67 GB. A T4 measured 13.0 GB at
     32K and 13.7 GB at 60K
     ([localllm.in, 2025-12-25](https://localllm.in/blog/best-local-llms-16gb-vram)).
   - **gemma3-abliterated:12b at 16k:** computed 6.44 GB of KV. With the
     real 5:1 local:global pattern it is about 1.6 GB (my arithmetic: 8
     global layers × 8 kv-heads × 512 × 16384 × 2 B, plus 40 SWA layers at a
     1024+512 window).

   This would wrongly push gpt-oss:20b off a 16 GB card. It needs a fix in
   `estimate.ts`: a per-architecture default pattern of 1:1 for gptoss and
   5:1 for gemma3.
7. **The estimator also overestimates qwen3.5:9b by about 1 GB.** Computed:
   8.21 GB at 16k. The comment at `apps/server/src/fit/fit.ts:103` records a
   real load on Ethan's card: `size_vram` 5.92 GB, runner 6926 MiB = 7.26 GB
   in nvidia-smi (num_ctx not recorded there). The measured load fits an
   8 GB card. The computed number does not.
8. **Windows CPU caveats.**
   - Ollama on Windows needs no admin and installs per user
     ([docs](https://raw.githubusercontent.com/ollama/ollama/main/docs/windows.mdx)).
   - A CPU without AVX/AVX2 crashes the runner with 0xc0000409. That claim
     is from a third-party guide, unverified against an Ollama issue for
     0.40 ([dev.to, 2026](https://dev.to/jovan_chan_9500711396d4e6/ollama-llama-runner-process-has-terminated-read-the-exit-code-then-fix-it-2026-4b6h)).
     The probe should read the CPU flags.
   - The OpenVINO 2026.3 CPU plugin requires AVX2
     ([cameraui PR quoting release notes](https://github.com/cameraui/plugins/pull/287)).
   - ComfyUI has no CPU-specific portable. The NVIDIA portable "should work
     for … running on your CPU only"
     ([README](https://raw.githubusercontent.com/Comfy-Org/ComfyUI/master/README.md)).
     That build is 2.05 GB of CUDA torch on a machine that cannot use it.
     The cheaper path is unverified (see 3.2).
9. **Turn thinking off on CPU by default.** qwen3.5:2b on 4 vCPU with
   thinking on wrote 3,878 hidden tokens and took 4 min 37 s; with thinking
   off the same prompt took 4 s (measured, Oct 2026,
   [computingforgeeks](https://computingforgeeks.com/ollama-local-llm-fedora-cpu/)).
   K2 Horizon cannot turn reasoning off
   ([ollama page](https://ollama.com/ifm/k2-horizon)), which rules it out on
   CPU.

---

## 1. Text models (Ollama)

### 1.1 Design names checked (`docs/design/shell.md`, "Words used everywhere")

Local facts are from `ollama show` on this machine (server 0.40.4). Library
facts are from the tags pages, read 2026-11-07.

| Design name | Real tag? | What it is |
|---|---|---|
| Qwen 3.5 9B | **Yes**: `qwen3.5:9b` | 9.7B, Q4_K_M, 6.6 GB, vision + tools + thinking (on by default), Apache-2.0, needs Ollama ≥ 0.17.1. Released 2026-03-02 ([AA](https://artificialanalysis.ai/models/qwen3-5-9b)). [tags](https://ollama.com/library/qwen3.5/tags) |
| Qwen 3.5 14B | **NO.** There is no 14B. | qwen3.5 sizes: 0.8b, 2b, 4b, 9b, 27b, 35b(-a3b), 122b. `qwen3.5:14b` appears 4 times in the repo and would fail to pull. [tags](https://ollama.com/library/qwen3.5/tags) |
| Gemma 4 12B | **Yes**: `gemma4:12b` | 11.9B, Q4_K_M, 7.7–8.0 GB, vision + audio + tools + thinking, Apache-2.0 (from `ollama show --license`), needs Ollama ≥ 0.30.5. [tags](https://ollama.com/library/gemma4/tags) |
| Gemma 3 12B abliterated | **Local alias only**: `gemma3-abliterated:12b-q4` | Built from `mlabonne/gemma-3-12b-it-abliterated` (Gemma licence, Q4_K_M, 8.2 GB, vision, **no tools, no thinking**). No library tag exists. The closest public one, `huihui_ai/gemma3-abliterated:12b`, is 24 GB (fp16); its 12b-q8_0 is 13 GB. [HF](https://huggingface.co/mlabonne/gemma-3-12b-it-abliterated-GGUF), [huihui tags](https://ollama.com/huihui_ai/gemma3-abliterated/tags) |
| gpt-oss 20B | **Yes**: `gpt-oss:20b` | 20.9B MoE (3.6B active), MXFP4, 13–14 GB, tools + thinking (low/medium/high, no off), no vision, Apache-2.0. [tags](https://ollama.com/library/gpt-oss/tags) |
| Gemma 4 26B abliterated | **Local alias only**: `gemma4-abliterated:26b` | Pulled from `hf.co/llmfan46/gemma-4-26B-A4B-it-ultra-uncensored-heretic-GGUF:Q4_K_M` (Apache-2.0, 25.2B MoE A4B, 17–18 GB, vision + tools + thinking). It is not a library tag. A fresh machine needs the `hf.co/...` name. [HF](https://huggingface.co/llmfan46/gemma-4-26B-A4B-it-ultra-uncensored-heretic-GGUF) |
| Qwen 3.8 27B abliterated | **Local alias only**: `qwen3.8-abliterated:27b` | Pulled from `hf.co/0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF:IQ3_M` (Apache-2.0, IQ3_M, 13.2 GB, vision + tools + thinking). A library-namespace equivalent exists: `huihui_ai/Qwen3.8-abliterated:27b-q3_K` is 14 GB, and `:27b` (Q4_K_M) is 18 GB. [HF](https://huggingface.co/0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF), [huihui tags](https://ollama.com/huihui_ai/Qwen3.8-abliterated/tags) |

The local aliases also break on any other device. The tier table must store
the pullable name (`hf.co/...:QUANT` or `namespace/name:tag`), never the
alias.

**Ollama has no official abliterated models.** Every "Fewer refusals" pick is
a third-party repack, and its licence follows the base model.

### 1.2 Tier picks

How to read the table:

- **"16k mem"**: the computed number from the app's estimator, unless marked
  otherwise.
- **"tok/s"**: given only where someone measured it. The hardware is always
  named.
- **"tools / think"**: Ollama's own capability flags, from the library page
  or local `ollama show`.

| Tier | Pick | Tag | Download | Quant | 16k mem | tools / think | License | Speed seen | Why |
|---|---|---|---|---|---|---|---|---|---|
| **GPU 6 GB** | first | `qwen3.5:4b` | 3.3 GB | Q4_K_M | 4.84 GB computed (8 full-attn layers × 4 kv × 512, from [config](https://huggingface.co/Qwen/Qwen3.5-4B)) | yes / yes (+vision) | Apache-2.0 | none found | The newest official small Qwen with tools, thinking and vision. It leaves about 1 GB free on a 6 GB card at 16k. Picked over Gemma 4 E4B because E4B is 6.6 GB and does not fit. [tags](https://ollama.com/library/qwen3.5/tags) |
| GPU 6 GB | alt | `bonsai-2:9b` | 3.2 GB | ternary `q2_0` | unverified: geometry not checked | yes / yes (+vision) | Apache-2.0 | none found | A 9B in ternary weights, at half the size of 4-bit. The vendor claims it is "close to full-precision quality", but no independent benchmark exists. It uses a new format, so check the Ollama version. [page](https://ollama.com/library/bonsai-2), [cfg cheat sheet, 2026-10-26](https://computingforgeeks.com/ollama-models-cheat-sheet/) |
| **GPU 8 GB** | first | `qwen3.5:9b` | 6.6 GB | Q4_K_M | 8.21 GB computed; **7.26 GB measured** (runner, Ethan's card, `fit.ts:103`) | yes / yes (+vision) | Apache-2.0 | measured: 67.7 tok/s at 4K on an RTX 5060 Ti and 127.9 on an RTX 4090 ([cfg, 2026-10-26](https://computingforgeeks.com/ollama-models-cheat-sheet/)) | The most common 8 GB pick across the 2026-10/11 guides. It is the app's existing default. [cfg](https://computingforgeeks.com/ollama-models-cheat-sheet/) |
| GPU 8 GB | alt | `mimo-v2.6:9b` | 6.6–8.7 GB (default tag size unverified) | not stated | ≈ qwen3.5:9b (same base) est. | yes / yes (+vision) | MIT | none found | A Xiaomi fine-tune of Qwen3.5-9B. On Xiaomi's own numbers it gains on agent and tool tasks: Toolathlon 25.9 → 35.2, AutomationBench 5.0 → 30.3. It is four days old and not independently checked. [page](https://ollama.com/library/mimo-v2.6) |
| **GPU 12 GB** | first | `gemma4:12b` | 7.7–8.0 GB | Q4_K_M | 9.40 GB computed (9.67 at 32k) | yes / yes (+vision, audio) | Apache-2.0 | measured: 97.1 tok/s on an RTX 4090 (Sept) ([cfg](https://computingforgeeks.com/ollama-models-cheat-sheet/)) | The consensus 12 GB pick ([cfg](https://computingforgeeks.com/ollama-models-cheat-sheet/), [promptquorum, 2026-11-07](https://www.promptquorum.com/local-llms)). Ollama's page gives no 12B benchmark numbers; only E2B/E4B/26B/31B are listed. |
| GPU 12 GB | alt | `bonsai-2:27b` | 8.3 GB | ternary `q2_0` | unverified | yes / yes (+vision) | Apache-2.0 | measured: 84.2 tok/s on an RTX 4090 and 44.2 on an RTX 5060 Ti ([cfg](https://computingforgeeks.com/ollama-models-cheat-sheet/)) | A 27B-class model in 12 GB. Its quality rests on the vendor's claim. |
| **GPU 16 GB** | first | `gpt-oss:20b` | 13.8 GB (file), 14 GB (page) | MXFP4 | 15.67 GB computed, **overstated** (§0.6); measured on a T4: 12.2 GB at 4K, 13.0 GB at 32K, 13.7 GB at 60K | yes / yes (levels, no off) | Apache-2.0 | measured: 94.5 tok/s at 4K, 94.8 at 64K (RTX 5060 Ti) ([cfg](https://computingforgeeks.com/ollama-models-cheat-sheet/)); 42 tok/s on a T4 ([localllm.in](https://localllm.in/blog/best-local-llms-16gb-vram)) | Every 16 GB guide picks it. It stays fully on the GPU even at 64K. It has no vision. On Ethan's card, whisper (2.2 GB) plus media-vault (1.8 GB) leave about 12 GB, so his machine is really a "12 GB" tier for chat. |
| GPU 16 GB | alt | `gemma4:12b-it-q8_0` | 13 GB | Q8_0 | ≈ 14.4 GB computed (gemma4:12b KV and overhead + 13 GB) | yes / yes (+vision) | Apache-2.0 | none found | Keeps vision, which gpt-oss lacks, at a higher quant. An unverified option: `gemma4:12b-it-qat`, 7.2 GB, 53.0 tok/s on a 5060 Ti ([cfg](https://computingforgeeks.com/ollama-models-cheat-sheet/)). |
| **GPU 24+ GB** | first | `qwen3.8:27b` | 18 GB | Q4_K_M | ≈ 20.1 GB computed (18 GB + 1.07 GB KV from the local qwen3.8 geometry + 1 GiB) | yes / yes (+vision) | Apache-2.0 (base, per the HF repack card) | measured: 120.3 tok/s on an RTX 4090 ([cfg](https://computingforgeeks.com/ollama-models-cheat-sheet/)) | The highest open model under 40B on the AA Progress Index v1: 303 at Xhigh, against 254 for Gemma 4 31B ([AA small](https://artificialanalysis.ai/models/open-source/small), page undated). Every guide picks it for 24 GB ([promptquorum](https://www.promptquorum.com/local-llms)). |
| GPU 24+ GB | alt | `gemma4:26b` | 16–19 GB (`26b-a4b-it-q4_K_M` 18 GB) | Q4_K_M | ≈ 19.7 GB computed (local abliterated twin: 17.99 + 0.65 + 1 GiB) | yes / yes (+vision) | Apache-2.0 | measured: 311.7 tok/s on an RTX 4090 ([cfg](https://computingforgeeks.com/ollama-models-cheat-sheet/)) | A MoE with 4B active, about 2.6× faster than qwen3.8:27b. MMLU-Pro 82.6, GPQA 82.3 (vendor numbers on the [library page](https://ollama.com/library/gemma4)). |
| **CPU, 8 GB RAM** | first | `qwen3.5:2b` | 2.7 GB (default; `2b-q4_K_M` 1.9 GB) | Q8_0 default | ≈ 3.9 GB computed (6 full-attn layers × 2 kv) | yes / yes (+vision) | Apache-2.0 | measured: 14–16 tok/s with thinking off, 4 vCPU VM, Ollama 0.40.11 ([cfg Fedora, 2026-10-26](https://computingforgeeks.com/ollama-local-llm-fedora-cpu/)) | Tools and vision at a speed you can live with. AA Progress 171–177 ([AA tiny](https://artificialanalysis.ai/models/open-source/tiny)). Run it with `think:false`. |
| CPU, 8 GB RAM | alt | `llama3.2:3b` | 2.0 GB | Q4_K_M | not computed | yes / no | Llama 3.2 Community (has restrictions, not OSI) | measured: 23.8 tok/s (Ryzen AI 5 340, 16 GB), 9.1 (Intel N150) ([geerlingguy](https://github.com/geerlingguy/ai-benchmarks)); 11.3 on 4 vCPU ([cfg](https://computingforgeeks.com/ollama-models-cheat-sheet/)) | Has the most CPU measurements of any small model; it never thinks. Note: `gemma4:e2b` measured only 3.2–3.6 tok/s on CPU ([cfg Fedora](https://computingforgeeks.com/ollama-local-llm-fedora-cpu/)). The VM had 7.7 GiB of RAM, so memory pressure is possible (unverified). Avoid it on CPU until re-measured. |
| **CPU, 16 GB RAM** | first | `qwen3.5:4b` | 3.3 GB | Q4_K_M | 4.84 GB computed | yes / yes (+vision) | Apache-2.0 | none measured on CPU. est. about half of the 2b's speed (≈ 7 tok/s on 4 vCPU; my arithmetic, weights 3.3 vs 2.7 GB at different quants, so loose) | A big quality step over 2b, with room for the OS and Electron. |
| CPU, 16 GB RAM | alt | `qwen3.5:9b` | 6.6 GB | Q4_K_M | 7.26–8.21 GB (measured/computed) | yes / yes (+vision) | Apache-2.0 | none on CPU. est. 2–8 tok/s for 7B-class on a laptop CPU ([promptquorum](https://www.promptquorum.com/local-llms), an estimate) | Best quality that fits. Slow. Offer it as "Careful, slower". |
| **CPU, 32+ GB RAM** | first | `gpt-oss:20b` | 13.8 GB | MXFP4 | 13–14 GB measured on GPU (above) | yes / yes (no off) | Apache-2.0 | measured: **8.52 tok/s** CPU-only on a Framework 13 mainboard ([geerlingguy](https://github.com/geerlingguy/ai-benchmarks)) | The MoE has 3.6B active, so it runs at small-model speed with 20B quality. Thinking can only go down to "low". |
| CPU, 32+ GB RAM | alt | `gemma4:26b` | 16–19 GB | Q4_K_M | ≈ 19.7 GB computed | yes / yes (+vision) | Apache-2.0 | none on CPU (searched; not found) | A MoE with 4B active; it keeps vision and lets thinking turn off. Its speed on CPU is unverified. |

Candidates I looked at and did not pick:

- **`ifm/k2-horizon:7b`** (5.6 GB, Apache-2.0, tools + thinking, text only).
  AA Progress 263, above Gemma 4 31B. Reasoning is forced on, it needs
  ≥ 32k context, and reasoning is dropped across turns. That makes it bad for
  the app's chat and a poor fit for CPU. [page](https://ollama.com/ifm/k2-horizon),
  [AA](https://artificialanalysis.ai/models/open-source/small)
- **`ornith-1.5:9b`** (6.6 GB, vision + tools + thinking, released
  2026-08-19). The maker and licence are not stated on the page, so I cannot
  check the licence. [page](https://ollama.com/library/ornith-1.5)
- **`qwen3.6:35b-a3b`** (23 GB). It is too tight for 24 GB at 16k, and
  qwen3.8:27b outranks it on AA (261 vs 303).
  [tags](https://ollama.com/library/qwen3.6/tags)

---

## 2. Image models (ComfyUI)

Ethan's machine is the ground truth for 16 GB (RTX 5070 Ti; ComfyUI 0.27.0
then; see `local-ai-lab/docs/gen.md`, `docs/reports/sdxl-lightning-bench.md`).
The local files and sizes were read from
`~/.local/share/local-ai-lab/comfyui/models`.

### 2.1 Measured on Ethan's card

| Engine | Path | Measured | Peak VRAM |
|---|---|---|---|
| FLUX.2 Klein 4B fp8, 4 steps | ComfyUI core nodes (`workflows/flux-default.json`) | 768×512 warm: **7.04 s**. 512×512: 22.2 s submit-to-image cold, 30.4 s including ComfyUI start and stop (2026-07-12 / 2026-09-24) | **12.2 GB** |
| SDXL-Lightning 4-step (+ pixel LoRA) | ComfyUI core nodes (`workflows/sdxl-lightning.json`) | 768×512 warm, fresh seed: **0.587 s**. 1024×1024: 26.4 s including start and stop. **512×512 gives noise**, so stay at ≥ 768 | **7.86 GiB** |
| Qwen-Image-2.1 fp8 two-phase | **Not ComfyUI**: diffusers venv `~/.venvs/qwen-image` | 512×512: 50.4 s end to end, 11 s denoise at 30 steps (2026-09-24) | about 9 GB floor (a rough reading, not a peak) |

### 2.2 Tier picks

| Tier | Pick | Weights (HF repo / file) | Total download | Memory | Steps · time | License | Workflow |
|---|---|---|---|---|---|---|---|
| **NVIDIA 16+ GB** | first | **FLUX.2 Klein 4B fp8**: `black-forest-labs/FLUX.2-klein-4b-fp8` / `flux-2-klein-4b-fp8.safetensors` (4.071 GB); `Comfy-Org/Flux-2-Klein-4B` / `split_files/text_encoders/qwen_3_4b.safetensors` (8.045 GB) and `split_files/vae/flux2-vae.safetensors` (0.336 GB) | **12.45 GB** | 12.2 GB peak, **measured** on Ethan's card | 4 steps, cfg 1 · 7.04 s at 768×512 warm (**measured**). 1024² not measured. | **Apache-2.0** | Core nodes only (UNETLoader, CLIPLoader type `flux2`, Flux2Scheduler, EmptyFlux2LatentImage, SamplerCustomAdvanced), i.e. `local-ai-lab/workflows/flux-default.json`. A built-in template exists per a third-party guide; its exact name is unverified. [BFL fp8](https://huggingface.co/black-forest-labs/FLUX.2-klein-4b-fp8), [Comfy-Org](https://huggingface.co/Comfy-Org/Flux-2-Klein-4B) |
| NVIDIA 16+ GB | alt | **Z-Image-Turbo** (6B, Alibaba Tongyi): `Comfy-Org/Z-Image-Turbo` / `split_files/diffusion_models/z_image_turbo_int8_convrot.safetensors` (6.201 GB), `split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors` (5.632 GB), `split_files/vae/ae.safetensors` (0.335 GB). The bf16 diffusion file is 12.31 GB. | **12.17 GB** (int8) / 18.3 GB (bf16) | est. about 8 GB for fp8/int8 (third-party guides; not measured) | about 8 steps · est. ~14 s at 1024² on an RTX 3060 12 GB (third-party table, settings unclear, unverified) | **Apache-2.0** | ComfyUI built-in Z-Image template ([comfy.org](https://comfy.org/workflows/model/z-image/)). The `int8_convrot` format needs a recent ComfyUI; the minimum version is unverified. [repo](https://huggingface.co/Comfy-Org/Z-Image-Turbo) |
| **NVIDIA 8–12 GB** | first | **FLUX.2 Klein 4B fp8** with the small text encoder: `flux-2-klein-4b-fp8.safetensors` (4.071 GB) + `Comfy-Org/Flux-2-Klein-4B` / `qwen_3_4b_fp4_flux2.safetensors` (3.848 GB) + `flux2-vae.safetensors` (0.336 GB) | **8.26 GB** | unverified below 16 GB. ComfyUI loads the text encoder and the diffusion model in turn, and 4.07 GB of diffusion weights should fit. BFL quotes "~13 GB" for the bf16 build. | 4 steps · no time found | Apache-2.0 | Same core-node graph. Whether the fp4 encoder runs fast on pre-Blackwell cards is unverified, and fp8 compute is native only on Ada and later (an assumption, not checked). Fallback: the bf16 `qwen_3_4b` with ComfyUI's CPU offload. |
| NVIDIA 8–12 GB | alt | **SDXL-Lightning 4-step**: `ByteDance/SDXL-Lightning` / `sdxl_lightning_4step.safetensors` (6.938 GB, SHA-256 published on HF, verified locally) | **6.94 GB** | 7.86 GiB peak measured on a 16 GB card (includes ComfyUI caching). It may run tighter on 8 GB. | 4 steps, Euler, sgm_uniform · 0.587 s at 768×512 on a 5070 Ti (**measured**). Slower cards unmeasured. | **openrail++** | Core nodes (`CheckpointLoaderSimple`), i.e. ByteDance's official workflow `comfyui/sdxl_lightning_workflow_full.json` ([HF](https://huggingface.co/ByteDance/SDXL-Lightning)) |
| **NVIDIA 6 GB** | first | **SDXL-Lightning 4-step** (as above), or the UNet-only `sdxl_lightning_4step_unet.safetensors` (5.135 GB) plus the base SDXL text encoders | 6.94 GB | unverified on 6 GB. It depends on ComfyUI's automatic low-VRAM offload. | 4 steps · no time found | openrail++ | Core nodes. ComfyUI picks low-VRAM mode by itself (behaviour assumed, not checked on 6 GB). |
| NVIDIA 6 GB | alt | **SD-Turbo**: `stabilityai/sd-turbo` / `sd_turbo.safetensors` (5.215 GB, fp32 single file; the fp16 diffusers parts are about 2.6 GB) | 5.2 GB | est. well under 6 GB (a 512² SD2.1-class model; not measured) | 1 step · 512² only | **Stability AI Community License** (non-commercial; commercial use under US$1M revenue) | Core nodes, ComfyUI's SDXL Turbo / SD Turbo example. Flag the licence in the UI. |
| **No GPU (CPU)** | first | **SD-Turbo** (as above) | 5.2 GB | est. 6–8 GB RAM in fp32 (not measured) | 1 step at 512² · **7.8 s measured on an i7-12700** (FastSD CPU, PyTorch, **not ComfyUI**) ([FastSD CPU](https://github.com/rupeshs/fastsdcpu)). Through ComfyUI: unverified. | Stability AI Community License | ComfyUI `--cpu`, core nodes. **Off by default**: the user opts in after seeing the time. |
| No GPU (CPU) | alt | **SDXL-Lightning**, 2-step file `sdxl_lightning_2step.safetensors` (6.938 GB) | 6.94 GB | est. ≥ 14 GB RAM in fp32 (the SDXL UNet is 10.27 GB in fp32 per the HF file list; not measured). Offer it only at 32 GB+ RAM. | 2 steps at 768² · **18 s measured on an i7-12700** (FastSD CPU, PyTorch, not ComfyUI) | openrail++ | Core nodes, `--cpu`. Reason to prefer it: a permissive licence. |

**SDXS-512** (`IDKiro/sdxs-512-0.9`, openrail++) measured 4.8 s at 512², 1
step, on CPU in FastSD CPU. It is in diffusers format, and I could not confirm
that ComfyUI loads it. Unverified.

**Intel iGPU (UHD 630).** I found no measured speedup through any ComfyUI
path.

- The only route is the custom node `comfyui-openvino` (openvino-dev-samples;
  claims Intel CPU, GPU and NPU support; last push 2026-03-19, which is stale
  against ComfyUI 0.44).
  [repo](https://github.com/openvino-dev-samples/comfyui_openvino),
  [Comfy blog](https://blog.comfy.org/p/intel-openvino-joins-forces-with)
- FastSD CPU offers iGPU through OpenVINO (`DEVICE=GPU`) but publishes no
  iGPU numbers.
- Whether OpenVINO 2026 still supports Gen9.5 (UHD 630) is unverified.
- What was measured: OpenVINO plus a tiny autoencoder gives roughly 2–4×
  faster CPU runs in FastSD CPU (SD-Turbo 7.8 s → 1.7 s). That is a CPU-side
  gain, not an iGPU gain, and it is not ComfyUI.

Conclusion: treat a UHD 630 machine as CPU-only.

---

## 3. Installs without admin rights

### 3.1 Ollama, v0.40.15 (published 2026-11-03)

Release: [v0.40.15](https://github.com/ollama/ollama/releases/tag/v0.40.15).
Checksums are in the `sha256sum.txt` asset, and GitHub's API shows a
per-asset `sha256:` digest (values below, from
`api.github.com/repos/ollama/ollama/releases/latest`).

| OS | Asset | Size | sha256 |
|---|---|---|---|
| Linux x86_64 | `ollama-linux-amd64.tar.zst` (CPU + CUDA libs) | 1543.5 MB | `628c018404a4206493efd38e46251c154ede5141b8b8dc85c659b3b027c47379` |
| Linux x86_64 (AMD) | add `ollama-linux-amd64-rocm.tar.zst` | 1053.0 MB | `e41b4e45…fac26` |
| Windows 11 x86_64 | `ollama-windows-amd64.zip` (CLI + NVIDIA libs) | 1614.9 MB | `9ca74a7ab66ec86870b1eecac7df160df08dc4e3a291ab5d2d59bcf9310221c6` |
| Windows (installer) | `OllamaSetup.exe` (per user, no admin, `/DIR=` to relocate) | 1689.7 MB | `106ef3d2a02437810fba6f574914b1413c512ea84ddd4f184c8e7f434b6f5564` |
| checksums | `sha256sum.txt` | small | (asset digest `d2c12ada…68aa`) |

Run it from an app folder:

- **Linux:** extract to `<app>/ollama/` with `tar --zstd -xf … -C <app>/ollama`
  instead of the documented `sudo tar x -C /usr`. Then run
  `<app>/ollama/bin/ollama serve`. The docs only show the root install, so
  the non-root layout (`bin/` + `lib/ollama/` beside it) is assumed from the
  archive structure and unverified.
  [linux docs](https://raw.githubusercontent.com/ollama/ollama/main/docs/linux.mdx)
- **Windows:** unzip, then run `ollama.exe serve`. The docs name the
  standalone zip for "running Ollama as a service or embedding it".
  [windows docs](https://raw.githubusercontent.com/ollama/ollama/main/docs/windows.mdx)
- **Environment** (set per process, never system-wide)
  ([FAQ](https://docs.ollama.com/faq)):
  - `OLLAMA_HOST=127.0.0.1:<port>`. The default is 127.0.0.1:11434; pick a
    free port so the app never collides with a system Ollama, per the "never
    adopt" rule.
  - `OLLAMA_MODELS=<app>/models`. Defaults: Linux
    `/usr/share/ollama/.ollama/models` (service) and Windows
    `C:\Users\%username%\.ollama\models`.
  - `OLLAMA_CONTEXT_LENGTH`. The default is 4096; the app sets `num_ctx`
    per request anyway.
  - `OLLAMA_KEEP_ALIVE`. The default is 5 min.
  - `OLLAMA_KV_CACHE_TYPE`. The default is f16, which matches the
    estimator.
  - `OLLAMA_FLASH_ATTENTION`. Automatic by default.
- **Size:** on a CPU-only Windows box the zip still ships the NVIDIA libs,
  1.6 GB in total. No CPU-only archive is published.

### 3.2 ComfyUI, v0.44.0 (published 2026-11-04)

The repo moved to `Comfy-Org/ComfyUI`; the `comfyanonymous` links redirect.
[release](https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.44.0),
[README](https://raw.githubusercontent.com/Comfy-Org/ComfyUI/master/README.md)

**Windows portable.** The 7z files contain an embedded Python. SHA-256 values
are from the GitHub asset digests. No separate checksum file or signature was
found.

| Asset | Size | sha256 | Notes |
|---|---|---|---|
| `ComfyUI_windows_portable_nvidia.7z` | 2054.4 MB | `7170c2db49c182a81adcc051e80234f99dd891656fb200737f87797876348f96` | Python 3.13 + torch cu130. RTX 20-series and newer. The README says it also runs CPU-only. |
| `ComfyUI_windows_portable_nvidia_cu126.7z` | 1945.6 MB | `a26cf84f…4be9f` | Python 3.12 + cu126, for 10-series and older only |
| `ComfyUI_windows_portable_intel.7z` | 1487.0 MB | `f6af50a4…d57d` | torch XPU for Arc. Whether it helps a UHD iGPU is unverified. |
| `ComfyUI_windows_portable_amd.7z` | 1671.7 MB | `b9ff564c…dd28` | ROCm |

- **CPU portable:** there is none. The README says the NVIDIA portable works
  CPU-only. `run_cpu.bat` is in that portable per long-standing layout, but
  I did not open the 7z to confirm it (unverified).
- **Extraction:** 7z needs an extractor. Windows 11's built-in 7z support is
  assumed, not checked here.

**Linux manual install.** These steps come from the README. Running it with
`--listen 127.0.0.1 --port <p>` is the app's choice.

1. `git clone https://github.com/Comfy-Org/ComfyUI` and check out tag
   `v0.44.0`.
2. `python3.13 -m venv .venv`. The README says 3.13 is "very well
   supported", 3.14 works with some node issues, and 3.12 is the fallback.
3. Install torch:
   - NVIDIA: `pip install torch torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu130`.
     cu130 or later is required on 20-series and newer.
   - CPU: `pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu`.
     This is the standard PyTorch CPU index. The ComfyUI README does not
     list a CPU command (verified absent).
4. `pip install -r requirements.txt`, then `python main.py --cpu` for CPU.
5. Integrity: the git tag. PyTorch wheels carry hashes on the index, and
   `pip --require-hashes` with a lock is possible. No signature is published
   for ComfyUI itself.

Sizes: the CUDA torch wheel set is several GB and the CPU set is much
smaller. Exact numbers not checked (unverified).

---

## 4. Open questions

1. `bonsai-2` (`q2_0` ternary): minimum Ollama version, quality against
   qwen3.5:9b, and memory at 16k are all unverified. It is a strong
   candidate for 6–12 GB if independent numbers come in.
2. Real 16k VRAM for gemma4:12b, qwen3.5:4b and qwen3.8:27b: only computed so
   far. The app's measured report (`/api/ps` + nvidia-smi) should replace
   these after one load each.
3. Klein 4B on 8 GB and 6 GB cards: no measurement found.
4. Z-Image-Turbo on Ethan's card: never run. It would be a cheap measurement
   with the same ComfyUI unit.
5. Any CPU image time through **ComfyUI** for SD-Turbo or SDXL-Lightning: the
   only numbers are FastSD CPU's. Geordi (Windows, no GPU) can take this
   measurement.
6. The licence of `ornith-1.5` and its maker.
7. Whether `comfyui-openvino` works with ComfyUI 0.44, and whether OpenVINO
   2026 supports UHD 630.
8. Fix `estimate.ts` for implicit SWA (gptoss, gemma3). The fix is outside
   this lane.

## Files

- This report (written by the read-only research lane `research-tiers`,
  Opus 5.5 high, 2026-11-07, copied here unchanged above this section).
- Data: `docs/research/setup-tiers-2026-11.json` (the lane's
  `tiers.draft.json`: 24 picks, the excluded list, the design-name check and
  the install facts). `setup/tiers.json` is built from it.
- The 16k computation (the app's estimator against local `/api/show`, run
  with `node est16k.ts <model>...` from a scratch folder; kept here because
  the scratch copy does not last):

```ts
import { parseArchInfo, estimateNeed } from "/home/ethan/projects/ai/gates-local/apps/server/src/fit/estimate.ts";
const models = process.argv.slice(2);
const tags = await (await fetch("http://127.0.0.1:11434/api/tags")).json();
for (const m of models) {
  const show = await (await fetch("http://127.0.0.1:11434/api/show", { method: "POST", body: JSON.stringify({ model: m }) })).json();
  const t = tags.models.find((x: any) => x.name === m);
  const arch = parseArchInfo(m, show.model_info);
  for (const ctx of [16384, 32768]) {
    const e = estimateNeed(m, ctx, t.size, arch);
    console.log(`${m}\tctx ${ctx}\tweights ${(t.size/1e9).toFixed(2)} GB\tkv ${(e.kvCacheBytes/1e9).toFixed(2)} GB (${e.kvLayers} layers)\ttotal ${(e.totalBytes/1e9).toFixed(2)} GB`);
  }
}
```
