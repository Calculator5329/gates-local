#!/bin/sh
# Leave the app box before running the harness checkout's synthetic GPU tool.
printf '%s' "$$" > "$GL_PERF_HELPER_GROUP/cgroup.procs" || exit 1
exec taskset -c "$GL_PERF_HELPER_CPUS" "$(dirname "$0")/../fake-ollama/nvidia-smi.sh" "$@"
