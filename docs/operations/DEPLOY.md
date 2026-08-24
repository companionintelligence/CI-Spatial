# Deploying CI-Spatial as a persistent server (Linux + systemd)

Turn any Linux box on your tailnet into an always-on scan server: production
web bundle over HTTPS on `:5173`, Deno API on `:8000`, GPU inference via the
system Ollama service, weekly cert renewal. Nothing here is needed for the
laptop dev workflow (`npm start` still works unchanged).

## Architecture

```
phone (Safari / Chrome over Tailscale)
  └── https://<host>.ts.net:5173      cscan-web    (vite preview, prod bundle,
        │                                           TLS cert + API proxy)
        └── http://127.0.0.1:8000     cscan-server (Deno API: infer, scans,
              │                                     worlds, sessions, jobs)
              └── http://127.0.0.1:11434  ollama.service (system unit, GPU0)
                     └── LingBot-Map torch worker (spawned per job, GPU1)
```

`vite preview` inherits `server.https`/`proxy` from `vite.config.ts`, so the
production server has the exact TLS + same-origin proxy wiring phones use in
dev — no HMR, faster loads.

## One-time setup

```bash
# 0. Prereqs: node ≥20, deno ≥2, tailscale up, and lingering so user services
#    run without a login session:
sudo loginctl enable-linger $USER

# 1. HTTPS cert for this machine (from the repo root; certs are gitignored):
tailscale cert <your-machine>.<tailnet>.ts.net
#    If it fails with an operator error: sudo tailscale set --operator=$USER

# 2. If the system ollama.service is crash-looping or its model store is
#    empty while your user store has the models (see the script header):
sudo scripts/fix-ollama.sh          # kills rogue serve, migrates store,
                                    # pins GPU0 + 16k ctx via drop-in

# 3. Install + enable everything:
scripts/install-services.sh
```

