# Setting up Gates Local on Windows

This guide covers Windows 11 on x64. Everything here installs for your user
account only; no step needs administrator rights.

**What was tested:** one Windows 11 Pro machine (Intel Core i5-8500, 16 GB
RAM, Intel UHD 630 graphics, no NVIDIA GPU), with Node.js 24.18, pnpm
11.10.0 and Ollama 0.40.15. Models ran on the CPU there. **Not tested yet:**
an NVIDIA GPU on Windows, the shell tool (it needs bubblewrap, which is
Linux only, so it is off on Windows), and starting ComfyUI automatically
(Linux only; a ComfyUI you start yourself still works, see section 4).

## 1. Install Node.js 24 and pnpm 11

Install Node.js 24 or newer from <https://nodejs.org/en/download> (the
Windows installer, `.msi`). Then open a new PowerShell window and check the
version:

```powershell
node --version   # v24 or newer
```

Install pnpm 11.10.0, the version the repository pins, for your user only:

```powershell
npm install -g pnpm@11.10.0
pnpm --version   # 11.10.0
```

This puts pnpm in `%APPDATA%\npm`, which the Node.js installer already added
to your `PATH`. Do not run `corepack enable` on Windows: it writes into
`C:\Program Files\nodejs` and needs administrator rights.

If PowerShell says "running scripts is disabled on this system" when you run
`npm` or `pnpm`, see
[PowerShell refuses to run npm or pnpm](#powershell-refuses-to-run-npm-or-pnpm).

## 2. Install Ollama

Download `OllamaSetup.exe` from <https://ollama.com/download> and run it. It
installs for your user into `%LOCALAPPDATA%\Programs\Ollama` without asking
for administrator rights, and adds itself to your `PATH` and the Start menu.
Start **Ollama** from the Start menu if it is not already running; its icon
appears in the notification area (the system tray), and while it runs Ollama
answers on `127.0.0.1:11434`.

The installer is large (1.7 GB for Ollama 0.40.15) because it includes the
GPU libraries.

You do not need to pull a model now. With no models installed, the app offers
one that fits this computer on first run.

## 3. Get the code and start the app

Install Git from <https://git-scm.com/download/win> if you do not have it.
Then, in PowerShell:

```powershell
git clone https://github.com/Calculator5329/gates-local.git
cd gates-local
pnpm install
pnpm start
```

`pnpm install` downloads the dependencies (about 70 packages). `pnpm start`
builds the web client and the desktop app, then opens the window. The first
`pnpm start` also downloads the Electron binary (about 160 MB) from GitHub,
so the window takes a minute longer the first time.

On first run the app looks for Ollama on `127.0.0.1:11434`. When Ollama
answers, the app uses it and lists its models, and remembers to use the
system Ollama from then on. The app never stops this Ollama, because it did
not start it.

If you later quit Ollama from its tray icon, the app says "Ollama isn't
running". Start Ollama from the Start menu and press Retry.

### The app's own copy of Ollama

You can switch to the app's own private copy of Ollama in Settings ›
Runtime › "Switch to Gates Local's copy". It runs on the first free port
from 11435 to 11444, keeps its models in `%LOCALAPPDATA%\GatesLocal\models`
apart from the system Ollama's (so a model you want there downloads
again), and stops when you close the app.

When the app finds no Ollama program of its own, it downloads the pinned
Ollama 0.40.15 for Windows (`ollama-windows-amd64.zip`, 1.6 GB) from
GitHub, checks its SHA-256, and unpacks it with Windows' own `tar.exe` into
`%LOCALAPPDATA%\GatesLocal\runtime\ollama\0.40.15` (2.2 GB on disk). On the
test machine that took 3 min 41 s from the click to a running copy. Then it
downloaded Qwen 3.5 4B into the copy's models folder and answered a chat.
To test this the app was started with its search for an installed Ollama
turned off; with Ollama installed, the code runs the installed
`ollama.exe` as its copy instead of downloading one (not tested).

Switching back (Settings › Runtime › "Switch to the system Ollama") stops
the copy. The downloaded copy stays in the data folder until you remove it.

### Your first model

With no models installed, the first-run screen recommends one and labels it
for this computer. On the test machine, with no NVIDIA GPU and 16 GB RAM, it
recommended **Qwen 3.5 4B** (`qwen3.5:4b`, a 3.1 GB download), labelled
"Uses system memory · slower". Press **Download and start**.

### How fast it is without an NVIDIA GPU

Gates Local reads GPU memory with `nvidia-smi`, which only NVIDIA drivers
install. Without it, the app says "No supported GPU" and plans every model in
system memory, and Ollama runs the model on the CPU. Intel and AMD graphics
are not used for the plan.

Measured on the test machine (i5-8500, CPU only) with `qwen3.5:4b` at 16k
context, from the app window:

- **Thinking on** (the default): the model thought for 394 s before the
  first word of the answer. The first reply also includes loading the model.
- **Thinking off**, model already loaded: 2.3 s to the first word, and the
  app showed 4 tok/s for the reply. The same prompt sent straight to Ollama
  generated 5.5 tokens per second by Ollama's own count.

