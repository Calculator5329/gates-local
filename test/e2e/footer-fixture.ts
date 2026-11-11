// The sidebar footer's states, driven over the page's own socket: update
// status, model downloads and runtime state are rewritten or pushed here, so
// every state can be reached in one page without a real update or download.
import type { PullProgress, UpdateStatus } from "@gates-local/contracts";
import type { Page, WebSocketRoute } from "@playwright/test";

const BASE: UpdateStatus = { version: { kind: "commit", commit: "abc1234" }, result: null, lastCheck: null, activity: [] };
const INSTALLED: UpdateStatus = { ...BASE, version: { kind: "installed", version: "1.2.0" } };
const newer = (more: Partial<{ forThisCopy: boolean; download: "downloading" | "ready" | "failed"; lines: string[] }> = {}): UpdateStatus => ({
  ...INSTALLED,
  lastCheck: { state: "newer", checkedAt: 1, current: "1.2.0", target: "1.3.0", forThisCopy: more.forThisCopy ?? true, lines: more.lines ?? ["Version 1.3.0 is out."], page: "https://example.com/releases", ...(more.download === undefined ? {} : { download: more.download }) },
});

/** Every update status the footer can be in, by the name the state sheet prints. */
export const UPDATE: Record<string, UpdateStatus> = {
  idle: BASE,
  "up to date": { ...BASE, lastCheck: { state: "up-to-date", checkedAt: 1, channel: "main", current: "abc1234" } },
  available: { ...BASE, approval: "fixture-0", lastCheck: { state: "available", checkedAt: 1, channel: "main", current: "abc1234", target: "def5678", targetCommit: `def5678${"0".repeat(33)}`, total: 3, changes: ["Faster chat", "Fewer stalls", "Clearer errors"] } },
  "available (installed copy)": newer(),
  downloading: newer({ download: "downloading", lines: ["Downloading version 1.3.0 (120 of 310 MB)."] }),
  updating: { ...BASE, installing: true },
  failed: { ...BASE, result: { at: 1, outcome: "stopped", line: "The update stopped while installing dependencies. The previous version is restored.", logPath: "/srv/updates/failure.log" } },
  "download failed": newer({ download: "failed", lines: ["The download of version 1.3.0 failed."] }),
  "can't update itself": newer({ forThisCopy: false, lines: ["Version 1.3.0 is out, with no installer for this computer."] }),
  "not a clone": { ...BASE, version: { kind: "not-a-clone" } },
  "local changes": { ...BASE, lastCheck: { state: "cannot-check", checkedAt: 1, reason: "local-changes", lines: ["This copy has changes that are not committed, so it will not update over them.", "Commit or stash them, then check again."] } },
  "could not reach the remote": { ...BASE, lastCheck: { state: "cannot-check", checkedAt: 1, reason: "remote", lines: ["Could not reach the git remote."] } },
  "rollback failed": { ...BASE, result: { at: 1, outcome: "rollback-failed", line: "The update failed and going back failed too.", commands: ["git reset --hard abc1234", "pnpm install"] } },
};
UPDATE["failed, a fresh target"] = { ...(UPDATE["available"] as UpdateStatus), result: (UPDATE["failed"] as UpdateStatus).result };

/** A desktop window: the bridge that makes canUpdateHere() true. */
export async function desktopBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.assign(window, {
      gatesLocal: {
        updateApprovalVersion: 1 as const,
        getServerUrl: async () => new URLSearchParams(location.search).get("server"),
        onState: () => () => undefined,
        updateAndRestart: async () => {
          document.documentElement.dataset["updateStarted"] = "yes";
          return { ok: true as const };
        },
      },
    });
  });
}

const isRuntime = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && "baseUrl" in v && "state" in v;

