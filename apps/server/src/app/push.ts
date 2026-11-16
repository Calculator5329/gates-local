// why: a module that only pushes imports this file and nothing else of the app
import type { Channel, Payload, SyncChange } from "@gates-local/contracts";

export type Push = <C extends Channel>(channel: C, payload: Payload<C>, changes?: readonly SyncChange[]) => void;
