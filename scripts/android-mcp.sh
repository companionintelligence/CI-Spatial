#!/usr/bin/env bash
# Android device MCP fleet — token plumbing and health checks.
#
# The problem this solves: `.mcp.json` is tracked, so every device token in it is
# a `${...}` placeholder, and Claude Code expands those from its **process
# environment** only. `.env` is not read by anything — not by Claude Code, not by
# the Deno server (which calls Deno.env.get directly). So putting tokens in
# `.env` and starting Claude Code does nothing on its own. This script is the
# bridge: it keeps the secrets in one gitignored place and gets them into the
# environment Claude Code actually inherits.
#
#   scripts/android-mcp.sh check     # probe every device (default)
#   scripts/android-mcp.sh env       # print export lines: eval "$(… env)"
#   scripts/android-mcp.sh persist   # add them to your shell profile, idempotently
#   scripts/android-mcp.sh launch    # exec `claude` with the tokens loaded
#
# Tokens come from the environment if already set, otherwise from `.env` in the
# repo root (gitignored; see .env.example for the variable names). Read each
# device's value from its own Settings → Access in the android-remote-control-mcp
# app. Never put them in `.mcp.json` — that file is tracked, and a token granting
# tap and screen-read control of a device is permanent once committed.
#
# Written for bash 3.2, which is what macOS ships — no associative arrays.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ANDROID_MCP_ENV_FILE:-$REPO_ROOT/.env}"
PORT=8080
TAILNET_SUFFIX=capybara-ulmer.ts.net

# name|tailnet host|env var|description  — mirrors the fleet table in
# docs/DEVICE_TESTING.md. Keep the two in sync.
DEVICES='android-tab-s8-ultra|liams-tab-s8-ultra|ANDROID_MCP_TOKEN_TAB_S8_ULTRA|Galaxy Tab S8 Ultra (SM-X900)
android-tab-s9-ultra|galaxy-tab-s9-ultra|ANDROID_MCP_TOKEN_TAB_S9_ULTRA|Galaxy Tab S9 Ultra (SM-X910)
android-beam-pro-1|beam-pro-1|ANDROID_MCP_TOKEN_BEAM_PRO_1|XREAL X4000
android-beam-pro|beam-pro|ANDROID_MCP_TOKEN_BEAM_PRO|XREAL X4200'

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  GRN=$(printf '\033[32m'); YEL=$(printf '\033[33m'); OFF=$(printf '\033[0m')
else
  BOLD=; DIM=; RED=; GRN=; YEL=; OFF=
fi

# Read one KEY=VALUE from ENV_FILE without sourcing it — a `.env` can contain
# values with spaces, `#`, or shell metacharacters, and sourcing would execute
# them. Strips optional surrounding quotes and trailing whitespace/CR.
read_env_file() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" "$ENV_FILE" \
    | tail -1 \
    | sed -e 's/\r$//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# Which source wins depends on the question being asked, and getting this
# backwards is how a rotated token silently keeps failing:
#
#   prefer=env   for `check` — a value already exported is the one Claude Code
#                is actually using, so reporting the file's value instead would
#                describe a session that does not exist.
#   prefer=file  for `env`/`persist`/`launch` — these build a *new* environment,
#                and the file is the source of truth you just edited. Preferring
#                the current shell here would re-persist a stale token over the
#                corrected one, which is exactly the bug it is meant to fix.
token_for() {
  local var="$1" prefer="${2:-env}" from_env from_file
  eval "from_env=\${$var:-}"
  from_file=$(read_env_file "$var")
  if [ "$prefer" = file ]; then
    if [ -n "$from_file" ]; then printf '%s' "$from_file"; else printf '%s' "$from_env"; fi
  else
    if [ -n "$from_env" ]; then printf '%s' "$from_env"; else printf '%s' "$from_file"; fi
  fi
}

token_source() {
  local var="$1" from_env
  eval "from_env=\${$var:-}"
  if [ -n "$from_env" ]; then printf 'env'
  elif [ -n "$(read_env_file "$var")" ]; then printf '.env'
  else printf 'unset'; fi
}

