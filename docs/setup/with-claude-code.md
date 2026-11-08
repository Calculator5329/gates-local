# Setting someone up with Claude Code

This runbook is written to you, the agent. Someone cloned this repository
and asked you to set them up. Your job is a working Gates Local with the
best models this machine can run, and a plain account of what you did.

The full guides are [linux.md](linux.md) and [windows.md](windows.md). Use
them for detail and troubleshooting. This runbook has not yet been run from
start to finish on a clean machine, so if a step does not match what you
see, trust what you see and tell the person.

## Rules

- **Ask before any large download.** State what it is, its size and where it
  goes, then wait for a yes. Anything over about 100 MB counts.
- **Ask before installing anything system-wide.** That means sudo,
  administrator rights, a package manager or a system service. Prefer the
  install for this user only when there is one.
- A no is a normal answer. Skip that item, carry on, and report it as
  skipped.
- Never stop or restart an Ollama, ComfyUI or other program you did not start
  in this session. Never start the app with `--no-sandbox`.
- Do not delete anything to make room. Tell the person what is short.
- Report only what you saw work.

## 1. Read the machine

Supported: Linux on x64 in a graphical desktop session, and Windows 11 on
x64. macOS is not supported, so stop and say so. On ARM, the app has no
Ollama build of its own to download, so only an Ollama the person installs
can work. It has not been tested there; say that before going on.

On Linux, check that `$DISPLAY` or `$WAYLAND_DISPLAY` is set. Over plain SSH
the app has no window to open, so say so and ask how they want to continue.

See what is already here:

```sh
node --version    # needs v24 or newer
pnpm --version    # needs 11.10.0
ollama --version
ollama list
curl http://127.0.0.1:11434/api/version
```

On Windows use `curl.exe`. The last command tells you whether an Ollama is
running now, which decides section 3.

## 2. Install the tools and read the recommendation

