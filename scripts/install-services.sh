#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_dir="${HOME}/.config/cscan"
systemd_dir="${HOME}/.config/systemd/user"
env_file="${config_dir}/env"

need_bin() {
  local name="$1"
  local bin
  bin="$(command -v "$name" || true)"
  if [[ -z "$bin" && "$name" == "deno" && -x "${HOME}/.deno/bin/deno" ]]; then
    bin="${HOME}/.deno/bin/deno"
  fi
  if [[ -z "$bin" ]]; then
    echo "Missing required command: $name" >&2
    exit 1
  fi
  printf '%s\n' "$bin"
}

escape_sed() {
  printf '%s' "$1" | sed -e 's/[\/&]/\\&/g'
}

resolve_hostname() {
  if [[ -n "${TAILSCALE_HOSTNAME:-}" ]]; then
    printf '%s\n' "${TAILSCALE_HOSTNAME%.}"
    return
  fi
  if command -v tailscale >/dev/null 2>&1; then
    local dns
    dns="$(tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.Self?.DNSName||"").replace(/\.$/,""))}catch{}})' || true)"
    if [[ -n "$dns" ]]; then
      printf '%s\n' "$dns"
      return
    fi
  fi
  local cert
  cert="$(find "$project_dir" -maxdepth 1 -name '*.ts.net.crt' -printf '%f\n' 2>/dev/null | head -n 1 || true)"
  if [[ -n "$cert" ]]; then
    printf '%s\n' "${cert%.crt}"
    return
  fi
  printf '%s\n' "liambook.capybara-ulmer.ts.net"
}

deno_bin="$(need_bin deno)"
npm_bin="$(need_bin npm)"
node_bin="$(need_bin node)"
tailscale_bin="$(command -v tailscale || true)"
if [[ -z "$tailscale_bin" ]]; then
  tailscale_bin="/usr/bin/false"
fi
hostname="$(resolve_hostname)"

mkdir -p "$config_dir" "$systemd_dir"

if [[ ! -f "$env_file" ]]; then
  cp "$project_dir/deploy/cscan.env.example" "$env_file"
  sed -i "s/^TAILSCALE_HOSTNAME=.*/TAILSCALE_HOSTNAME=${hostname}/" "$env_file"
  echo "Seeded $env_file"
else
  echo "Using existing $env_file"
fi

render_template() {
  local src="$1"
  local dst="$2"
  sed \
    -e "s/@PROJECT_DIR@/$(escape_sed "$project_dir")/g" \
    -e "s/@DENO@/$(escape_sed "$deno_bin")/g" \
    -e "s/@NPM@/$(escape_sed "$npm_bin")/g" \
    -e "s/@NODE@/$(escape_sed "$node_bin")/g" \
    -e "s/@TAILSCALE@/$(escape_sed "$tailscale_bin")/g" \
    "$src" > "$dst"
}

for unit in cscan-server.service cscan-web.service cscan-cert.service cscan-cert.timer; do
  render_template "$project_dir/deploy/systemd/${unit}" "$systemd_dir/${unit}"
  echo "Installed user unit $unit"
done

if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "$USER" >/dev/null 2>&1 || true
fi

systemctl --user daemon-reload
systemctl --user enable --now cscan-server.service cscan-web.service cscan-cert.timer
systemctl --user status --no-pager cscan-server.service cscan-web.service cscan-cert.timer
