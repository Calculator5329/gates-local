import { useEffect, useRef, useState } from "react";
import { call, updateSettings } from "./session.ts";
import { getState, NA, setState, useStore } from "./store.ts";
import { Grp, Row } from "./settings-ui.tsx";

function begin() {
  setState((s) => ({ voiceConnectionVersion: s.voiceConnectionVersion + 1 }));
  return getState().voiceConnectionVersion;
}

export function VoiceSettings() {
  const settings = useStore((s) => s.settings);
  const savedVersion = useStore((s) => s.voiceConnectionVersion);
  const [url, setUrl] = useState<string | null>(null);
  const [pendingVersion, setBusy] = useState<number | null>(null);
  const busy = pendingVersion === savedVersion;
  const [err, fail] = useState<string | null>(null);
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current++; }, []);
  if (!settings || settings === NA) return null;
  const connect = async () => {
    const current = ++attempt.current;
    const version = begin();
    const valid = () => attempt.current === current && getState().voiceConnectionVersion === version;
    setBusy(version); fail(null);
    try {
      const address = (url ?? settings.whisperUrl ?? "http://127.0.0.1:8178").trim();
      await call("voice.check", { url: address });
      if (!valid()) return;
      const error = await updateSettings({ whisperUrl: address }, { voiceActionStarted: true });
      if (valid()) fail(error);
    } catch (e) { if (valid()) fail(e instanceof Error ? e.message : "Could not connect to whisper.cpp."); }
    finally { if (valid()) setBusy(null); }
  };
  const disconnect = async () => {
    const current = ++attempt.current;
    const version = begin();
    setBusy(null); fail(null);
    const error = await updateSettings({ whisperUrl: null }, { voiceActionStarted: true });
    if (attempt.current === current && getState().voiceConnectionVersion === version) fail(error);
  };
  return <Grp title="Voice to text" desc="Your local whisper.cpp transcribes audio. Gates Local keeps no recording. Review the draft before sending.">
    <Row label="Speech server" desc={settings.whisperUrl ? "Connected for dictation. Gates Local never starts or stops this service." : "Off. Connect your running local server to use the microphone."} err={err}>
      <input className="inp" aria-label="whisper.cpp address" value={url ?? settings.whisperUrl ?? "http://127.0.0.1:8178"} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
      <button type="button" className="btn outline" disabled={busy} onClick={() => void connect()}>{busy ? "Connecting…" : "Connect"}</button>
      {settings.whisperUrl ? <button type="button" className="btn ghost" onClick={() => void disconnect()}>Disconnect</button> : null}
    </Row>
  </Grp>;
}
