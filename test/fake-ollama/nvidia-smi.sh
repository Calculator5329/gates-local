#!/bin/sh
# Linux fixture: read the current JSON without starting Node or caching answers.
query=
for arg do
  case "$arg" in --query-*) query=$arg; break ;; esac
done
LC_ALL=C GL_FAKE_SMI_QUERY=$query GL_FAKE_SMI_ARGS="$*" exec awk -f "$(dirname "$0")/nvidia-smi.awk"
