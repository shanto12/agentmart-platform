#!/usr/bin/env bash
# Fails (exit 1) when lib.ts or db.ts in auth-google drift from the copies in ../api/.
# auth-google deliberately vendors these two files (edge functions deploy independently).
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rc=0
for f in lib.ts db.ts; do
  if ! diff -u "$here/../api/$f" "$here/$f" >/dev/null; then
    echo "DRIFT: auth-google/$f differs from api/$f" >&2
    diff -u "$here/../api/$f" "$here/$f" | head -40 >&2
    rc=1
  else
    echo "ok: $f in sync"
  fi
done
exit $rc
