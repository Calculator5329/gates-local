import type { AttachedFile } from "@gates-local/contracts";
import { fileUrl, openSettings } from "../lib/session/index.ts";
import { NA, setState, useStore } from "../lib/store/store.ts";
import { currentDraftKey, getDraft, replaceDraft } from "../lib/store/drafts.ts";
import { Icon } from "../lib/ui/icons.tsx";
import { removeRefused, sizeOf, useRefused } from "./refused-files.ts";
import { esc } from "../lib/ui/ui.tsx";
import { releaseFiles } from "./file-holds.ts";

export function RefusedFiles() {
  const files = useRefused();
  return files.map(f => (
    <span className="attachment file" key={f.id}>
      <Icon id="clip" />
      <span className="af-t"><b>{f.name}</b><small>{f.folder ? "Folder" : sizeOf(f.size)} · {f.short}</small></span>
      <span className="vh" id={`refused-${f.id}`}>{f.reason}</span>
      {f.library ? <button type="button" className="ibtn xs" data-testid="chat.attachment.refused-library" aria-label={`Add ${f.name} to your Library`} aria-describedby={`refused-${f.id}`} data-tip="Open Settings › Library" onClick={() => openSettings("library")}><Icon id="book" /></button> : null}
      <button type="button" className="ibtn xs" data-testid="chat.attachment.refused-remove" aria-label={`Remove ${f.name}`} aria-describedby={`refused-${f.id}`} onClick={() => removeRefused(currentDraftKey(), f.id)}>×</button>
    </span>
  ));
}

export function AttachedFiles({ files, removable = false }: { files: readonly AttachedFile[]; removable?: boolean }) {
  const toolsOff = useStore(s => s.settings !== NA && s.settings?.tools === false);
  const off = removable && toolsOff;
  return files.map((f, i) => {
    const tip = off ? `The model can't open ${f.name} until tools are on.` : undefined;
    return (
      <span className={off ? "attachment file off" : "attachment file"} key={f.path} data-tip={tip === undefined ? undefined : esc(tip)} data-testid="chat.attachment.file">
        <Icon id="clip" />
        <span className="af-t"><b>{f.name}</b><small>{sizeOf(f.size)}{off ? " · tools off" : ""}</small></span>
        {off ? <><span className="vh" id={`attached-${i}`}>{tip}</span><button type="button" className="ibtn xs" data-testid="chat.attachment.tools-on" aria-label="Turn on tools" aria-describedby={`attached-${i}`} data-tip="Open Settings › Tools" onClick={() => openSettings("tools")}><Icon id="wrench" /></button></> : null}
        {removable ? <button type="button" className="ibtn xs" data-testid="chat.attachment.remove-file" aria-label={`Remove ${f.name}`} onClick={() => { replaceDraft(currentDraftKey(), { files: (getDraft().files ?? []).filter(x => x.path !== f.path) }); setState({ stopAsk: null }); releaseFiles([f.path]); }}>×</button> : null}
      </span>
    );
  });
}

export function AttachmentImages({ images, removable = false }: { images: readonly string[]; removable?: boolean }) {
  const origin = useStore(s => s.serverOrigin);
  const token = useStore(s => s.fileToken);
  return images.map((image, i) => (
    <span className="attachment" key={`${i}:${image.slice(0, 80)}`}>
      <img src={image.startsWith("data:image/") ? image : fileUrl(origin ?? "", token, image)} alt={`Attached image ${i + 1}`} />
      {removable ? <button type="button" className="ibtn xs" data-testid={`chat.attachment.remove-image-${i + 1}`} aria-label={`Remove image ${i + 1}`} onClick={() => { replaceDraft(currentDraftKey(), { images: getDraft().images.filter((_, at) => at !== i) }); setState({ stopAsk: null }); }}>×</button> : null}
    </span>
  ));
}
