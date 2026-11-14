#!/bin/sh
exec python3 "$GL_PERF_HARNESS/test/perf/placement.py" app "$GL_PERF_BROWSER" "$@"
