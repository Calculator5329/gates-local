# Gates Local

A desktop chat app for running AI models on your own Linux machine through
Ollama, for people who want local models without guessing whether they fit.

![A chat thread in the dark theme, with the thread list on the left and a code answer open](docs/screenshots/chat.png)

## What it does

- Uses the Ollama you already run. If none answers, it starts its own copy
  on its own port. It never stops an Ollama it did not start.
- Checks memory before a model loads. Each model gets a label for the
  chosen context size: runs on GPU, uses system memory (slower), or not
  enough memory.
- Uses a 16k context by default and never less, with 32k and 64k as
  options.
- Streams replies, shows the model's thinking, and has Stop and Retry.
  Threads are saved in a local SQLite file and survive a server restart.
- Downloads models from a short list inside the app, with progress and
  cancel.
- Library: add folders, files or SQLite databases. The app copies each
  one into a private, read-only snapshot, and the model's tools read the
  snapshot, never the original. On Linux the shell tool runs in a
  bubblewrap sandbox with no network.
- Optional image generation through a local ComfyUI. It is off until you
  turn it on.
- Dark and light themes. It follows your system setting until you pick one.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/model-picker.png" alt="The model picker, with one model labelled as not fitting at 16k"></td>
    <td width="50%"><img src="docs/screenshots/first-run.png" alt="The first-run screen with Ollama found and one recommended model that runs on the GPU"></td>
  </tr>
  <tr>
    <td>The model picker labels each installed model for the chosen context.</td>
    <td>First run finds Ollama and picks an installed model that fits.</td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/settings-library.png" alt="Settings, Library section, with no sources added yet"></td>
    <td><img src="docs/screenshots/chat-light.png" alt="The same chat thread in the light theme"></td>
  </tr>
  <tr>
    <td>Library sources are added in Settings. None are connected by default.</td>
    <td>The light theme.</td>
  </tr>
</table>

## Requirements

- **OS:** Linux on x64. This is the only platform tested so far.
- **Node.js** 24 or newer.
- **pnpm** 11.10.0. Corepack picks this version from `package.json`.
- **Ollama.** Install it from <https://ollama.com/download>. If Ollama is
  not on your machine, the app tries to download a pinned Ollama release
  from GitHub on first launch (Linux x64 only). That path has not been
  tested on a real machine yet, so installing Ollama yourself is the safer
  route.
- **GPU:**
  - *NVIDIA:* the app reads free GPU memory with `nvidia-smi` and plans the
    model around it. If `nvidia-smi` is installed but fails, the app
    refuses to start a chat and says why.
  - *Other GPUs (AMD, Intel, Apple):* the app does not read their memory. It
    plans as if there were no GPU, so the labels are cautious. Ollama may
    still use the GPU when it loads the model.
  - *No GPU:* the app plans the whole model in system memory and labels it
    "Uses system memory · slower". Replies will be slow on larger models.
- **Shell tool (optional):** bubblewrap at `/usr/bin/bwrap` and a user
  systemd session. Without them the shell tool is off and the other tools
  still work.
- **ComfyUI (optional):** only for image generation, which also needs an
  NVIDIA GPU with about 9 GB free. See
  [docs/setup/linux.md](docs/setup/linux.md#4-optional-image-generation-with-comfyui).

## Quick start on Linux

Install Ollama and start it first. Then:

```sh
git clone https://github.com/<owner>/gates-local.git
cd gates-local
corepack enable pnpm
pnpm install
pnpm start
```

`pnpm start` builds the app and opens its window. On first run it finds
Ollama and lists your models. With no models installed, it offers some to
download. The full guide, with updating, uninstalling and fixes for common
problems, is [docs/setup/linux.md](docs/setup/linux.md).

## Windows

Not supported yet. Linux is the tested platform today.

## Privacy

Your threads, settings, library snapshots and images stay in the app's data
folder (`~/.local/share/gates-local` by default). The app sends no
telemetry and has no accounts. Its window loads only its own built files.

These are all the network calls the code makes:

- **Ollama on this machine.** Chat, model info, memory checks and model
  loads go to Ollama on `127.0.0.1`, port 11434, or 11435 to 11444 for the
  app's own copy.
- **Model downloads.** When you download a model, the app asks Ollama to
  pull it. Ollama fetches it from its registry (ollama.com) or from the
  source the model name points to.
- **The Ollama download.** Only when no Ollama is found: the app downloads
  a pinned Ollama release from `github.com/ollama/ollama` and checks its
  SHA-256 before installing it.
- **ComfyUI.** Only when image generation is on: HTTP and WebSocket calls to
  the ComfyUI address in Settings (`http://127.0.0.1:8188` by default). The
  app checks that the address is on this machine, which may need one DNS
  lookup if you enter a host name.
- **Inside the app.** The window talks to the app's own server over a
  WebSocket on `127.0.0.1`, with a token that changes on every launch.
- **Links.** A link you click opens in your web browser. The app never
  loads it itself.

Installing is separate: `pnpm install` downloads packages from the npm
registry, and the first `pnpm start` downloads the Electron binary from
GitHub.

One thing has not been checked yet: Electron's spellchecker, which the app
leaves on, may download dictionary files from Google the first time it
runs.

The app also runs local commands: `nvidia-smi` to read GPU memory,
`systemctl --user` to start and stop a `comfyui.service` unit if you have
one, `systemd-run` and `bwrap` for the shell tool, and `tar` to unpack the
Ollama download.

## Development

```sh
pnpm verify        # typecheck, lint and unit tests
pnpm e2e           # browser journeys against a fake Ollama (Chromium)
pnpm shots:readme  # regenerate the images in docs/screenshots
```

`pnpm e2e` and `pnpm shots:readme` run the real server against a fake
Ollama and a fake `nvidia-smi`, so they need no GPU and no models. The
screenshots use demo threads and a pinned clock, so a rerun gives the same
images. [AGENTS.md](AGENTS.md) describes the layout, the rules for changes
and what each part owns.

## Status

Early. The chat, fit check, model downloads, library and tools work, and
are tested against fakes. Packaging, benchmarks and guided setup are not
built yet. See [docs/roadmap.md](docs/roadmap.md) for what comes next.

<!-- LICENSE: chosen at publication -->
