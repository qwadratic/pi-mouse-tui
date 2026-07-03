#!/usr/bin/env bash
# demo.sh — scripted asciinema demo of pi-last-trace.
# Drives pi (with the extension) inside tmux via send-keys; asciinema records
# the attached client. Output: demo.cast (+ demo.gif via `agg demo.cast demo.gif`).
#
# Usage: DEMO_CWD=/dir/with/workflow/runs ./demo.sh
#   DEMO_CWD = project whose ~/.pi/workflows runs to browse (default: caller cwd).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EXT="$HERE/extension/index.ts"
WORKDIR="${DEMO_CWD:-$PWD}"
SESSION=pi-last-trace-demo
CAST="$HERE/demo.cast"
COLS=110 ROWS=30

typewrite() { local s=$1 i; for ((i = 0; i < ${#s}; i++)); do tmux send-keys -t "$SESSION" -l "${s:i:1}"; sleep 0.06; done; }
key() { tmux send-keys -t "$SESSION" "$1"; }

driver() {
  sleep 8                                            # pi startup
  typewrite "/trace"; sleep 1.2; key Enter; sleep 4  # Screen A: last executed run
  key Down; sleep 0.8; key Down; sleep 1.2
  key Enter; sleep 4                                 # Screen B: agent detail, jumped to last output
  key PPage; sleep 2; key PPage; sleep 2             # PgUp paging
  key NPage; sleep 2                                 # PgDn paging
  key g; sleep 2; key G; sleep 2                     # top / bottom
  key Escape; sleep 2                                # back to run header + agent list
  key q; sleep 1.5                                   # close viewer
  typewrite "/trace --done"; sleep 1.2
  key Enter; sleep 0.5; key Enter; sleep 4           # 1st Enter accepts completion, 2nd submits
  key q; sleep 2
  tmux kill-session -t "$SESSION"
}

tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x "$COLS" -y "$ROWS" \
  "cd '$WORKDIR' && pi -e '$EXT'"
tmux set-option -t "$SESSION" status off
driver &
DRIVER=$!
asciinema rec --headless --overwrite --window-size "${COLS}x${ROWS}" \
  -c "tmux attach -t $SESSION" "$CAST"
wait "$DRIVER"
echo "cast: $CAST ($(tail -n +2 "$CAST" | jq -s '[.[][0]] | add | round' 2>/dev/null || true)s)"
