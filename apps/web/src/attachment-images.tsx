import { fileUrl } from "./session.ts";
import { setState, useStore } from "./store.ts";
import { currentDraftKey, getDraft, replaceDraft } from "./drafts.ts";

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
