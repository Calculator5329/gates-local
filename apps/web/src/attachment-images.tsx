import { fileUrl, openSettings } from "./session.ts";
import { setState, useStore } from "./store.ts";
import { currentDraftKey, getDraft, replaceDraft } from "./drafts.ts";
import { Icon } from "./icons.tsx";
import { removeRefused, sizeOf, useRefused } from "./refused-files.ts";
import { esc } from "./ui.tsx";

/** Chosen or dropped files a message cannot carry: name, size, the reason in the tooltip, and a way out. */
export function RefusedFiles() {
  const files = useRefused();
  // The reason is a hover tip on the chip and, for the keyboard and screen
  // readers, the description of both its buttons through a hidden line.
  return files.map(f => (
    <span className="attachment file" key={f.id} data-tip={esc(f.reason)}>
      <Icon id="clip" />
      <span className="af-t"><b>{f.name}</b><small>{f.folder ? "Folder" : sizeOf(f.size)} · not sent</small></span>
      <span className="vh" id={`refused-${f.id}`}>{f.reason}</span>
      {f.library ? <button type="button" className="ibtn xs" aria-label={`Add ${f.name} to your Library`} aria-describedby={`refused-${f.id}`} data-tip="Open Settings › Library" onClick={() => openSettings("library")}><Icon id="book" /></button> : null}
      <button type="button" className="ibtn xs" aria-label={`Remove ${f.name}`} aria-describedby={`refused-${f.id}`} onClick={() => removeRefused(currentDraftKey(), f.id)}>×</button>
    </span>
  ));
}

/** Data URLs while composing; authenticated server paths after the turn is saved. */
export function AttachmentImages({ images, removable = false }: { images: readonly string[]; removable?: boolean }) {
  const origin = useStore(s => s.serverOrigin);
  const token = useStore(s => s.fileToken);
  return images.map((image, i) => (
    <span className="attachment" key={`${i}:${image.slice(0, 80)}`}>
      <img src={image.startsWith("data:image/") ? image : fileUrl(origin ?? "", token, image)} alt={`Attached image ${i + 1}`} />
      {removable ? <button type="button" className="ibtn xs" aria-label={`Remove image ${i + 1}`} onClick={() => { replaceDraft(currentDraftKey(), { images: getDraft().images.filter((_, at) => at !== i) }); setState({ stopAsk: null }); }}>×</button> : null}
    </span>
  ));
}
