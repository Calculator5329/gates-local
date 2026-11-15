// How the server sends on a push channel. Its own file so a module that only
// pushes (image, measure, settings, runtime services) imports nothing else of the app.
import type { Channel, Payload, SyncChange } from "@gates-local/contracts";

export type Push = <C extends Channel>(channel: C, payload: Payload<C>, changes?: readonly SyncChange[]) => void;
