import { useEffect, useRef, useState } from "react";
import { call, updateSettings } from "./session.ts";
import { getState, NA, setState, useStore } from "./store.ts";
import { COMPUTER_ONLY, Grp, Row, Skel } from "./settings-ui.tsx";
import { setTalk, useTalk } from "./talk.ts";


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
  const locked = useStore((s) => s.unavailable["settings.update"] === true);
  const talk = useTalk().on;
  useEffect(() => () => { attempt.current++; }, []);
  if (settings === NA) return null;
  // Settings arrive before Settings can open on a healthy start; the card keeps its shape when they do not.
  if (settings === undefined) return <Grp title="Voice to text" busy>
    <Row label="Speech server" desc={<Skel w="22em" />}><Skel w="18em" /></Row>
  </Grp>;
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
  return <Grp title="Voice to text">
    <Row label="Speech server" desc={settings.whisperUrl ? "Connected" : locked ? `Off. ${COMPUTER_ONLY}` : undefined} err={err}>
      {locked ? null : <>
        <input className="inp" data-testid="settings.voice.address" aria-label="whisper.cpp address" value={url ?? settings.whisperUrl ?? "http://127.0.0.1:8178"} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
        <button type="button" className="btn outline" data-testid="settings.voice.connect" disabled={busy} onClick={() => void connect()}>{busy ? "Connecting…" : "Connect"}</button>
        {settings.whisperUrl ? <button type="button" className="btn ghost" data-testid="settings.voice.disconnect" onClick={() => void disconnect()}>Disconnect</button> : null}
      </>}
    </Row>
    {settings.whisperUrl ? <Row label="Talk mode" desc="Try-out, on this device. Hold the microphone or Space to talk; let go to send.">
      <button type="button" className="switch" role="switch" data-testid="settings.voice.talk" aria-checked={talk} aria-label="Talk mode" onClick={() => setTalk({ on: !talk })} />
    </Row> : null}
  </Grp>;
}
