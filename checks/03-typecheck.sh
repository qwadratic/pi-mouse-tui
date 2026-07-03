#!/usr/bin/env bash
# Typecheck the extension (tsc --noEmit, pi packages resolved from the
# global pi install via tsconfig paths — machine-specific by design).
set -euo pipefail
cd "$(dirname "$0")/.."
npx -y -p typescript@5 tsc -p tsconfig.json
echo "typecheck OK"
