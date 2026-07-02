#!/usr/bin/env bash
set -euo pipefail

url="${1:?usage: wait-for-url.sh URL [timeout-seconds]}"
timeout="${2:-60}"
deadline=$((SECONDS + timeout))

while (( SECONDS < deadline )); do
  if curl -fsS --max-time 3 "$url" >/dev/null; then
    exit 0
  fi
  sleep 2
done

echo "Timed out waiting for $url after ${timeout}s" >&2
exit 1
