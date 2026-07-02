#!/bin/sh
# wait-for-url.sh <url> [timeout-seconds=60] [soft|hard]
# Polls <url> until it returns HTTP success. "soft" exits 0 on timeout (warn
# only); "hard" (default) exits 1. Used as ExecStartPre in the cscan units.
URL="$1"
TIMEOUT="${2:-60}"
MODE="${3:-hard}"

[ -n "$URL" ] || { echo "usage: wait-for-url.sh <url> [timeout] [soft|hard]" >&2; exit 2; }

i=0
while [ "$i" -lt "$TIMEOUT" ]; do
  if curl -fsS -m 2 -o /dev/null "$URL" 2>/dev/null; then
    echo "[wait-for-url] $URL is up (${i}s)"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "[wait-for-url] timeout after ${TIMEOUT}s waiting for $URL" >&2
[ "$MODE" = "soft" ] && exit 0
exit 1
