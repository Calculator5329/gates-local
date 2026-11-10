// Fit report freshness, retained history and retry lifetime.
import type { BlockingTurn, FitReport, GpuStatus, MethodName, Params, Payload, ResultOf } from "@gates-local/contracts";
import { NA, type State, chatReady, fitKey, getState, runningThreads, setState } from "../store.ts";

type Request = <M extends MethodName>(method: M, params: Params<M>) => Promise<ResultOf<M>>;

interface FitEffects {
  readonly applyServerEvent: typeof setState;
  readonly call: Request;
  readonly blockingFor: (model: string, numCtx: number) => Promise<readonly BlockingTurn[]>;
  readonly isStopped: () => boolean;
}

const ownedChatModel = (o: GpuStatus["occupants"][number]) => o.kind === "chat-model" && !o.protected;
const gpuOccupantKey = (g: GpuStatus, owned: boolean) => g.occupants.filter(o => ownedChatModel(o) === owned)
  .map(o => JSON.stringify([o.kind, o.label, Math.round(o.bytes / 1024 ** 2), o.protected])).toSorted().join("|");

/** A reply is running or a model is loading: either one ends by changing GPU memory and every fit report with it. */
export const fitsAboutToChange = (s: State): boolean =>
  runningThreads(s).size > 0 || Object.values(s.loads).some(load => load.state === "loading");

/** Only decides whether old words stay on screen; every pick still needs a current fit.check answer. */
function onlyIdleOwnedModelsChanged(s: State, next: GpuStatus): boolean {
  const before = s.gpu;
  if (!before || before === NA || before.vendor !== "nvidia" || next.vendor !== "nvidia" ||
    before.name !== next.name || before.totalBytes !== next.totalBytes || before.detail !== next.detail ||
    before.freeBytes === undefined || next.freeBytes === undefined || fitsAboutToChange(s)) return false;
  if (gpuOccupantKey(before, true) === gpuOccupantKey(next, true) || gpuOccupantKey(before, false) !== gpuOccupantKey(next, false)) return false;
  const beforeOwned = before.occupants.filter(ownedChatModel).reduce((sum, o) => sum + o.bytes, 0);
  const nextOwned = next.occupants.filter(ownedChatModel).reduce((sum, o) => sum + o.bytes, 0);
  // nvidia-smi rounds free memory to MiB; a larger unexplained loss is an external change.
  return Math.abs(before.freeBytes + beforeOwned - next.freeBytes - nextOwned) <= 1024 ** 2;
}

export const staleFitReports = (s: State): State["staleFits"] => {
  const keys = new Set(Object.keys(s.fits));
  if (s.catalog !== NA) for (const c of s.catalog ?? []) if (c.fit) keys.add(fitKey(c.name, c.fit.numCtx));
  return Object.fromEntries([...keys].map(key => [key, true as const]));
};

export const staleFitStatus = (s: State): State["fitStatus"] => Object.fromEntries(Object.keys(staleFitReports(s)).map(key => [key, "stale" as const]));