tailscale_bin() {
  if command -v tailscale >/dev/null 2>&1; then printf 'tailscale'
  elif [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
    printf '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
  fi
}

# Ask the tailnet whether a peer is up, so an offline device is reported as
# offline rather than as a token or server problem — they look identical from
# a failed connect otherwise.
peer_state() {
  local host="$1" ts line
  ts=$(tailscale_bin) || true
  [ -n "$ts" ] || return 0
  line=$("$ts" status 2>/dev/null | awk -v h="$host" '$2 == h { print; exit }') || true
  [ -n "$line" ] || { printf 'not-on-tailnet'; return 0; }
  case "$line" in *offline*) printf 'offline' ;; *) printf 'online' ;; esac
}

probe_one() {
  local name="$1" host="$2" var="$3" desc="$4"
  local fqdn="$host.$TAILNET_SUFFIX"
  local tok src state body code
  tok=$(token_for "$var"); src=$(token_source "$var")

  printf '  %-22s %s%s%s\n' "$name" "$DIM" "$desc" "$OFF"

  if [ -z "$tok" ]; then
    printf '      %stoken   %s no value in environment or %s%s\n' "$RED" "✗" "$ENV_FILE" "$OFF"
    return
  fi
  printf '      token   %s from %s, ends …%s\n' "✓" "$src" "${tok: -4}"

  # The failure mode this catches: a token was rotated and written to .env, but
  # the shell (and therefore Claude Code) still carries the old exported value.
  # Both sources look individually fine, so only the comparison reveals it.
  local from_file
  from_file=$(read_env_file "$var")
  if [ "$src" = env ] && [ -n "$from_file" ] && [ "$from_file" != "$tok" ]; then
    printf '      %s%s     ! your shell has …%s but %s has …%s — the shell wins, so Claude Code is using the stale one.%s\n' \
      "$YEL" "     " "${tok: -4}" "$(basename "$ENV_FILE")" "${from_file: -4}" "$OFF"
    printf '      %s        fix: scripts/android-mcp.sh persist && restart Claude Code%s\n' "$YEL" "$OFF"
  fi

  state=$(peer_state "$host")
  if [ "$state" = offline ]; then
    printf '      device  %s%s tailnet peer is OFFLINE — nothing to connect to%s\n' "$RED" "✗" "$OFF"
    return
  elif [ "$state" = not-on-tailnet ]; then
    printf '      device  %s%s not found in `tailscale status`%s\n' "$YEL" "!" "$OFF"
  else
    printf '      device  %s online\n' "✓"
  fi

  # Reachability. Deliberately not `nc -z -G 4`: the connect-timeout flag `-G` is
  # BSD/macOS-only, so under Git Bash on Windows — GNU netcat, or no `nc` at all —
  # the probe always failed and every healthy device was reported "refused". curl
  # is already used for the handshake below, ships on all three platforms, and
  # hitting /health proves the app itself is answering rather than merely that a
  # socket opened. No `-f`: only curl's exit status is consulted, so an HTTP error
  # status still counts as reachable and the 503 session cap keeps reaching its
  # own branch below.
  if ! curl -s -m 4 -o /dev/null "http://$fqdn:$PORT/health"; then
    printf '      server  %s%s no answer on port %s (/health, 4s) — app not running, or bound to 127.0.0.1 instead of 0.0.0.0%s\n' \
      "$RED" "✗" "$PORT" "$OFF"
    return
  fi

  body=$(curl -s -m 12 -w '\n%{http_code}' -X POST "http://$fqdn:$PORT/mcp" \
    -H "Authorization: Bearer $tok" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"android-mcp.sh","version":"1"}}}' 2>/dev/null) || true
  code=$(printf '%s' "$body" | tail -1)

  case "$code" in
    200)
      local ver
      ver=$(printf '%s' "$body" | sed -n 's/.*"serverInfo":{[^}]*"version":"\([^"]*\)".*/\1/p' | head -1)
      printf '      mcp     %s%s handshake OK%s%s\n' "$GRN" "✓" "${ver:+ (server $ver)}" "$OFF" ;;
    401|403)
      printf '      mcp     %s%s HTTP %s — token rejected. Re-read it from Settings → Access%s\n' \
        "$RED" "✗" "$code" "$OFF" ;;
    503)
      # The app caps concurrent MCP sessions. A 503 means the token was accepted
      # and the server is healthy — it is usually *your own* Claude Code session
      # already holding the connection, so this is a pass, not a failure.
      printf '      mcp     %s%s HTTP 503 session cap — reachable and authorized, sessions already held%s\n' \
        "$GRN" "✓" "$OFF" ;;
    *)
      printf '      mcp     %s%s HTTP %s %s%s\n' "$RED" "✗" "${code:-none}" \
        "$(printf '%s' "$body" | head -c 70 | tr -d '\n')" "$OFF" ;;
  esac
}

