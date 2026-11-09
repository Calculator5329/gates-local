# Setting up Gates Local on Windows

This guide covers Windows 11 on x64. Gates Local, pnpm and Ollama install for
your user account only. The Node.js and Git installers normally ask for
administrator rights; [there is a way without them](#no-administrator-rights).

Rather not do this by hand? [Let Claude Code set it up](with-claude-code.md).

**What was tested:** one Windows 11 Pro machine (Intel Core i5-8500, 16 GB
RAM, Intel UHD 630 graphics, no NVIDIA GPU), with Node.js 24.18, pnpm
11.10.0 and Ollama 0.40.15. Models ran on the CPU there. The test ran over
a remote session with no visible desktop: the app's window was driven and
photographed through its developer tools port, and Ollama's tray app could
not start there ("Unable to init instance"), so the installed `ollama.exe`
ran as `ollama serve` in its place. The Library read a connected folder; a
question about a connected SQLite file reached the right answer only after
many failed tool calls. **Not tested yet:** an NVIDIA GPU on Windows, the
Ollama tray app, the shell tool (it needs bubblewrap, which is Linux only,
so it is off on Windows), and starting ComfyUI automatically (Linux only; a
ComfyUI you start yourself still works, see section 4).

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
to your `PATH`. The Linux guide's `corepack enable` is not used here: it
writes its launchers into the Node.js folder (`C:\Program Files\nodejs`),
which needs administrator rights.

If PowerShell says "running scripts is disabled on this system" when you run
`npm` or `pnpm`, see
[PowerShell refuses to run npm or pnpm](#powershell-refuses-to-run-npm-or-pnpm).

### No administrator rights?

The `.msi` above and the Git installer below normally need them. These
replacements install for your account only, and were not tested:

- **Node.js:** download the Standalone Binary (`.zip`) from the same page and
  unpack it into a folder of your own, such as
  `%LOCALAPPDATA%\Programs\node`. Open **Edit environment variables for your
  account** from the Start menu and add that folder to `Path`. After the
  `npm install -g` above, run `npm config get prefix` and add that folder too
  if it is a different one.
- **Git:** download Portable Git from <https://git-scm.com/download/win>,
  unpack it, and add its `cmd` folder to the same `Path`.

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

- **Thinking on**: the model thought for 394 s before the first word of
  the answer. The first reply also includes loading the model.
- **Thinking off**, model already loaded: 2.3 s to the first word, and the
  app showed 4 tok/s for the reply. The same prompt sent straight to Ollama
  generated 5.5 tokens per second by Ollama's own count.

On a computer with no supported GPU, **Thinking** starts off. The button in
the message box turns it on for a question worth the wait.

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
The copy is always this pinned build: the app never runs an `ollama.exe` it
finds on PATH as its copy. The app's own copy is not available on Windows ARM.

Switching back (Settings › Runtime › "Switch to the system Ollama") stops
the copy. The downloaded copy stays in the data folder until you remove it.

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
before `pnpm start` (not tested on Windows):

```powershell
$env:GATES_LOCAL_DATA_DIR = "D:\GatesLocal"
pnpm start
```

## 6. Updating

In the app, open Settings › General › Updates, click "Check for updates" and
then "Update and restart". The window closes, the new version installs and
the app opens again. The desktop also checks this clone's git remote with
`git fetch` and `git ls-remote` 15 seconds after startup, then hourly,
without installing anything. "Check for updates automatically" in the same
group defaults on; off prevents future automatic git processes and network
requests (an existing check finishes). Computer browsers can check on
request; the phone listener has update status only. An update button beside Settings names the target and changes in
its tooltip. Running replies, image jobs and model downloads bring up a
confirmation before restart; active imports must finish first. Partial replies and model download parts are
kept; start a model download again to resume it. Save drafts and queued
messages before continuing. Offline automatic checks stay silent.

A copy from before that button existed has to update once by hand, and this
path always works. Close the app, then, from the clone:

```powershell
git pull
pnpm install
pnpm start
```

`pnpm run app-update` does the same update from a terminal, goes back to the
version you had if a step fails, and says what is new first; add `--check` to
only see what is new. A terminal update also opens the app to verify that
its server is ready. Initialization failure or a 60-second startup timeout
restores and starts the previous version once.

Your threads and settings stay where they are. If a newer build changed the
thread database incompatibly, an older build refuses to open it rather than
change it. The optional interrupted-reply column preserves the shipped
store version so it does not prevent rollback.

Recovery stops if it cannot confirm the failed app's whole tree ended. On
Windows, a root process that already disappeared is not that confirmation:
its helpers may still hold files. Keep the app closed and restart Windows
before retrying in that case. Rollback resolves Electron again from the
restored dependency install.
Later updater attempts keep this restriction. New process records retain
Windows' last boot time, so a later boot proves restart even if its uptime
has already passed the old value. A lower uptime is additional evidence for
older records. Missing or unreadable evidence is not proof of restart.
Choose **Restart**: a Fast Startup shutdown may retain the same kernel boot,
in which case unchanged boot evidence keeps recovery blocked. See
[Microsoft's Fast Startup explanation](https://learn.microsoft.com/en-us/troubleshoot/windows-client/setup-upgrade-and-drivers/fast-startup-causes-system-hibernation-shutdown-fail).

If you repair the checkout by moving HEAD to the previous or a newer commit,
the next updater keeps that commit, installs its packages and runs both
builds before clearing recovery. It does not wait for reboot evidence from
the old transaction. If that repair fails, its saved state and commands refer
to the commit you chose; it does not reset to the failed update's old target.
Switching branches clears the old transaction without installing anything.
Stop the app and its helpers before repairing files or reinstalling
dependencies by hand. The manual pull, install and start path above still
works.

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
- **Not enough memory at 16k** (or the size you chose): it does not fit even
  with system memory. The
  label says how much more is needed.

Choose a smaller model or a smaller context (down to 8k), or close
other programs. The app measures free memory at the moment it checks.

### The port is in use

If another program answers on port 11434 but is not Ollama, the app says
"Port 11434 answers, but not as Ollama" and does not chat through it. The
app never stops that program. Stop it yourself, or switch to the app's own
copy in Settings › Runtime, which uses a free port from 11435 to 11444.
