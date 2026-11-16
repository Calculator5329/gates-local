import { inUpdatesFolder, type Verified } from "@gates-local/update/installed/download";
import { INSTALL_REFUSAL, type Restart } from "@gates-local/update/installed/copy";
import type { ProcessRecord } from "@gates-local/update/identity";
import type { UpdateAndRestartResult } from "../bridge.ts";
import type { Copy } from "./routing.ts";
import type { Approval } from "@gates-local/update/installed/transaction";
import type { Begin } from "./watch.ts";
import * as words from "@gates-local/update/installed/words";

export interface InstalledClick {
  readonly restart: Restart;
  readonly copy: Copy | null;
  readonly running: string;
  readonly serverPid: number | undefined;
  readonly verify: (version: string) => Promise<Verified>;
  readonly begin: (approval: Approval) => Begin;
  readonly record: (pid: number) => ProcessRecord;
  readonly askedAt: number;
  readonly bootId: () => string;
  readonly quit: () => void;
}

const NOT_READY = "The app server is not ready to approve an update. Try again after it reconnects.";

function cannot(restart: Exclude<Restart, "yes">, version: string): string {
  // why: a Windows install updates through windows.ts, so this click refuses it like one that cannot.
  if (restart === "none" || restart === "windows") return INSTALL_REFUSAL;
  if (restart === "pinned") return words.pinnedDataFolder(version).text;
  return words.cannotReplace(restart, version).text;
}

export async function startInstalledUpdate(target: string, o: InstalledClick): Promise<UpdateAndRestartResult> {
  const match = /^(\d+\.\d+\.\d+):([a-f0-9]{128})$/.exec(target);
  if (match === null) return { ok: false, message: "An exact checked version and current server approval are required. Check for updates again." };
  const [, version, digest] = match as unknown as [string, string, string];
  if (o.restart !== "yes" || o.copy === null) return { ok: false, message: cannot(o.restart === "yes" ? "not-appimage" : o.restart, version) };
  if (inUpdatesFolder(o.copy.dataDir, o.copy.program)) return { ok: false, message: cannot("download-folder", version) };
  if (o.serverPid === undefined) return { ok: false, message: NOT_READY };
  const verified = await o.verify(version);
  if (!verified.ok || verified.prepared.listSha512 !== digest || verified.prepared.version !== version) {
    return { ok: false, message: words.badDownload(version, true).text };
  }
  const begun = o.begin({
    copy: o.copy, from: o.running, to: version, listDigest: digest, artifact: verified.prepared.artifact,
    uptime: o.askedAt, boot: o.bootId(), main: o.record(process.pid), server: o.record(o.serverPid),
  });
  if (begun.kind === "refused") return { ok: false, message: begun.words.text };
  o.quit();
  return { ok: true };
}
