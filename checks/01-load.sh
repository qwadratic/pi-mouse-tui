#!/usr/bin/env bash
# Load check: pi loads the extension (jiti TS import + factory runs,
# /trace + ctrl+shift+t registered) and a trivial prompt exits 0.
set -euo pipefail
cd "$(dirname "$0")/.."

out="$(PI_LAST_TRACE_DEBUG=1 pi -p -e extension/index.ts "Reply with exactly: ok" 2>&1)"

echo "$out" | grep -q "\[pi-last-trace\] registered command=/trace shortcut=ctrl+shift+t" \
  || { echo "FAIL: registration debug line missing"; echo "$out"; exit 1; }

echo "load check OK"
