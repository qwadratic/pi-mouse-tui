#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node 02-resolver.mjs
bash 03-typecheck.sh
node 04-viewer-smoke.mjs
bash 01-load.sh
echo "all checks OK"
