#!/usr/bin/env bash
# One-time remediation for a box where the system ollama.service crash-loops
# because an ad-hoc user-level `ollama serve` holds port 11434, and the unit's
# model store (OLLAMA_MODELS, e.g. /mnt/cache/ollama) is empty/root-owned while
# the user's ~/.ollama holds the pulled models.
#
# Run WITH sudo:  sudo scripts/fix-ollama.sh [--dry-run]
# Rollback: reverse the mv (mv $STORE/{blobs,manifests} ~USER/.ollama/models/).
set -euo pipefail

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
run() { echo "+ $*"; [ "$DRY" = "1" ] || "$@"; }

REAL_USER="${SUDO_USER:-$USER}"
USER_HOME="$(getent passwd "$REAL_USER" | cut -d: -f6)"
STORE="$(systemctl cat ollama 2>/dev/null | sed -n 's/.*OLLAMA_MODELS=\([^"]*\)".*/\1/p' | tail -1)"
STORE="${STORE:-/mnt/cache/ollama}"

echo "[fix-ollama] user=$REAL_USER store=$STORE dry=$DRY"
[ "$(id -u)" = "0" ] || { echo "must run with sudo" >&2; exit 1; }

# 1. Kill any non-systemd ollama serve holding the port
for pid in $(pgrep -f 'ollama serve' || true); do
  if [ "$(ps -o unit= -p "$pid" 2>/dev/null | tr -d ' ')" != "ollama.service" ]; then
    echo "[fix-ollama] rogue ollama serve pid=$pid (parent: $(ps -o ppid=,cmd= -p "$pid"))"
    run kill "$pid"
  fi
done

# 2. Stop the unit while we move the store
run systemctl stop ollama

# 3. Migrate the user store into the unit's store (same fs → instant)
if [ -d "$USER_HOME/.ollama/models/blobs" ]; then
  run mkdir -p "$STORE"
  run mv "$USER_HOME/.ollama/models/blobs" "$STORE/"
  run mv "$USER_HOME/.ollama/models/manifests" "$STORE/"
else
  echo "[fix-ollama] no user store at $USER_HOME/.ollama/models — skipping migration"
fi
run chown -R ollama:ollama "$STORE"

# 4. GPU + context drop-in (GPU0 for the VLM; GPU1 stays free for LingBot-Map.
#    64k ctx KV cache cannot fit next to a 19GB Q4 model in 24GB VRAM.)
DROPIN=/etc/systemd/system/ollama.service.d/zz-cscan-gpu.conf
echo "[fix-ollama] writing $DROPIN"
if [ "$DRY" != "1" ]; then
  cat > "$DROPIN" <<'EOF'
# Companion Scan GPU policy — pin the VLM to GPU0, cap context so the KV cache
# fits beside a ~19GB Q4 vision model in 24GB VRAM. GPU1 is reserved for the
# LingBot-Map torch worker (HIP_VISIBLE_DEVICES=1 in ~/.config/cscan/env).
[Service]
Environment="HIP_VISIBLE_DEVICES=0"
Environment="OLLAMA_CONTEXT_LENGTH=16384"
Environment="OLLAMA_KEEP_ALIVE=1h"
EOF
fi

# 5. Restart and verify
run systemctl daemon-reload
run systemctl restart ollama
[ "$DRY" = "1" ] && exit 0
sleep 3
systemctl --no-pager --lines=0 status ollama || true
echo "---"
curl -s localhost:11434/api/tags | head -c 400 || echo "(api/tags failed)"
echo ""
echo "[fix-ollama] done. Verify: ss -ltnp | grep 11434 ; ollama list ; journalctl -u ollama -n 5"
