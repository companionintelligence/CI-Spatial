#!/usr/bin/env bash
set -euo pipefail

if ! sudo -n true 2>/dev/null; then
  cat >&2 <<'EOF'
sudo is required for Ollama remediation.
Run this script from an interactive shell after granting sudo:
  scripts/fix-ollama.sh
EOF
  exit 1
fi

cache_dir="${OLLAMA_CACHE_DIR:-/mnt/cache/ollama}"
ci_models="${HOME}/.ollama/models"
dropin_dir="/etc/systemd/system/ollama.service.d"

echo "Inspecting current listeners on :11434"
sudo ss -ltnp 'sport = :11434' || true

rogue_pids="$(pgrep -u "$USER" -f 'ollama serve' || true)"
if [[ -n "$rogue_pids" ]]; then
  echo "Stopping user-level ollama serve process(es): $rogue_pids"
  kill $rogue_pids || true
  sleep 2
fi

sudo systemctl stop ollama.service || true
sudo install -d -o ollama -g ollama -m 0755 "$cache_dir"

if [[ -d "$ci_models/blobs" || -d "$ci_models/manifests" ]]; then
  echo "Moving model store from $ci_models to $cache_dir"
  for name in blobs manifests; do
    if [[ -d "$ci_models/$name" && ! -e "$cache_dir/$name" ]]; then
      sudo mv "$ci_models/$name" "$cache_dir/$name"
    elif [[ -d "$ci_models/$name" ]]; then
      echo "$cache_dir/$name already exists; leaving $ci_models/$name in place" >&2
    fi
  done
fi

sudo chown -R ollama:ollama "$cache_dir"
sudo install -d -m 0755 "$dropin_dir"
sudo tee "$dropin_dir/zz-cscan-gpu.conf" >/dev/null <<EOF
[Service]
Environment=OLLAMA_MODELS=$cache_dir
Environment=HIP_VISIBLE_DEVICES=0
Environment=OLLAMA_CONTEXT_LENGTH=16384
Environment=OLLAMA_KEEP_ALIVE=1h
EOF

sudo systemctl daemon-reload
sudo systemctl restart ollama.service
sleep 3
systemctl status --no-pager ollama.service || true
curl -fsS http://127.0.0.1:11434/api/tags >/dev/null
echo "Ollama API is reachable. Check GPU residency with: ollama ps"
