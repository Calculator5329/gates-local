# Setting up Gates Local on Linux

This guide covers a Linux x64 machine. Linux is the only platform tested so
far.

## 1. Install Node.js 24 and pnpm 11

Gates Local needs Node.js 24 or newer. Install it from your distribution, or
follow <https://nodejs.org/en/download>. Check the version:

```sh
node --version   # v24 or newer
```

The repository pins pnpm 11.10.0 in `package.json`. Node 24 ships Corepack,
which installs that version for you:

```sh
corepack enable pnpm
pnpm --version   # 11.10.0
```

If Corepack is not available, see <https://pnpm.io/installation>.

## 2. Install Ollama and pull a first model

Install Ollama with the instructions at <https://ollama.com/download>. On
most distributions this sets up an `ollama` system service that starts on
boot.

Pull a first model. `qwen3.5:9b` is a 6.6 GB download and runs on a GPU with
8 GB of memory:

```sh
ollama pull qwen3.5:9b
```

On a machine with less memory, `qwen3.5:4b` (3.3 GB) is lighter. You can
also skip this step: with no models installed, the app offers a short list
to download on first run.

If you do not install Ollama, the app tries to download a pinned Ollama
release from GitHub into its own data folder on first launch. That path has
not been tested on a real machine yet.

## 3. Get the code and start the app

```sh
git clone https://github.com/<owner>/gates-local.git
cd gates-local
pnpm install
pnpm start
```

`pnpm install` downloads the dependencies. `pnpm start` builds the web
client and the desktop app, then opens the window. The first `pnpm start`
also downloads the Electron binary (about 120 MB) from GitHub into
`~/.cache/electron`.

On first run the app looks for Ollama on `127.0.0.1:11434`:

- **Ollama answers:** the app uses it and lists its models. The app never
  stops this Ollama, because it did not start it.
- **Nothing answers:** the app starts its own copy of Ollama on the first
  free port from 11435 to 11444. It uses the `ollama` binary on your `PATH`
  if there is one. This copy keeps its models in the app's data folder, apart
  from any system install. The app stops this copy when it quits.

You can switch between the two later in Settings › Runtime.

## 4. Optional: image generation with ComfyUI

Image generation is off by default. It needs ComfyUI running on this
machine and an NVIDIA GPU with about 9 GB free. The app does not install
ComfyUI or download image models.

- **Address:** `http://127.0.0.1:8188` by default. You can change it in
  Settings › Image generation, but it must point to this machine.
- **Models:** ComfyUI must have the checkpoint
  `sdxl_lightning_4step.safetensors` in its `models/checkpoints` folder and
  the LoRA `RW_pixelart_XL_v1.safetensors` in its `models/loras` folder. The
  app asks ComfyUI for its model lists before each job. If either file is
  missing, the job fails with a message naming it.
- **Starting ComfyUI:** if ComfyUI is not answering and you have a
  `comfyui.service` systemd user unit, the app starts it with
  `systemctl --user start comfyui.service`. It stops the unit after five idle
  minutes, but only if the app started it. Without the unit, start ComfyUI
  yourself before you generate an image.
- **Memory:** before a job, the app unloads the chat models it loaded itself
  if the GPU is short of memory. It never unloads models other programs
  loaded.

Turn it on in Settings › Image generation. Images are saved in the app's
data folder under `images/`.

## 5. Where the app keeps its data

| What | Where |
| --- | --- |
| Threads, settings, library snapshots, images | `~/.local/share/gates-local` (or `$XDG_DATA_HOME/gates-local`) |
| The app's own Ollama copy, its log and its models | `runtime/` and `models/` inside the folder above |
| Electron's window state and cache | `~/.config/gates-local` |
| Models of the system Ollama | wherever Ollama keeps them, usually `/usr/share/ollama/.ollama/models` or `~/.ollama/models` |

Inside the data folder, `threads.sqlite` holds your threads,
`settings.json` your settings, `snapshots/` the library copies and
`images/` the generated images.

To keep the data somewhere else, set `GATES_LOCAL_DATA_DIR` to an absolute
path before `pnpm start`.

## 6. Updating

Close the app, then:

```sh
cd gates-local
git pull
pnpm install
pnpm start
```

Your threads and settings stay where they are. If a newer build changed the
thread database, an older build refuses to open it rather than change it.

## 7. Uninstalling

Close the app, then delete the clone and the app's folders:

```sh
rm -rf gates-local
rm -rf ~/.local/share/gates-local ~/.config/gates-local
```

This also removes the app's own Ollama copy and the models it downloaded in
that mode. The Electron download stays in `~/.cache/electron`, which other
Electron projects may share. Models in the system Ollama stay. Remove them with
`ollama rm <model>`, or uninstall Ollama as its documentation describes.

## 8. Troubleshooting

### "Ollama isn't running"

The app shows "Nothing answers on localhost:11434. Start Ollama, then
retry."

- Start the service: `sudo systemctl start ollama`, or run `ollama serve`
  in a terminal.
- Check that it answers:

  ```sh
  curl http://127.0.0.1:11434/api/version
  ```

- Or let the app run its own copy: Settings › Runtime › "Switch to Gates
  Local's copy".

### A model is too big for memory

Each model shows one of three labels for the chosen context:

- **Runs on GPU:** the model fits in free GPU memory.
- **Uses system memory · slower:** part of it runs in system memory.
  Replies are slower.
- **Not enough memory at 16k:** it does not fit even with system memory.
  The label says how much more is needed.

To fix it, choose a smaller model or a smaller context (16k is the
smallest), or close other programs that use the GPU. The app measures free
memory at the moment it checks, so other programs count against it.

### The port is in use

If another program answers on port 11434 but is not Ollama, the app shows
"Port 11434 answers, but not as Ollama" and does not chat through it. The
app never stops that program. Either stop it yourself, or switch to the
app's own copy in Settings › Runtime, which uses a free port from 11435 to
11444. If all of those are taken too, nothing starts and the banner says so.

The app's own window and server use a free port that changes on every
launch, so they do not clash with other programs. Only the web development
server (`pnpm --filter @gates-local/web dev`) needs a fixed port, 5187, and
it stops with an error if that port is taken.
