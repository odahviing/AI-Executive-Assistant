#!/usr/bin/env bash
# tail-logs.sh — fetch recent Maelle logs. Runs ON the VM; run it directly once
# you're SSH'd in. NOTE: `scripts/vm-logs.ps1` no longer invokes this — it reads
# Cloud Logging as the `maelle-logs-reader` service account, with no SSH at all.
# This file is the on-box fallback for the raw winston file + pm2 stderr, which
# Cloud Logging does not carry.
#
# Usage:  bash scripts/tail-logs.sh [grep-term] [lines]
#   grep-term : optional case-insensitive filter (name, request id, error text)
#   lines     : how many matching/tail lines to show (default 200)
#
# Sources the winston structured log (today's file) + pm2's stderr for crashes.
set -uo pipefail
APP=/mnt/disks/maelle/app
FILTER="${1:-}"
LINES="${2:-200}"

LATEST=$(ls -t "$APP"/logs/maelle-*.log 2>/dev/null | head -1)
if [ -z "$LATEST" ]; then
  echo "(no winston log files in $APP/logs yet)"
else
  echo "=== $LATEST — last $LINES${FILTER:+ matching '$FILTER'} ==="
  if [ -n "$FILTER" ]; then
    grep -i -- "$FILTER" "$LATEST" | tail -n "$LINES"
  else
    tail -n "$LINES" "$LATEST"
  fi
fi

echo
echo "=== pm2 stderr (last 40 — crashes/restarts) ==="
tail -n 40 /home/idanc/.pm2/logs/maelle-error.log 2>/dev/null || echo "(none)"