/** Route the page's socket. Answers update.status from `update`, holds every update.check and update.download until released, and remembers the runtime status so it can be pushed changed. */
export async function footerSocket(page: Page) {
  let route: WebSocketRoute | undefined;
  let update: UpdateStatus = UPDATE["idle"] as UpdateStatus;
  let runtime: Record<string, unknown> | undefined;
  const held: string[] = [];
  const downloads: string[] = [];
  const sent: string[] = [];
  let statusRefusal: string | undefined;
  let prepareBlock: string | undefined;
  const refuse = (id: string, message: string) => route?.send(JSON.stringify({ type: "response", id, ok: false, error: { code: "failed", message } }));
  await page.routeWebSocket(/\/\?token=/, (socket) => {
    route = socket;
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { method?: string; id: string };
      if (message.method?.startsWith("update.")) sent.push(message.method);
      if (message.method === "update.status" && statusRefusal !== undefined) refuse(message.id, statusRefusal);
      else if (message.method === "update.prepare" && prepareBlock !== undefined) socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: { state: "blocked", message: prepareBlock } }));
      else if (message.method === "update.status") socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: { ...update, canControl: true } }));
      else if (message.method === "update.check") held.push(message.id);
      else if (message.method === "update.download") downloads.push(message.id);
      else if (message.method === "update.dismissResult") {
        update = { ...update, result: null };
        socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: { dismissed: true } }));
      } else if (message.method === "update.prepare") {
        const check = update.lastCheck;
        const result = check?.state === "available" && check.targetCommit !== undefined ? { state: "ready", reservation: "fixture-reservation", targetCommit: check.targetCommit } : { state: "changed", status: update };
        socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result }));
      } else if (message.method === "update.cancel") socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result: { cancelled: true } }));
      else server.send(raw);
    });
    server.onMessage((raw) => {
      if (typeof raw === "string") {
        const m = JSON.parse(raw) as { result?: unknown; payload?: unknown };
        const r = isRuntime(m.result) ? m.result : isRuntime(m.payload) ? m.payload : undefined;
        if (r !== undefined) runtime = r;
      }
      socket.send(raw);
    });
  });
  const send = (channel: string, payload: unknown) => {
    if (!route) throw new Error("socket not ready");
    route.send(JSON.stringify({ type: "push", channel, payload }));
  };
  return {
    update: (name: keyof typeof UPDATE) => {
      update = UPDATE[name] as UpdateStatus;
      send("update.changed", { ...update, canControl: true });
    },
    /** Push any status, as a check that answered elsewhere (the hourly one, Settings, another window) does. */
    push: (status: UpdateStatus) => {
      update = status;
      send("update.changed", { ...update, canControl: true });
    },
    /** Refuse every later update.status with the server's words, or answer again. */
    failStatus: (message?: string) => {
      statusRefusal = message;
    },
    /** Answer update.prepare as blocked with the server's words. */
    blockPrepare: (message?: string) => {
      prepareBlock = message;
    },
    /** Answer every held update.check with an up-to-date result. */
    releaseCheck: () => {
      for (const id of held.splice(0)) route?.send(JSON.stringify({ type: "response", id, ok: true, result: { state: "up-to-date", checkedAt: 2, channel: "main", current: "abc1234" } }));
    },
    /** Refuse every held update.check with the server's words. */
    failCheck: (message: string) => {
      for (const id of held.splice(0)) refuse(id, message);
    },
    /** Refuse every held update.download with the server's words. */
    failDownload: (message: string) => {
      for (const id of downloads.splice(0)) refuse(id, message);
    },
    /** The update.* requests the page sent, in order. */
    sent: () => [...sent],
    pull: (p: PullProgress) => send("models.pull", p),
    /** Push the runtime as `state` (e.g. "stopped", "wrong-service"), or back to what the server last said. */
    runtime: (state?: string) => {
      if (runtime === undefined) throw new Error("no runtime status seen yet");
      send("runtime.changed", state === undefined ? runtime : { ...runtime, state });
    },
  };
}

export const QWEN14: PullProgress = { name: "qwen3:14b", state: "downloading", completedBytes: 5_700_000_000, totalBytes: 9_276_198_565 };
export const QWEN4: PullProgress = { name: "qwen3.5:4b", state: "downloading", completedBytes: 800_000_000, totalBytes: 3_324_173_934 };

/** The footer's geometry: its own box and every button's, rounded to a tenth of a pixel. */
export async function footerBoxes(page: Page) {
  const [foot, ...buttons] = await page.locator(".sb-foot").evaluate((f) =>
    [f, ...f.querySelectorAll(":scope button.ibtn")].map((e) => {
      const b = e.getBoundingClientRect();
      return [b.x, b.y, b.width, b.height].map((n) => Math.round(n * 10) / 10);
    }),
  );
  return { foot, buttons };
}

/** Visible words inside the footer (the confirm excepted): there should be none. */
export async function footerWords(page: Page): Promise<string[]> {
  return page.locator(".sb-foot").evaluate((foot) => {
    const words: string[] = [];
    const walk = document.createTreeWalker(foot, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n !== null; n = walk.nextNode()) {
      if (n.parentElement?.closest(".cfm") !== null) continue;
      if ((n.textContent ?? "").trim() !== "") words.push((n.textContent ?? "").trim());
    }
    return words;
  });
}
