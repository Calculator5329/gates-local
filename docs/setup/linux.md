# Setting up Gates Local on Linux

This guide covers a Linux x64 machine. Linux is the only platform tested so
far.

You need a graphical desktop session (X11 or Wayland). The app is a desktop
window and does not run over a plain SSH or console login.

Rather not do this by hand? [Let Claude Code set it up](with-claude-code.md).

If you have an AppImage, it includes Node and the app, so the clone's Node
and pnpm steps below are unnecessary. The AppImage needs FUSE 2 compatibility
on most distributions. On Ubuntu 24.04 and newer: `sudo apt install libfuse2t64`.
Other distributions call the compatibility package `libfuse2` or `fuse2`.
If FUSE cannot be installed, use the documented fallback:
`./Gates-Local.AppImage --appimage-extract-and-run` (substitute your filename).
See [AppImage's FUSE instructions](https://docs.appimage.org/user-guide/troubleshooting/fuse.html).
Do not disable Chromium's sandbox to launch the app.

## 1. Install Node.js 24 and pnpm 11

Gates Local needs Node.js 24 or newer. Install it from your distribution, or
follow <https://nodejs.org/en/download>. Check the version:

```sh
node --version   # v24 or newer
```

The repository pins pnpm 11.10.0 in `package.json`. The Node.js 24
downloads from nodejs.org include Corepack, which installs that version
for you:

```sh
corepack enable pnpm
```

Some distribution packages of Node.js leave Corepack out. Arch Linux, for
example, ships it as a separate `corepack` package. If the `corepack`
command is missing, install that package or install pnpm as
<https://pnpm.io/installation> describes.

## 2. Install Ollama and pull a first model

Install Ollama with the instructions at <https://ollama.com/download>. On
most distributions this sets up an `ollama` system service that starts on
boot.

Pull a first model. `qwen3.5:9b` is a 6.6 GB download:

```sh
ollama pull qwen3.5:9b
```

On a GPU with 8 GB it is close. At 16k the app estimates it needs about
8.2 GB, so it may put part of the model in system memory there. The label
next to the model in the app says which. On a machine with less memory,
`qwen3.5:4b` (3.3 GB) is lighter. You can also skip this step: with no
models installed, the app offers a short list to download on first run.

If you do not install Ollama, the app tries to download a pinned Ollama
release from GitHub into its own data folder on first launch. That path has
not been tested on a real machine yet.

## 3. Get the code and start the app

```sh
git clone https://github.com/Calculator5329/gates-local.git
cd gates-local
pnpm --version   # 11.10.0, read from package.json
pnpm install
pnpm start
```

`pnpm install` downloads the dependencies. `pnpm start` builds the web
client and the desktop app, then opens the window. The first `pnpm start`
also downloads the Electron binary (about 120 MB) from GitHub into
`~/.cache/electron`.

If `pnpm start` stops with "No usable sandbox!" before a window opens, see
[Electron stops with "No usable sandbox!"](#electron-stops-with-no-usable-sandbox).

The window has no menu bar. These keys work while the window has focus:

| Keys | What they do |
| --- | --- |
| Ctrl+R | Reload the window |
| Ctrl+Shift+R | Reload without the cache |
| Ctrl+W | Close the window |
| Ctrl+Q | Quit |
| F11 | Full screen |
| Ctrl+= (or Ctrl++), Ctrl+-, Ctrl+0 | Zoom in, zoom out, back to 100% |
| Ctrl+Shift+I | Developer tools, when the app runs from a clone as here |

On first run the app looks for Ollama on `127.0.0.1:11434`:

- **Ollama answers:** the app uses it and lists its models. The app never
  stops this Ollama, because it did not start it.
- **Nothing answers:** the app starts its own copy of Ollama on the first
  free port from 11435 to 11444. It uses the `ollama` binary on your `PATH`
  if there is one. This copy keeps its models in the app's data folder, apart
  from any system install. The app stops this copy when it quits.

You can switch between the two later in Settings › Runtime.

### Optional: add Gates Local to your app list

`pnpm start` opens the window but does not add the app to your desktop's
app list. To add a launcher and the app's icon for your user, run this in
the clone after the first `pnpm start`:

```sh
cd apps/desktop
node scripts/install-linux.ts --exec node_modules/electron/dist/electron --exec-arg "$PWD"
cd ../..
```

It writes the launcher `gates-local.desktop` and two icon files under
`~/.local/share`, or `$XDG_DATA_HOME` if you set it; the table in
[section 5](#5-where-the-app-keeps-its-data) lists them. A file already at
one of those paths is moved into a `gates-local-install-backups/` folder
there first, never overwritten. Desktops that match a window to its
launcher, as most Wayland desktops do, also take the window's icon from it.

The launcher starts Electron from the clone by absolute path, on the build
the last `pnpm start` made. If you move the clone, run the command again
from the new place.

### Optional: the shell tool

The model's shell tool runs commands in a sandbox with no network, no home
folder and read-only access to your Library. It needs:

- an x86_64 or aarch64 CPU;
- bubblewrap at `/usr/bin/bwrap` (the `bubblewrap` package);
- working unprivileged user namespaces, which bubblewrap uses to build the
  sandbox;
- a systemd user session that can start scopes with memory and task
  limits (`systemd-run --user --scope`), which caps each command at 512 MB
  and 64 tasks;
- `sqlite3` at `/usr/bin/sqlite3` (the `sqlite3` or `sqlite` package), for
  questions about a connected database. On Linux, database queries go
  through this tool.

If any of the first four is missing, the shell tool is off and the read
tool still works.

## 4. Optional: image generation with ComfyUI

Image generation is off by default. While it is off the app does not
contact ComfyUI. It needs a running ComfyUI. The app does not install
ComfyUI.

- **Address:** `http://127.0.0.1:8188` by default. You can change it in
  Settings › Image generation. It can point to another machine, and the
  image prompt is then sent to that machine.
- **Models:** the image picker offers three tiers by the card's memory.
  Fast is FLUX.2 Klein 4B on an 8 GB card, or a compact Klein below that.
  Balanced is Z-Image Turbo int8 on a 6 GB card, or the compact Klein. Best
  is MOSS-Image on a 4 GB card. For a ComfyUI on this machine, the picker
  downloads a setup's files into ComfyUI's model folders and checks each
  one's SHA-256. The app asks ComfyUI for its model lists before each job.
  If a file is missing, the job fails with a message naming it.
- **Memory:** Image mode needs a GPU with 4 GB. What other programs hold
  never changes the tier, but a job still needs the room. For a ComfyUI on this
  machine, the app reads free GPU memory with `nvidia-smi` before each job,
  counting what ComfyUI already holds. If the GPU is short, it first
  unloads the chat models it loaded itself. It never unloads models other
  programs loaded. With ComfyUI on the CPU, or a card under 4 GB, the picker says
  it needs a GPU and the app picks no image setup for you. A ComfyUI on
  another machine skips this check.
- **Starting ComfyUI:** with the default address only, if ComfyUI is not
  answering and you have a `comfyui.service` systemd user unit, the app
  starts it with `systemctl --user start comfyui.service`. It stops the unit
  after five idle minutes, but only if the app started it. Otherwise, start
  ComfyUI yourself before you generate an image.

Turn it on in Settings › Image generation. Images are saved in the app's
data folder under `images/`.

## 5. Where the app keeps its data

| What | Where |
| --- | --- |
| Threads, settings, database copies, images, and the record and log of the app's own Ollama | The data folder: `~/.local/share/gates-local`, or `$XDG_DATA_HOME/gates-local` |
| The Ollama the app downloads, and the models of the app's own Ollama copy | `runtime/ollama/` and `models/` in `~/.local/share/gates-local`, or `$XDG_DATA_HOME/gates-local` |
| Electron's profile (window state and cache) | `~/.config/gates-local`, or `$XDG_CONFIG_HOME/gates-local` |
| The Electron download | `~/.cache/electron` |
| Models of the system Ollama | wherever Ollama keeps them, usually `/usr/share/ollama/.ollama/models` or `~/.ollama/models` |
| The launcher and icons, if you added them | `applications/gates-local.desktop`, `icons/hicolor/scalable/apps/gates-local.svg` and `icons/hicolor/512x512/apps/gates-local.png` in `~/.local/share`, or `$XDG_DATA_HOME`; files they replaced in `gates-local-install-backups/` there |

Inside the data folder, `threads.sqlite` holds your threads,
`settings.json` your settings, `snapshots/` the database copies and
`images/` the generated images.

To move only the data folder, set `GATES_LOCAL_DATA_DIR` to an absolute
path before `pnpm start`. The downloaded Ollama and its models stay in
`~/.local/share/gates-local`, or `$XDG_DATA_HOME/gates-local` if that is
set. To move everything, including those large files, set `XDG_DATA_HOME`
to an absolute path instead, for example
`XDG_DATA_HOME=/mnt/big/share pnpm start`. The app then uses
`/mnt/big/share/gates-local` for both, as long as `GATES_LOCAL_DATA_DIR`
and `GATES_LOCAL_USER_DATA` are not set: either of those still decides
where the data folder goes. Electron's profile follows `XDG_CONFIG_HOME`,
not `XDG_DATA_HOME`. Move an existing folder there first, with the app
closed, to keep what is in it.

## 6. Updating

Close the app, then, from the clone:

```sh
pnpm run app-update
```

`pnpm run app-update` lists what is new (at most 20 changes, or a
release's notes), moves the clone to it, runs `pnpm install` and builds the
app, opens it, and waits for a ready server. A failed first startup restores
and starts the previous build once. `pnpm run app-update --check` only lists. The app's Settings ›
General › Updates does the same. The desktop app also checks this clone's
git remote (`git fetch` and `git ls-remote`) 15 seconds after startup and
hourly after that, sharing one check across windows. Turn off "Check for
updates automatically" there to stop future automatic git processes and
network requests; a check in progress finishes. It defaults on. Browsers
can check when asked; the phone listener exposes status only. Nothing installs without a click.
The update button beside Settings names the target and changes in its
tooltip. "Update and restart" confirms running replies, image jobs and model
downloads first. Active imports must finish before installation. It then closes the window during install and build and opens
the app again. Partial replies are saved; downloaded model parts are kept
and downloading the same model again resumes them. Save drafts and queued
messages before restarting. Offline background checks show no failure.

Which version it moves to:

- Once the project has release tags (`v1.2.3`), the newest release, by
  version number, so `v0.10.0` comes after `v0.9.0`. A copy already past
  that release is up to date: it never goes backwards.
- With no release tags yet, or with `--channel main`, or with "Get every
  change, not only releases" on in Settings, the newest commit on the
  branch the clone follows.

It refuses, and changes nothing, when:

- a tracked file has changes. It lists them, and `git stash`, the update,
  then `git stash pop` keeps them. Untracked and ignored files do not count.
- the clone has commits of its own. It never merges or resets over them.
- the app is still running.
- another update of the same clone is running. Only one runs at a time.

It stops before moving anything when the new version would put a file where
you have an untracked or ignored one, and names the file. Move or rename it
and run the update again.

If a step fails (no network, `pnpm install` or a build stops), it goes back
with `git reset --keep` to the commit you had, installs and builds that
again, and prints `The update to <new> stopped at <step>: <reason>. Gates
Local is still on <old>.` The full output is in `update-logs/` in the data
folder. If going back fails too, it prints the exact commands to run in
the clone.

If an update is cut off (a crash, a power cut, Ctrl+C), run
`pnpm run app-update` again. It finishes the install and builds, or
finishes going back, before it looks for anything newer. Until then
`--check` and "Check for updates" say the last update did not finish.

Three states stop the next run until you step in, and each says what to do:

- A step ran past its limit and could not be stopped. Nothing else runs
  until that process has ended, so end it or restart the computer.
- The copy is part way between two versions, because a merge or a reset was
  cut off while it was writing files. The updater will not clean that up,
  since your own edits could be among those files. Copy anything you want
  to keep, then run `git reset --hard` and the update again.
- You changed tracked files, the branch or the commit while the update
  ran, and a step then failed. It does not go back, so your work stays put.
  Close the app, then run `pnpm install` and `pnpm start`, which install and
  build what the copy is on now.

An update that is still running is never taken over, however quiet it has
been: wait for it, or end the process it names.

The manual way still works, and is what to use if the command itself
cannot run. Close the app first. From a copy left part way between two
versions, run `git reset --hard` before the pull.

```sh
git pull --ff-only
pnpm install
pnpm start
```

Your threads and settings stay where they are. If a newer build changed the
thread database, an older build refuses to open it rather than change it.

The launcher, if you added one, runs the build the last `pnpm start` made,
so it picks up the update after that. If you moved the clone, add the
launcher again from the new place.

If you added the AppArmor profile from the troubleshooting section, check
its path again after an update: the path names the Electron version.

## 7. Uninstalling

Close the app. From inside the clone, run:

```sh
cd ..
rm -rf gates-local
```

That removes the app but keeps your data. To remove your data too, which
is a separate choice and cannot be undone:

```sh
rm -rf ~/.local/share/gates-local ~/.config/gates-local
```

Also delete these if they apply to you:

- `$XDG_DATA_HOME/gates-local` and `$XDG_CONFIG_HOME/gates-local`, if you
  set those variables;
- the folder you set in `GATES_LOCAL_DATA_DIR`;
- the folder you set in `GATES_LOCAL_USER_DATA`, which holds the profile
  and, unless `GATES_LOCAL_DATA_DIR` is set, the data folder as
  `server-data/`;
- `~/.cache/electron`, if no other Electron project uses it;
- the launcher and icons, if you added them:
  `applications/gates-local.desktop`,
  `icons/hicolor/scalable/apps/gates-local.svg`,
  `icons/hicolor/512x512/apps/gates-local.png` and any
  `gates-local-install-backups/` folder, all in `~/.local/share`, or in
  `$XDG_DATA_HOME` if you set it;
- `/etc/apparmor.d/gates-local-electron`, if you added it (with sudo, then
  run `sudo apparmor_parser -R` on it before deleting).

The app's own Ollama copy and the models it downloaded in that mode are in
`~/.local/share/gates-local`, or `$XDG_DATA_HOME/gates-local`, even when
`GATES_LOCAL_DATA_DIR` or `GATES_LOCAL_USER_DATA` put the rest of the data
elsewhere, so removing that folder as above removes them too. Models in the
system Ollama stay. Remove them with
`ollama rm <model>`, or uninstall Ollama as its documentation describes.

## 8. Troubleshooting

### Electron stops with "No usable sandbox!"

Ubuntu 23.10 and later, and other distributions that restrict unprivileged
user namespaces with AppArmor, stop Electron's sandbox from starting. Then
`pnpm start` ends with "No usable sandbox!" before a window opens.

The scoped fix is an AppArmor profile that lets only this repository's
Electron binary use user namespaces. It needs sudo.

1. Print the binary's path. Run this in the clone after the first
   `pnpm start`, which downloads the binary:

   ```sh
   realpath apps/desktop/node_modules/electron/dist/electron
   ```

2. Save this text in a file named `gates-local-electron` in your home
   folder. Replace `/path/to/electron` with the path from step 1. If the
   path contains spaces, put it in double quotes.

   ```
   abi <abi/4.0>,
   include <tunables/global>

   profile gates-local-electron /path/to/electron flags=(unconfined) {
     userns,

     include if exists <local/gates-local-electron>
   }
   ```

3. Install and load the profile (needs sudo):

   ```sh
   sudo cp ~/gates-local-electron /etc/apparmor.d/gates-local-electron
   sudo apparmor_parser -r /etc/apparmor.d/gates-local-electron
   ```

Then run `pnpm start` again.

The blunt alternative turns the restriction off for every program on the
machine until the next reboot:

```sh
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

That removes a protection the distribution turned on on purpose: it makes
kernel bugs that need user namespaces harder to exploit. Prefer the
profile.

Do not start the app with `--no-sandbox`. It turns off the protection
around the app's window.

The profile covers Electron only. The shell tool's bubblewrap needs user
namespaces too; on these systems it may stay off, and the rest of the app
still works.

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

In the model picker each model shows one of three words for the chosen
context:

- **Fits:** the model fits in free GPU memory.
- **Slower:** part of it runs in system memory. Replies are slower.
- **Not enough memory:** it does not fit even with system memory. Its
  tooltip says how much more is needed.

To fix it, choose a smaller model or a smaller context (down to 8k), or
close other programs that use the GPU. The app measures free
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
