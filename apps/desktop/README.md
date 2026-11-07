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
| `src/preload.ts` | Sandboxed preload: `contextBridge.exposeInMainWorld("gatesLocal", …)`. |
| `scripts/build.ts` | esbuild: `src/main.ts` -> `out/main.cjs`, `src/preload.ts` -> `out/preload.cjs`. |
| `scripts/smoke.ts` | Headless real-Electron smoke of the crash/restart Accept line. |

## Scripts

- `pnpm --filter @gates-local/desktop build`: bundle to `out/` (gitignored).
- `pnpm --filter @gates-local/desktop start`: build, then `electron .`
  (opens a real window; needs the server entry and, in dev, Vite on 5187).
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
     `~/.config/gates-local/server-data`.
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
  `exit` hook SIGKILLs the child synchronously as a last resort.

## Window and bridge

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`;
  `window.open` denied; renderer navigations outside the client origin
  blocked; permission requests denied; IPC accepted only from the main
  frame of our window.
- While the server is starting, crashed or restarting, the window shows the
  local status page (a `data:` URL). On `ready` it loads the client.
- Client URL: `GATES_LOCAL_WEB_URL` if set; else dev mode (unpackaged
  default, or `GATES_LOCAL_WEB=dev`) loads `http://127.0.0.1:5187/` (Vite);
  dist mode (`GATES_LOCAL_WEB=dist`, packaged default) loads
  `apps/web/dist/index.html` (packaged: `<resources>/web/index.html`). A
  failed client load shows the status page with "Try again", not a blank
  window.
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
| `GATES_LOCAL_DATA_DIR` | `<userData>/server-data` | `--data-dir`. |
| `GATES_LOCAL_USER_DATA` | `~/.config/gates-local` | Electron userData (smoke runs use a temp dir). |
| `GATES_LOCAL_WEB` | `dev` unpackaged, `dist` packaged | Which client to load. |
| `GATES_LOCAL_WEB_URL` | none | Exact client URL; wins over `GATES_LOCAL_WEB`. |

## Not done here

- Packaging (electron-builder or similar) and the packaged server layout.
- The real web client's reconnect (a later `apps/web` lane, against the
  duties above).
