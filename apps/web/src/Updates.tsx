// Eager update surfaces only. Settings controls live in SettingsUpdates.tsx.
import { Icon } from "./icons.tsx";
import { canUpdateHere, updateAndRestart } from "./session.ts";
import { NA, useStore } from "./store.ts";
import { updateButton } from "./update-state.ts";

/** Fixed footer slot beside Settings: appearing never changes the surrounding layout. */
export function SidebarUpdate() {
  const status = useStore((s) => s.update);
  const installing = useStore((s) => s.updateInstalling);
  const error = useStore((s) => s.updateError);
  const button = updateButton(status === NA || status === undefined ? null : status, canUpdateHere(), installing, error);
  return button === null ? null : (
    <button type="button" className={`ibtn sb-update ${button.state}`} aria-label={button.label} title={`${button.label}\n${button.detail}`} disabled={button.disabled} onClick={() => void updateAndRestart()}>
      <Icon id={button.state === "installing" ? "spin" : button.state === "failed" ? "alert" : "download"} cls={button.state === "installing" ? "spin" : undefined} />
    </button>
  );
}
export { UpdateNote, UpdateNoteView } from "./UpdateNote.tsx";
