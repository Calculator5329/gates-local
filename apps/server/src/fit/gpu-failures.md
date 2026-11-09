# NVIDIA read failures

`readNvidiaSmi` owns classification for fit and status. Output-based absence
needs two agreeing reads, 250 ms apart; disagreement stays unreadable.
Only these failures of the GPU memory query can mean no usable NVIDIA GPU
and zero VRAM:

- `ENOENT`: the executable cannot be found. This preserves the existing
  CPU-only installation behavior; it is not a claim about installed hardware.
  A missing executable is not retried and carries no driver-repair advice.
- A complete output line `No devices were found` (optional final period,
  case ignored): NVIDIA says this means the driver is not loading correctly
  in its [MNNVL troubleshooting guide](https://docs.nvidia.com/multi-node-nvlink-systems/mnnvl-user-guide/troubleshooting.html#driver-not-loading).
  The existing status test supplies this on stdout. No NVIDIA device is
  available through that driver, so the model is budgeted in system memory.
- `NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver`:
  the existing status test and NVIDIA's [WSL guide](https://docs.nvidia.com/cuda/archive/11.3.1/pdf/CUDA_on_WSL_User_Guide.pdf)
  document this failure. NVIDIA also records the variant without `the` in
  its [support article](https://nvidia.custhelp.com/app/answers/detail/a_id/4106).
  Case is ignored; no other driver wording is inferred. After confirmation,
  and without contrary evidence, the budget uses system memory.

The longer Windows form that mentions a non-NVIDIA primary display and an
NVIDIA GPU in WDDM mode has the same classification as the short driver
message: the suffix is a possible cause, not a separate diagnosis.
Two agreeing reads and the resident-GPU contradiction rule protect against
accepting a false absence. Unknown NVML errors, driver/library mismatches,
insufficient permissions, device-handle errors and sentences that merely
contain the words `No devices were found` remain unreadable too.

Messages are checked in the error message, stdout and stderr, and in
successful stdout so classification does not depend on the exit status.
The real runner preserves both output streams.
The process query alone never establishes that the card is unavailable.

Timeouts, permissions, unknown NVML errors and malformed memory tables
remain unreadable. A timeout ends the read without retrying either query;
quick failures retry both queries once. Fit refuses and status carries the
exact same actionable explanation. A successful memory
query plus a failed process query also stays unreadable. Aborts never retry.
Every second attempt uses the same abortable 250 ms pause. Resident Ollama
GPU bytes contradict only absence reported by nvidia-smi itself: fit and
status both apply `gpuReadingConflict` and use the same refusal sentence.
ENOENT is never contradicted by resident GPU bytes: those bytes may belong
to an AMD or Intel card that nvidia-smi cannot read. Plans with no NVIDIA
reading stop no reply or image runtime to reclaim VRAM that was not measured.
On a machine without a GPU the check uses available system memory as read
and does not yet count memory another loaded model would give back.
This changes the existing refusal rather than adding a new admission rule.
The fit still measures free memory before a load; nothing sets `num_gpu`
or manages any occupant process.