The installer:
- substitutes absolute `deno`/`npm` paths into the unit templates (user units
  don't get your login PATH)
- seeds `~/.config/cscan/env` from `deploy/cscan.env.example` (hostname
  auto-detected from `tailscale status`), merging `~/.config/cscan/env.lingbot`
  if the LingBot-Map setup produced one
- enables `cscan-server`, `cscan-web`, and the weekly `cscan-cert.timer`

## Configuration

All box-local config lives in `~/.config/cscan/env` (never in the repo):

| Var | Meaning |
|-----|---------|
| `TAILSCALE_HOSTNAME` | HTTPS hostname phones use (must match the cert) |
| `ALLOWED_ORIGIN_PREFIX` | Origin accepted by CORS + used in share links |
| `PORT` | Deno API port (default 8000) |
| `INFERENCE_MODE` | `ollama` \| `onnx` \| `mock` |
| `OLLAMA_MODEL` | vision model tag (install candidates with `npm run setup:models`, pick with `npm run bench:models`) |
| `CSCAN_SKIP_BUILD` | `1` = skip `vite build` on cscan-web restart |
| `LINGBOT_MAP_PYTHON` / `LINGBOT_MAP_MODEL_PATH` | reconstruction worker |
| `HIP_VISIBLE_DEVICES` | GPU for the LingBot worker (`1`; Ollama is pinned to `0` via its own drop-in) |
| `BRUSH_BIN` | Brush CLI for the `splat-train` job (default `~/brush/src/target/release/brush-cli`) |
| `BRUSH_DEVICE` | wgpu adapter pin for Brush (default `DiscreteGpu(1)`; **not** HIP — see below) |
| `BRUSH_TRAIN_ITERS` / `BRUSH_SH_DEGREE` / `BRUSH_MAX_RES` | Brush training knobs (defaults `15000` / `2` / `1280`) |

Apply config changes: `systemctl --user restart cscan-server cscan-web`.

## Day-to-day

```bash
systemctl --user status cscan-server cscan-web      # health at a glance
journalctl --user -u cscan-server -f                # API logs (infer timing, jobs)
journalctl --user -u cscan-web -f                   # build + preview logs
journalctl -u ollama -f                             # model load/GPU logs
curl -fs https://$TAILSCALE_HOSTNAME:5173/health    # end-to-end probe
npm run logs:watch                                  # live phone-side console
                                                    # (pages loaded with ?debug=remote)
```

**Dev iteration on the same box** (HMR instead of the prod bundle):

```bash
systemctl --user stop cscan-web cscan-server
npm start                        # dev servers, same URLs
systemctl --user start cscan-server cscan-web       # back to persistent mode
```

**Updating the deployment**: `git pull && systemctl --user restart cscan-web`
(the unit rebuilds the bundle on start unless `CSCAN_SKIP_BUILD=1`).

## GPU policy (2× 24GB example)

The system Ollama unit is pinned to GPU0 via
`/etc/systemd/system/ollama.service.d/zz-cscan-gpu.conf`
(`HIP_VISIBLE_DEVICES=0`, `OLLAMA_CONTEXT_LENGTH=16384`, `OLLAMA_KEEP_ALIVE=1h`)
— a ~19GB Q4 vision model + 16k KV cache fits in 24GB; 64k ctx would spill to
CPU. GPU1 stays free for LingBot-Map reconstruction jobs. Install candidates
with `npm run setup:models`, pick one with `npm run bench:models`
(precision/recall/latency on the generated CV corpus), and set `OLLAMA_MODEL`
accordingly.

## Splat training (Brush)

The `splat-train` world job trains a Gaussian splat from a scan's keyframe
session using [Brush](https://github.com/ArthurBrussee/brush). Full details in
[../pipelines/splat-train.md](../pipelines/splat-train.md); the deploy-relevant bits:

- **Binary**: build Brush once and point `BRUSH_BIN` at the `brush-cli`
  release binary (default `~/brush/src/target/release/brush-cli`). If the
  binary is missing the job records a `skipped` manifest with a remediation
  hint — the server never crashes.
- **GPU pin**: Brush uses `wgpu-native`, **not** HIP, so it is pinned with
  `BRUSH_DEVICE=DiscreteGpu(1)` (the CUBECL/wgpu adapter selector) rather than
  `HIP_VISIBLE_DEVICES`. This targets the non-Ollama 7900 XTX and avoids the
  `llvmpipe` software adapter. Because Ollama is on GPU0 and LingBot-Map also
  uses GPU1, do not run a splat-train and a LingBot-Map job concurrently on a
  2-GPU box.
- **Knobs**: `BRUSH_TRAIN_ITERS` (default 15000), `BRUSH_SH_DEGREE` (2),
  `BRUSH_MAX_RES` (1280). A 15k-iter run is minutes-to-tens-of-minutes
  depending on frame count and resolution.
- **Artifacts** land in `SCANS_DIR` next to the scan: `<base>.splat.ply` (+ an
  optional `<base>.compressed.ply`) and `<base>.splat-train.manifest.json`,
  served through the gated `/scans/…` allowlist and auto-loaded by the viewer's
  Trained-Splat layer.

## Troubleshooting

- **Phone gets cert warning** → cert missing/expired for the hostname the QR
  points at: `tailscale cert <host>` then `systemctl --user restart cscan-web`.
- **`/health` shows `engineLoadState: failed`** → Ollama down or model missing:
  `journalctl -u ollama -n 50`; `ollama list`.
- **ollama.service restart-loops with `bind: address already in use`** → a
  stray user-level `ollama serve` owns :11434 → `sudo scripts/fix-ollama.sh`.
- **Units dead after reboot** → lingering off: `sudo loginctl enable-linger $USER`.
- **203/EXEC on unit start** → npm/deno moved (asdf/nvm switch): rerun
  `scripts/install-services.sh` to re-resolve absolute paths.
