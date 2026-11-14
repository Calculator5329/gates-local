#!/bin/sh
# Leave the app box before starting the synthetic GPU tool's Node runtime.
printf '%s' "$$" > "$GL_PERF_HELPER_GROUP/cgroup.procs" || exit 1
exec taskset -c "$GL_PERF_HELPER_CPUS" "$GL_PERF_NODE" "$GL_PERF_TARGET/test/fake-ollama/nvidia-smi.ts" "$@"
