# @gates-local/desktop

Electron main and preload. Main supervises the Gates Local server as a
child process, shows a local error view with a Restart button when the server
dies, and gives the web client a small typed bridge (`window.gatesLocal`).

| File | What it is |
| --- | --- |
| `src/supervisor.ts` | Pure Node supervisor (no Electron imports): port, token, spawn, ready wait, state machine, restart guard, stop. |
| `src/supervisor-state.ts` | The state and crash-reason types. |
| `src/bridge.ts` | Bridge types, IPC channel names, `serverUrl()`, `toBridgeState()`. No Node imports (the sandboxed preload bundles it). |
| `src/status-page.ts` | The plain starting / crashed / load-failed page, served as a `data:` URL. |
| `src/main.ts` | Electron main: single-instance lock, window, IPC, routing between client and status page, quit path. |
| `src/launch.ts` | Pure launch decisions: background mode, window at start, quit on last window, second-launch action, the server child's env. |
| `src/preload.ts` | Sandboxed preload: `contextBridge.exposeInMainWorld("gatesLocal", …)`. |
| `src/window.ts` | The window's options: the gate-mark icon (`assets/icon.png`) and the sandboxed, isolated renderer. |
| `src/keys.ts` | No menu on Linux and Windows, so the window keys live here: Ctrl+R / Ctrl+Shift+R reload, Ctrl+W close, Ctrl+Q quit (Linux), F11 full screen, Ctrl+Shift+I dev tools (unpackaged), Ctrl +/-/0 zoom. |
| `src/desktop-entry.ts`, `src/linux-install.ts` | The Linux desktop entry (Exec in the spec's two escape layers) and its per-user install; old files move to `$XDG_DATA_HOME/gates-local-install-backups/<time>-<random>/`. |
| `scripts/build.ts` | esbuild: `src/main.ts` -> `out/main.cjs`, `src/preload.ts` -> `out/preload.cjs`. |
| `scripts/install-linux.ts` | `node scripts/install-linux.ts --exec <program> [--exec-arg <arg>]...`: installs the launcher and icons for this user. |
| `scripts/smoke.ts` | Headless real-Electron smoke of the crash/restart Accept line, the missing menu bar and the window keys. |

## Scripts

- `pnpm --filter @gates-local/desktop build`: bundle to `out/` (gitignored).
- `pnpm --filter @gates-local/desktop start`: build, then `electron .`
  (opens a real window on the built client in `apps/web/dist`; build it
  first, or run `pnpm start` at the repo root, which builds both).
- `pnpm --filter @gates-local/desktop smoke`: build, then run Electron with
  `--ozone-platform=headless` and no DISPLAY/WAYLAND_DISPLAY against the
  fake server and fake client in `test/fixtures/`. Not part of `pnpm verify`.

## Server CLI contract

The coordinator's `apps/server/src/main.ts` must follow this; the fake in
`test/fixtures/fake-server.ts` is the executable version of it.

1. **Spawn.** `process.execPath` (the Electron binary) with
   `ELECTRON_RUN_AS_NODE=1`, args
   `<server entry .ts> --port <n> --data-dir <dir>`.
   - `--port`: a free loopback port picked per launch (a restart usually gets
     a new one). Bind `127.0.0.1` only. If the bind fails, print why on
     stderr and exit non-zero; the user gets the error view and Restart
     picks a fresh port.
   - `--data-dir`: created by the supervisor before spawn. Default
     `%LOCALAPPDATA%\GatesLocal` on Windows, `$XDG_DATA_HOME/gates-local`
     (`~/.local/share/gates-local`) on Linux, `<userData>/server-data` on
     macOS (see `src/data-dir.ts`).
2. **Token.** In the environment as `GATES_LOCAL_SERVER_TOKEN` (64 hex
   characters, `crypto.randomBytes(32)`, new on every launch). Not in argv:
   `/proc/<pid>/cmdline` is readable by every local user, the environment
   only by the same user. This is the one change from the brief's
   `--token <hex>`. The server must refuse any WebSocket upgrade whose
   `token` query parameter does not match (constant-time compare, HTTP
   401 before the upgrade). Clients connect to `ws://127.0.0.1:<port>/?token=<hex>`
   (built only by `serverUrl()` in `src/bridge.ts`).
3. **Ready.** Once the WebSocket is listening, print exactly one line
   `{"ready":true,"port":<n>}` on stdout, `<n>` being the `--port` value.
   Other stdout lines are allowed and logged; a ready line naming another
   port is treated as a failed launch. No ready line within 20 s: the
   supervisor stops the process and reports `ready-timeout`.
4. **stderr** is logged line by line; the last 20 lines appear in the
   error view.
5. **SIGTERM** exits within 3 s (stop what the server owns, e.g. an
   app-owned Ollama, first). After 3 s the supervisor sends SIGKILL.
6. **Parent death.** stdin is a pipe the supervisor keeps open and never
   writes. When Electron main dies without cleanup (even SIGKILL), the kernel
   closes it. The server must exit on stdin EOF:

   ```ts
   process.stdin.on("end", () => void shutdown());
   process.stdin.resume();
   ```

   The supervisor signals only the server's pid, never a process group:
   processes the server starts are the server's to stop.

## Supervisor state machine

```
idle -> starting -> ready -> crashed -> restarting -> ready -> ...
                 \-> crashed (exit before ready, ready-timeout, bad-ready, spawn-error)
any  -> stopping -> stopped   (app quit; a stop never reports a crash)
```

- `crashed` carries `reason` (`exit` with code/signal, `ready-timeout`,
  `bad-ready`, `spawn-error`), the last stderr lines, and
  `restartBlockedUntil`.
- Restart is explicit (the error view's button, or `gatesLocal.restart()`),
  accepted only from `crashed`, and limited to 3 per 60 s; beyond that it
  returns `{ ok: false, reason: "rate-limited", retryAfterMs }` and the error
  view says when Restart opens again. Nothing restarts on its own.
- Quit (`before-quit`, window closed, SIGINT/SIGTERM/SIGHUP to main) waits for
  `supervisor.stop()`: SIGTERM, SIGKILL after 3 s, then exit. A process
  `exit` hook SIGKILLs the child synchronously as a last resort. In
  background mode closing the last window does not quit; the rest holds.

## Background mode

`electron apps/desktop --background` (or `GATES_LOCAL_BACKGROUND=1`) starts
the supervisor and server with no window, and closing the last window does
not quit. Launching the app again reaches the running instance through the
single-instance lock: it opens the window (or restores and focuses the one
that is open) on the current supervisor state, so there is still one server
per data dir. A second `--background` launch opens nothing. Quit and SIGTERM
(systemd's stop) still stop the server. Without the flag nothing changes.

## Phone access

The server can open a second listener for a phone on the owner's tailnet.
Off unless `GATES_LOCAL_WEB_LISTEN` is set; main passes these through to the
server child:

| Variable | Use |
| --- | --- |
| `GATES_LOCAL_WEB_LISTEN` | `unix:<absolute path>`: the phone listener's Unix socket, e.g. `unix:/run/user/1000/gates-local/phone.sock`. A TCP value (`127.0.0.1:<port>` included) stops the server at start. |
| `GATES_LOCAL_WEB_ORIGIN` | The exact public origin, e.g. `https://hub.example.ts.net:8456`. |
| `GATES_LOCAL_WEB_USER` | The one `Tailscale-User-Login` value admitted. |
| `GATES_LOCAL_WEB_PEERS` | Optional comma list of the phones' Tailscale addresses, e.g. `100.101.102.103,fd7a:115c:a1e0::1234`. When set, only those sources are admitted; a value that is not a list of addresses stops the server at start. |
| `GATES_LOCAL_WEB_ROOT` | Set by main to the dist dir the window serves (`webRoot()`); not yours to set. |

Deploy: `tailscale serve --bg --https=8456 unix:<path>`, with the same path
as `LISTEN` and `https://<machine>.<tailnet>.ts.net:8456` as `ORIGIN`.

The boundary is the socket's permissions. There is no token on this
listener (the phone has no way to receive one), so the listener takes
Serve's headers as identity, and only the owner and root's tailscaled may
open the socket:

- The parent directory must be a real directory (not a link) owned by this
  user with no group or other access; a missing one is made `0700`, anything
  else stops the server at start.
- The socket is bound under umask `0177`, so it is created `0600`, never
  wider; a different mode after listen closes it and stops the start.
- A file already at the path is removed only when it is this user's socket
  and nothing answers a connect (a dead server's leftover). A live socket,
  another user's, a link or a regular file stops the start untouched.

Admission matches what Serve sends a Unix backend (tailscale v1.104.4,
`ipn/ipnlocal/serve.go`): `Host: localhost`, the browser's host in
`X-Forwarded-Host`, and a `Tailscale-User-Login` Serve sets itself after
deleting any the client sent. Every request needs that login to equal the
user, `Host` to be `localhost` and `X-Forwarded-Host` to be the origin's
host. The `/ws` upgrade and any request that is not GET or HEAD also need
the exact `Origin`.

Serve names the owner for any connection from this machine to its own
Tailscale address, so another local account could reach the listener
through Serve. Each request therefore needs Serve's `X-Forwarded-For` (the
connection's source, set by Serve after deleting the client's) and that
source must not be one of this machine's interface addresses. That check
cannot see a userspace-networking tailscaled, where no interface carries
the address; set `GATES_LOCAL_WEB_PEERS` to admit only the phones.

A malformed or empty knob with `LISTEN` set stops the
server at start (fail closed). The phone shares the server's handlers and
pushes, so a reply streams to the desktop window and the phone alike. Run
the app in background mode so the phone works with the window closed.
Tested on Linux only. On Windows `process.getuid` is missing and the server
refuses to start with `LISTEN` set.

## Window and bridge

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`;
  `window.open` denied; renderer navigations outside the client origin
  blocked; permission requests denied; IPC accepted only from the main
  frame of our window.
- While the server is starting, crashed or restarting, the window shows the
  local status page (a `data:` URL). On `ready` it loads the client.
- Client URL: `GATES_LOCAL_WEB_URL` if set; else `GATES_LOCAL_WEB=dev`
  loads `http://127.0.0.1:5187/` (Vite); else (the default, packaged or not)
  `gates-local://app/index.html`, a privileged standard scheme that serves
  `apps/web/dist` (packaged: `<resources>/web`) and refuses any path outside
  it (`src/client-protocol.ts`). Not `file://`: Electron's security
  checklist warns a `file://` page can read other local files, and every
  local file shares the `file://` Origin. Measured 2026-11-07: the
  `file://` renderer's WebSocket upgrade sent `Origin: file://` and the
  server refused it (403). Main passes the client's origin to the server in
  `GATES_LOCAL_ALLOWED_ORIGINS`; a `file:` client gets none. A failed
  client load shows the status page with "Try again", not a blank window.
- `window.gatesLocal` (type `GatesLocalBridge`, exported from
  `@gates-local/desktop`):
  - `getState(): Promise<BridgeState>`
  - `getServerUrl(): Promise<string | null>`: the `ws://` URL with the
    token when ready.
  - `onState(listener): () => void`
  - `restart(): Promise<RestartResult>`
  - `reloadClient(): Promise<void>`

## What the web client must do (reconnect duties)

1. On load, call `gatesLocal.getServerUrl()`; if it is null, wait for an
   `onState` event with `status: "ready"` and use its `serverUrl`. Never
   cache the URL across launches: port and token change on every launch.
2. Keep the open thread in the URL (hash or path, e.g. `#thread=42`). When
   the server crashes, main remembers the client URL; after Restart reaches
   ready it loads that same URL, so a fresh page load must restore the thread
   from it: connect, then fetch the thread's completed messages from the
   server.
3. A partial streamed reply is gone after a crash (token deltas are memory
   only); render only what the server returns for the thread.
4. If the socket drops while the page stays loaded, do not loop on the old
   URL: wait for the next `ready` state (`onState`), then connect to its
   `serverUrl`.

## Environment overrides

| Variable | Default | Use |
| --- | --- | --- |
| `GATES_LOCAL_SERVER_ENTRY` | `apps/server/src/main.ts` (packaged: `<resources>/server/main.ts`, provisional) | Server entry passed to the child. |
| `GATES_LOCAL_DATA_DIR` | `%LOCALAPPDATA%\GatesLocal` on Windows, `$XDG_DATA_HOME/gates-local` (`~/.local/share/gates-local`) on Linux, `<userData>/server-data` on macOS or when `GATES_LOCAL_USER_DATA` is set | `--data-dir`: threads, settings, snapshots, the Ollama ownership record and serve log. The app's own Ollama install and models stay in the server's shared store (`%LOCALAPPDATA%\GatesLocal`, `~/.local/share/gates-local`) whatever this is set to, so this does not move model downloads to another disk. |
| `GATES_LOCAL_USER_DATA` | `~/.config/gates-local` | Electron userData (smoke runs use a temp dir). |
| `GATES_LOCAL_WEB` | built client on `gates-local://app` | `dev` loads Vite on 5187 (run `pnpm --filter @gates-local/web dev`). |
| `GATES_LOCAL_WEB_URL` | none | Exact client URL; wins over `GATES_LOCAL_WEB`. |

## Not done here

- Packaging (electron-builder or similar) and the packaged server layout.
- The real web client's reconnect (a later `apps/web` lane, against the
  duties above).