On a computer like this, turn **Thinking** off in the message box for
everyday questions.

## 4. Optional: image generation with ComfyUI

Image generation is off by default. The app does not install ComfyUI or
download image models, and on Windows it never starts or stops ComfyUI. Start
ComfyUI yourself, then turn image generation on in Settings › Image
generation. The default address is `http://127.0.0.1:8188`; change it there
if your ComfyUI listens elsewhere. The models it needs are listed in the
[Linux guide](linux.md#4-optional-image-generation-with-comfyui).

This was not tested on Windows.

## 5. Where the app keeps its data

| What | Where |
| --- | --- |
| Threads, settings, database copies, images, and the record and log of the app's own Ollama | `%LOCALAPPDATA%\GatesLocal` |
| The Ollama the app downloads, and the models of its own Ollama copy (Settings › Runtime) | `runtime\ollama\` and `models\` in `%LOCALAPPDATA%\GatesLocal` |
| Electron's profile (window state and cache) | `%APPDATA%\gates-local` |
| The Electron download | the zip in `%LOCALAPPDATA%\electron\Cache`, unpacked into the clone under `node_modules\.pnpm\electron@<version>\node_modules\electron\dist` |
| Ollama itself | `%LOCALAPPDATA%\Programs\Ollama`, its logs in `%LOCALAPPDATA%\Ollama` |
| Models of the system Ollama | `%USERPROFILE%\.ollama\models` |

`%LOCALAPPDATA%` is usually `C:\Users\<you>\AppData\Local` and `%APPDATA%`
is `C:\Users\<you>\AppData\Roaming`. Paste either into the File Explorer
address bar to open it.

Inside the data folder, `threads.sqlite` holds your threads,
`settings.json` your settings, `snapshots\` the database copies and
`images\` the generated images.

To move only the data folder, set `GATES_LOCAL_DATA_DIR` to an absolute path
before `pnpm start`:

```powershell
$env:GATES_LOCAL_DATA_DIR = "D:\GatesLocal"
pnpm start
```

## 6. Updating

Close the app, then, from the clone:

```powershell
git pull
pnpm install
pnpm start
```

Your threads and settings stay where they are. If a newer build changed the
thread database, an older build refuses to open it rather than change it.

## 7. Uninstalling

Close the app. Delete the clone folder (`gates-local`) in File Explorer, or
from its parent folder in PowerShell:

```powershell
Remove-Item -Recurse -Force gates-local
```

That removes the app but keeps your data. To remove your data too, which is a
separate choice and cannot be undone (this also removes the app's own Ollama
copy and its models):

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\GatesLocal", "$env:APPDATA\gates-local"
```

Also delete these if they apply to you:

- the folder you set in `GATES_LOCAL_DATA_DIR`;
- `%LOCALAPPDATA%\electron\Cache`, if no other Electron project uses it;
- pnpm, with `npm uninstall -g pnpm`.

Models in the system Ollama stay. Remove one with `ollama rm <model>`, or
uninstall Ollama from Settings › Apps › Installed apps. Its models stay in
`%USERPROFILE%\.ollama` until you delete that folder.

## 8. Troubleshooting

### PowerShell refuses to run npm or pnpm

On a new Windows installation PowerShell may refuse to run the `npm.ps1` and
`pnpm.ps1` launchers with "running scripts is disabled on this system". (The
test machine already allowed them, so this was not seen there.) Either run
the commands from Command Prompt (`cmd`) instead, or allow signed and local
scripts for your user only:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

### "Ollama isn't running"

The app shows "Nothing answers on localhost:11434. Start Ollama, then
retry." when Ollama is installed but not running, for example after you quit
it from its tray icon.

- Start Ollama from the Start menu, then press Retry.
- Check that it answers, in PowerShell:

  ```powershell
  curl.exe http://127.0.0.1:11434/api/version
  ```

- Settings › Runtime offers the switch to the app's own copy only while an
  Ollama is running, so start Ollama first if you want to switch.

### The first reply takes minutes

Without an NVIDIA GPU the model runs on the CPU. With Thinking on, a small
model can think for several minutes before it answers (394 s on the test
machine). Turn Thinking off in the message box, or keep messages short. The
label next to the model says "Uses system memory · slower" on such a
computer; that is expected.

### A model is too big for memory

Each model shows one of three labels for the chosen context:

- **Runs on GPU:** the model fits in free GPU memory (NVIDIA only).
- **Uses system memory · slower:** all or part of it runs in system memory.
  Without an NVIDIA GPU every model that fits gets this label.
- **Not enough memory at 16k:** it does not fit even with system memory. The
  label says how much more is needed.

Choose a smaller model or a smaller context (16k is the smallest), or close
other programs. The app measures free memory at the moment it checks.

### The port is in use

If another program answers on port 11434 but is not Ollama, the app says
"Port 11434 answers, but not as Ollama" and does not chat through it. The
app never stops that program. Stop it yourself, or switch to the app's own
copy in Settings › Runtime, which uses a free port from 11435 to 11444.
