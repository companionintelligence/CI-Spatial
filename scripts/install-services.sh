#!/usr/bin/env bash
# Install the Companion Scan systemd user services on a Linux box.
#
#   scripts/install-services.sh [--no-enable]
#
# - Substitutes absolute paths into the unit templates (user units do not get
#   your login shell PATH, so npm/deno must be absolute).
# - Seeds ~/.config/cscan/env from deploy/cscan.env.example if absent, merging
#   ~/.config/cscan/env.lingbot (LingBot-Map worker config) when present.
# - Enables + starts cscan-server, cscan-web, and the weekly cert timer.
#
# Prereqs: `loginctl enable-linger $USER` (so units run without a login
# session) and a tailscale cert in the repo root (tailscale cert <hostname>).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
UNIT_SRC="$REPO/deploy/systemd"
UNIT_DST="$HOME/.config/systemd/user"
ENV_DIR="$HOME/.config/cscan"
ENV_FILE="$ENV_DIR/env"
NO_ENABLE=0
[ "${1:-}" = "--no-enable" ] && NO_ENABLE=1

die() { echo "[install-services] ERROR: $*" >&2; exit 1; }

# ── Resolve absolute binaries ────────────────────────────────────────────────
NPM_BIN="$(command -v npm)" || die "npm not on PATH"
DENO_BIN="$(command -v deno || true)"
[ -n "$DENO_BIN" ] || DENO_BIN="$HOME/.deno/bin/deno"
[ -x "$DENO_BIN" ] || die "deno not found (looked on PATH and at ~/.deno/bin/deno)"
NODE_DIR="$(dirname "$(command -v node)")"
SERVICE_PATH="$NODE_DIR:$(dirname "$DENO_BIN"):/usr/local/bin:/usr/bin:/bin"

# ── Hostname (mirror vite.config.ts resolution) ─────────────────────────────
HOSTNAME_TS="${TAILSCALE_HOSTNAME:-}"
if [ -z "$HOSTNAME_TS" ] && command -v tailscale >/dev/null; then
  HOSTNAME_TS="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1)"
fi
[ -n "$HOSTNAME_TS" ] || die "could not detect Tailscale hostname; set TAILSCALE_HOSTNAME"

# ── Lingering (units must survive logout/reboot) ────────────────────────────
if ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
  echo "[install-services] WARNING: lingering disabled — run: sudo loginctl enable-linger $USER"
fi

# ── Seed env file ────────────────────────────────────────────────────────────
# Default model mirrors src/shared/model-catalog.ts's DEFAULT_MODEL_TAG — bash
# can't import it, so this literal is a deliberately parallel copy (same
# pattern as vite.config.ts/main.ts's hostname resolution; see CLAUDE.md).
mkdir -p "$ENV_DIR" "$UNIT_DST"
if [ ! -f "$ENV_FILE" ]; then
  sed -e "s|__HOSTNAME__|$HOSTNAME_TS|g" \
      -e "s|__OLLAMA_MODEL__|${OLLAMA_MODEL:-qwen3-vl:4b}|g" \
      -e "s|__PATH__|$SERVICE_PATH|g" \
      "$REPO/deploy/cscan.env.example" > "$ENV_FILE"
  echo "[install-services] seeded $ENV_FILE"
else
  echo "[install-services] keeping existing $ENV_FILE"
fi
# Merge LingBot-Map worker config if the setup workstream produced one
if [ -f "$ENV_DIR/env.lingbot" ] && ! grep -q '^LINGBOT_MAP_PYTHON=' "$ENV_FILE"; then
  { echo ""; echo "# merged from env.lingbot"; cat "$ENV_DIR/env.lingbot"; echo "HIP_VISIBLE_DEVICES=1"; } >> "$ENV_FILE"
  echo "[install-services] merged env.lingbot into $ENV_FILE"
fi

# ── Install units ────────────────────────────────────────────────────────────
for unit in cscan-server.service cscan-web.service cscan-cert.service cscan-cert.timer; do
  sed -e "s|__REPO__|$REPO|g" \
      -e "s|__DENO__|$DENO_BIN|g" \
      -e "s|__NPM__|$NPM_BIN|g" \
      "$UNIT_SRC/$unit" > "$UNIT_DST/$unit"
  echo "[install-services] installed $UNIT_DST/$unit"
done

# ── Cert presence check ──────────────────────────────────────────────────────
if [ ! -f "$REPO/$HOSTNAME_TS.crt" ]; then
  echo "[install-services] WARNING: no cert at $REPO/$HOSTNAME_TS.crt"
  echo "                   run: tailscale cert $HOSTNAME_TS   (from $REPO)"
  echo "                   if that fails: sudo tailscale set --operator=$USER"
fi

systemctl --user daemon-reload

if [ "$NO_ENABLE" = "1" ]; then
  echo "[install-services] done (units installed, not enabled)"
  exit 0
fi

systemctl --user enable --now cscan-server.service cscan-web.service cscan-cert.timer
echo "[install-services] services enabled. Check:"
echo "  systemctl --user status cscan-server cscan-web"
echo "  journalctl --user -u cscan-server -f"
echo "  curl -f https://$HOSTNAME_TS:5173/health"