If Node.js 24 or pnpm 11.10.0 is missing, install them as section 1 of the
[Linux](linux.md#1-install-nodejs-24-and-pnpm-11) or
[Windows](windows.md#1-install-nodejs-24-and-pnpm-11) guide says. On Linux, a
distribution package or a `corepack enable pnpm` on a system Node.js needs
sudo, so ask first. On Windows the Node.js `.msi` and the Git installer
normally need administrator rights, so ask first. The guide's
[way without them](windows.md#no-administrator-rights) installs for this user
only, and was not tested.

Then, in this folder:

```sh
pnpm install
pnpm machine-check
```

`pnpm install` fetches about 70 packages. `pnpm machine-check` only reads. It
prints the OS, GPU, RAM and free disk, the best text model and an image
recommendation. Its text pick is the rule behind the app's Recommended label,
from the memory free right now, so ask the person to close heavy programs
first if the GPU is busy. It does not look at what Ollama already has.

## 3. Make one plan and ask

Show the person one list before downloading anything: each item, its size,
where it goes and whether it needs sudo. Let them say no to any line.

**Ollama.** How the app finds it decides the plan. On its first launch the
app records which mode to use: the system Ollama if one answers on
`127.0.0.1:11434`, otherwise its own copy. So settle this before the first
`pnpm start`.

| What you found | What to do |
| --- | --- |
| An Ollama answers on 11434 | Use it. Nothing to install. |
| Installed but not answering | Start it. On Linux, `ollama serve` in the background needs no sudo, but it ends with this session, so tell the person how to start it next time. If it is a system service, ask before `sudo systemctl start ollama`. On Windows, ask the person to start Ollama from the Start menu. |
| No Ollama | Offer the two choices below. |

The two choices when there is no Ollama:

1. **The official install** from <https://ollama.com/download>. On Linux its
   script needs sudo and sets up a system service. On Windows,
   `OllamaSetup.exe` is for this user only, needs no administrator rights, and
   is 1.7 GB. Recommend this on Linux: it is the tested route there.
2. **The app's own copy.** No install step and no sudo. The first
   `pnpm start` downloads a pinned Ollama 0.40.15 from GitHub by itself, with
   no prompt in the app: 1.5 GB on Linux, 1.6 GB on Windows (x64 only). It
   checks the SHA-256 and unpacks into the app's data folder (2.2 GB on disk on
   Windows). This was tested on one Windows machine and has not been tested on
   a real Linux machine. The copy stops when the app quits.

If they refuse both, stop before `pnpm start`, because starting would download
that copy.

**Text model.** The one from `pnpm machine-check`. Its size is in the output.
If `ollama list` already has it, there is nothing to download. Other
recommended models are optional, and their sizes are the `downloadBytes` values
in `apps/server/src/runtime/recommended.ts`. If the check says no model fits,
do not download one; tell the person what it said.

**Electron.** The first `pnpm start` downloads it from GitHub: about 120 MB on
Linux, about 160 MB on Windows.

**Image generation.** Include it only if `pnpm machine-check` recommends it,
and only as an optional line. If it says to skip, tell the person why and do
not offer to install ComfyUI anyway. Section 6 has the sizes.

## 4. Get the text model

Which way depends on the Ollama from section 3.

- **System Ollama:** run `ollama pull <tag>` with the tag from the check.
- **The app's own copy:** `ollama pull` is the wrong tool, because it talks to
  the Ollama on 11434 and the copy keeps its models in its own folder. Use the
  app in the next section instead.

The app does not need you to set a default. It picks the best installed model
that fits, by the same rule.

## 5. Start the app and confirm a chat

Run `pnpm start` in the background and leave it running. It builds the app and
opens a window. If it stops with "No usable sandbox!", follow
[that section of the Linux guide](linux.md#electron-stops-with-no-usable-sandbox).
The fix needs sudo, so ask.

You cannot see the window, so the person has to be your eyes here.

- With the app's own copy and no model yet, the first-run screen recommends a
  model. Ask them to press **Download and start**.
- Otherwise the first-run screen finds Ollama and a model that fits. Ask them
  to continue into a chat.

Then ask them to send "Say hello in five words" and tell you what came back.
Without an NVIDIA GPU the first reply can take a while, because the model runs
on the CPU and has to load first. Thinking starts off on such a machine.

With a system Ollama you can also test the model yourself, which is useful if
the window shows a problem:

```sh
ollama run <tag> "Reply with the single word ready."
```

A chat counts as confirmed only when the person says a reply appeared in the
window. If something fails, use the troubleshooting section of the guide for
this OS, and report what you saw.

## 6. Image generation, if they said yes

The app does not install ComfyUI or download image models. You do that here,
with the person's say-so. Image generation is off until they turn it on in
the app.

1. **ComfyUI.** Install it in a folder of the person's choosing as this
   project's README says: <https://github.com/Comfy-Org/ComfyUI>.
   - On Linux that is a git clone and a Python virtual environment, with
     `pip install` for PyTorch. The NVIDIA PyTorch packages come to several
     GB. Keep it all in the virtual environment, never `sudo pip`.
   - On Windows the portable build for NVIDIA is 2.1 GB
     (`ComfyUI_windows_portable_nvidia.7z`). Image generation has not been
     tested on Windows.
2. **The checkpoint**, 6.94 GB, licence openrail++. Put it in ComfyUI's
   `models/checkpoints` folder as `sdxl_lightning_4step.safetensors`. It is
   at <https://huggingface.co/ByteDance/SDXL-Lightning>. Check its SHA-256:
   `e0d996ee0013e79d9d3561f50fcafb9a17e3ff07b780358e3b66d67932c4d490`.
3. **The LoRA**, `RW_pixelart_XL_v1.safetensors`, in `models/loras`. The app
   needs this exact file, and a job fails with a message naming it when it is
   missing. **This repository does not record who published it.** The only
   public copy found (2026-11-08) is in a Hugging Face Space,
   <https://huggingface.co/spaces/zac/ComfyUI/blob/main/RW_pixelart_XL_v1.safetensors>,
   with no model card or licence. Tell the person exactly that and let them
   decide. If they say no, image generation stays unfinished; report it that
   way.
4. **Start ComfyUI** on its default address, `http://127.0.0.1:8188`. The app
   starts it only on Linux, and only if a `comfyui.service` systemd user unit
   exists. Do not create one without asking. Otherwise the person starts
   ComfyUI before generating an image; tell them the command.
5. **Turn it on.** Ask the person to open Settings › Image generation, switch
   it on and generate one image. An image job wants about 9 GB of free GPU
   memory, so other programs on the GPU count against it.

## 7. Tell the person what happened

End with a short, plain account:

- **Set up:** each thing installed or downloaded, its size and where it is.
- **Skipped:** each thing skipped and why, including anything they declined.
- **Confirmed:** what you saw work, and what they saw. Say so if a step was
  not confirmed.
- **Why these models:** one line from the `pnpm machine-check` output.
- **Next time:** `pnpm start` in this folder opens the app. The Uninstalling
  section of the guide for this OS removes everything.
