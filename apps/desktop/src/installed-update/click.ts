// Row H in the old main (docs/design/installed-updates.md, section 2), once
// the server has committed the person's approval of `<version>:<list digest>`:
// re-verify the download from its bytes, check it is the approved list, build
// the approval with this app's process records, begin, and quit.
import type { Verified } from "../../../server/src/update/installed/download.ts";
import { INSTALL_REFUSAL, type Restart } from "../../../server/src/update/installed/module.ts";
import type { ProcessRecord } from "../../../server/src/update/identity.ts";
import type { UpdateAndRestartResult } from "../bridge.ts";
import type { Copy } from "./routing.ts";
import type { Approval } from "./transaction.ts";
import type { Begin } from "./watch.ts";
import * as words from "./words.ts";

export interface InstalledClick {
  readonly restart: Restart;
  readonly copy: Copy | null;
  /** This copy's version. */
  readonly running: string;
  readonly serverPid: number | undefined;
  /** verifyPrepared for this copy; it deletes a folder that fails. */
  readonly verify: (version: string) => Promise<Verified>;
  /** beginUpdate with the real effects. */
  readonly begin: (approval: Approval) => Begin;
  readonly record: (pid: number) => ProcessRecord;
  readonly uptime: () => number;
  readonly bootId: () => string;
  readonly quit: () => void;
}

const NOT_READY = "The app server is not ready to approve an update. Try again after it reconnects.";

function cannot(restart: Exclude<Restart, "yes">, version: string): string {
  if (restart === "none") return INSTALL_REFUSAL;
  if (restart === "pinned") return words.pinnedDataFolder(version).text;
  return words.cannotReplace(restart, version).text;
}

export async function startInstalledUpdate(target: string, o: InstalledClick): Promise<UpdateAndRestartResult> {
  const match = /^(\d+\.\d+\.\d+):([a-f0-9]{128})$/.exec(target);
  if (match === null) return { ok: false, message: "An exact checked version and current server approval are required. Check for updates again." };
  const [, version, digest] = match as unknown as [string, string, string];
  if (o.restart !== "yes" || o.copy === null) return { ok: false, message: cannot(o.restart === "yes" ? "not-appimage" : o.restart, version) };
  if (o.serverPid === undefined) return { ok: false, message: NOT_READY };
  const verified = await o.verify(version);
  if (!verified.ok || verified.prepared.listSha512 !== digest || verified.prepared.version !== version) {
    return { ok: false, message: words.badDownload(version, true).text };
  }
  const begun = o.begin({
    copy: o.copy, from: o.running, to: version, listDigest: digest, artifact: verified.prepared.artifact,
    uptime: o.uptime(), boot: o.bootId(), main: o.record(process.pid), server: o.record(o.serverPid),
  });
  if (begun.kind === "refused") return { ok: false, message: begun.words.text };
  o.quit();
  return { ok: true };
}