export function createFit({ applyServerEvent, call, blockingFor, isStopped }: FitEffects) {
  // A report remains readable while its replacement is measured. The epoch also
  // stops an answer started before a memory change from becoming current.
  const fitChecks = new Map<string, number>();
  let fitEpoch = 0;
  const staleFits = new WeakSet<FitReport>();
  const answeredAt = new WeakMap<FitReport, number>();

  function markFitsStale(): void {
    fitEpoch++;
    const s = getState();
    for (const r of Object.values(s.fits)) if (r !== undefined && r !== "error") staleFits.add(r);
    if (s.catalog !== NA) for (const c of s.catalog ?? []) if (c.fit) staleFits.add(c.fit);
    applyServerEvent(state => ({ fitStatus: staleFitStatus(state) }));
  }

  /** Memory details must wait for this reading instead of claiming an old report still fits. */
  function currentFit(report: FitReport | "error" | undefined): FitReport | "error" | undefined {
    return report !== undefined && report !== "error" && staleFits.has(report) ? undefined : report;
  }

  const fitIsCurrent = (r: FitReport | "error" | undefined) =>
    r !== undefined && r !== "error" && answeredAt.get(r) === fitEpoch;

  /** Check once per memory reading; keep the previous report until it answers. */
  function ensureFit(model: string | undefined, numCtx: number): void {
    if (model === undefined) return;
    const key = fitKey(model, numCtx);
    const s = getState();
    if (fitChecks.get(key) === fitEpoch || !chatReady(s)) return;
    checkFit(model, numCtx, key, 0);
  }

  /** A failed check is asked again after this, doubling to FIT_RETRY_MAX_MS, until it answers or memory changes. */
  const FIT_RETRY_MS = 2000;
  const FIT_RETRY_MAX_MS = 30_000;

  function checkFit(model: string, numCtx: number, key: string, failures: number): void {
    const epoch = fitEpoch;
    fitChecks.set(key, epoch);
    applyServerEvent(s => ({ fitStatus: { ...s.fitStatus, [key]: failures > 0 ? "error" : currentFit(s.fits[key]) === undefined || s.fits[key] === "error" ? "checking" : s.fitStatus[key] ?? "fresh" } }));
    call("fit.check", { model, numCtx })
      .then(async (r) => {
        // the verdict never counts memory a running reply holds: refused may only mean "stop that reply first"
        const frees = r.verdict === "refuse" && (await blockingFor(model, numCtx)).length > 0;
        if (epoch !== fitEpoch) return;
        answeredAt.set(r, epoch);
        applyServerEvent((st) => {
          const { [key]: _old, ...stopFrees } = st.stopFrees;
          const { [key]: _stale, ...remainingStale } = st.staleFits;
          const { [key]: _history, ...history } = st.fitHistory;
          return { fits: { ...st.fits, [key]: r }, fitStatus: { ...st.fitStatus, [key]: "fresh" as const }, fitHistory: history, staleFits: remainingStale, stopFrees: frees ? { ...stopFrees, [key]: true as const } : stopFrees };
        });
      })
      .catch(() => {
        if (epoch !== fitEpoch) return;
        applyServerEvent((st) => {
          const { [key]: _stale, ...remainingStale } = st.staleFits;
          const previous = st.fits[key];
          return { fits: { ...st.fits, [key]: "error" as const }, fitStatus: { ...st.fitStatus, [key]: "error" as const }, fitHistory: previous !== undefined && previous !== "error" ? { ...st.fitHistory, [key]: previous } : st.fitHistory, staleFits: remainingStale };
        });
        // A failure ends the held verdict; retry while this reading is current.
        setTimeout(() => {
          const s = getState();
          if (!isStopped() && epoch === fitEpoch && s.fits[key] === "error" && chatReady(s)) checkFit(model, numCtx, key, failures + 1);
        }, Math.min(FIT_RETRY_MAX_MS, FIT_RETRY_MS * 2 ** failures));
      });
  }

  /** Memory changed: refresh the open chat now and other reports when shown. */
  function invalidateFits(hideOld = true): void {
    if (hideOld) markFitsStale();
    else fitEpoch++;
    // A load refreshes the measurement in place. An external GPU/file change
    // withdraws the old advice; a later load must not clear that pending state.
    applyServerEvent((s) => ({ fits: { ...s.fits }, staleFits: hideOld ? staleFitReports(s) : s.staleFits, fitStatus: hideOld ? staleFitStatus(s) : s.fitStatus }));
    const s = getState();
    ensureFit(s.model, s.numCtx);
  }

  function gpuChanged(gpu: Payload<"gpu.changed">): void {
      const retain = onlyIdleOwnedModelsChanged(getState(), gpu);
      applyServerEvent({ gpu });
      invalidateFits(!retain);
  }

  return { markFitsStale, currentFit, fitIsCurrent, ensureFit, invalidateFits, gpuChanged };
}