cmd_check() {
  # Both the reachability probe and the handshake go through curl. Without it
  # every device would report unreachable — the same misdiagnosis the old
  # `nc -z -G` probe produced on Windows, so say which tool is missing instead.
  command -v curl >/dev/null 2>&1 || {
    printf '`curl` is not on PATH — `check` cannot probe anything without it.\n' >&2; exit 1; }
  printf '%sAndroid MCP fleet%s  (tokens: env, then %s)\n\n' "$BOLD" "$OFF" "$ENV_FILE"
  printf '%s\n' "$DEVICES" | while IFS='|' read -r name host var desc; do
    probe_one "$name" "$host" "$var" "$desc"
    printf '\n'
  done
  printf '%sTokens are read once at Claude Code startup — a value set now needs a restart.%s\n' "$DIM" "$OFF"
}

cmd_env() {
  printf '%s\n' "$DEVICES" | while IFS='|' read -r name host var desc; do
    tok=$(token_for "$var" file)
    [ -n "$tok" ] && printf 'export %s=%s\n' "$var" "$tok"
  done
  return 0
}

cmd_persist() {
  local profile="${1:-}"
  if [ -z "$profile" ]; then
    case "${SHELL##*/}" in
      zsh)  profile="$HOME/.zshrc" ;;
      bash) profile="$HOME/.bash_profile" ;;
      *)    printf 'Unrecognised shell %s — pass a profile path explicitly.\n' "${SHELL:-?}" >&2; exit 1 ;;
    esac
  fi
  local begin='# >>> ci-spatial android mcp tokens >>>'
  local end='# <<< ci-spatial android mcp tokens <<<'
  local block; block=$(cmd_env)
  if [ -z "$block" ]; then
    printf 'No tokens found in the environment or %s — nothing to persist.\n' "$ENV_FILE" >&2
    exit 1
  fi
  if [ -f "$profile" ] && grep -qF "$begin" "$profile"; then
    # Rewrite in place rather than appending a second block, so rotating a token
    # and re-running does not leave the old value shadowing the new one.
    local tmp; tmp=$(mktemp)
    awk -v b="$begin" -v e="$end" '
      $0 == b { skip = 1 } !skip { print } $0 == e { skip = 0 }
    ' "$profile" > "$tmp"
    mv "$tmp" "$profile"
    printf 'Replaced the existing block in %s\n' "$profile"
  fi
  { printf '\n%s\n' "$begin"; printf '%s\n' "$block"; printf '%s\n' "$end"; } >> "$profile"
  printf 'Wrote %s token(s) to %s\n' "$(printf '%s\n' "$block" | grep -c .)" "$profile"
  printf 'Open a new terminal (or `source %s`) and restart Claude Code.\n' "$profile"
}

cmd_launch() {
  local block; block=$(cmd_env)
  [ -n "$block" ] || { printf 'No tokens found — nothing to load.\n' >&2; exit 1; }
  eval "$block"
  command -v claude >/dev/null 2>&1 || { printf '`claude` is not on PATH.\n' >&2; exit 1; }
  cd "$REPO_ROOT"
  exec claude "$@"
}

case "${1:-check}" in
  check)   cmd_check ;;
  env)     cmd_env ;;
  persist) shift; cmd_persist "$@" ;;
  launch)  shift; cmd_launch "$@" ;;
  -h|--help|help)
    sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
  *)
    printf 'Unknown command: %s\n\n' "$1" >&2
    sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
    exit 1 ;;
esac
