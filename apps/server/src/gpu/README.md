# App GPU lease

Create one `createGpuLease()` per server and share it with chat, image,
bench and dream. Whisper and other apps never acquire this process-local
lease. It does not reserve physical VRAM or coordinate other programs.

Prefer `await lease.run("chat", signal, async () => { ... })`. For callers
that need `acquire`, put its returned release function in `finally`.
An aborted waiter leaves FIFO immediately. An aborted holder keeps its
claim until the job has stopped its GPU work and returned. Throwing jobs
release in `run`'s `finally`; a server process crash discards its queue.

The image module already uses the lease. The coordinator must pass this
same instance into chat and hold it through fit, load and stream cleanup.
This lane deliberately does not change `chat.send`.

`pnpm verify:gpu` exercises the lease with no runtime or process calls.
