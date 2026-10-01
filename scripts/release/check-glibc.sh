#!/usr/bin/env bash
# Fail when a shared object needs a newer glibc than the oldest one recso
# supports. It would refuse to load there ("GLIBC_2.39 not found").
#
#   scripts/release/check-glibc.sh <floor, e.g. 2.36> <file.so|.node>...
set -euo pipefail
floor="$1"
shift
status=0
for file in "$@"; do
  needed="$(objdump -T "$file" | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/^GLIBC_//' | sort -uV | tail -n 1 || true)"
  if [ -z "$needed" ]; then
    echo "$file: no versioned glibc symbols"
    continue
  fi
  highest="$(printf '%s\n%s\n' "$needed" "$floor" | sort -V | tail -n 1)"
  if [ "$highest" != "$floor" ]; then
    echo "::error file=$file::needs glibc $needed, newer than the supported $floor"
    objdump -T "$file" | grep -F "GLIBC_$needed" | head -n 10
    status=1
  else
    echo "$file: needs glibc $needed (supported: $floor)"
  fi
done
exit "$status"
