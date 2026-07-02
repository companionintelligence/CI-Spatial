# Companion Scan Deployment

This repo can run beta-1 as a persistent Tailscale scan server with a Deno API on
`:8000` and a trusted HTTPS Vite preview frontend on `:5173`.

## One-time setup

```bash
npm install
TAILSCALE_HOSTNAME=beta-1.capybara-ulmer.ts.net npm run build
scripts/install-services.sh
```

The installer writes user units to `~/.config/systemd/user/` and seeds
`~/.config/cscan/env` from `deploy/cscan.env.example` if it does not exist.
Local machine config belongs in that env file, not in the repo.

## Services

```bash
systemctl --user status cscan-server cscan-web cscan-cert.timer
journalctl --user -u cscan-server -u cscan-web -f
```

`cscan-server.service` runs:

```bash
deno run --allow-net --allow-read --allow-write --allow-env --allow-ffi main.ts
```

`cscan-web.service` runs `npm run build` and then `vite preview --host 0.0.0.0`.
Set `CSCAN_SKIP_BUILD=1` in `~/.config/cscan/env` to skip the build step during
fast iteration.

For local development:

```bash
systemctl --user stop cscan-server cscan-web
npm start
```

## TLS certificates

The Vite config looks for a Tailscale certificate matching `TAILSCALE_HOSTNAME`.
The weekly timer refreshes:

```bash
tailscale cert beta-1.capybara-ulmer.ts.net
```

If certificate issuance fails as `ci`, run once:

```bash
sudo tailscale set --operator=ci
systemctl --user start cscan-cert.service
```

## Ollama

Use the remediation script only when you are ready to alter the system Ollama
unit and model store:

```bash
scripts/fix-ollama.sh
```

It stops rogue user-level `ollama serve` processes owned by the current user,
moves `~/.ollama/models/{blobs,manifests}` into `/mnt/cache/ollama` when the
target is empty, chowns the cache to `ollama:ollama`, and installs a drop-in that
sets:

```ini
OLLAMA_MODELS=/mnt/cache/ollama
HIP_VISIBLE_DEVICES=0
OLLAMA_CONTEXT_LENGTH=16384
OLLAMA_KEEP_ALIVE=1h
```

Verify:

```bash
curl -fsS http://127.0.0.1:11434/api/tags
ollama ps
systemctl status ollama --no-pager
```

## Model benchmark

```bash
npm run gen:test-data
BENCH_PULL=1 node scripts/bench-models.mjs
```

Reports are written to `test-data/cv/bench-summary.json` and
`test-data/cv/bench-summary.md`.

## Smoke checks

```bash
curl -f https://beta-1.capybara-ulmer.ts.net:5173/health
npm run qr -- /smoke.html
npm run logs:watch
```
