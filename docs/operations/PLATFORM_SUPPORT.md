# Platform support

What actually runs, on which OS, with which accelerator — and, just as importantly, what
nobody has ever tried. Every row is marked **VERIFIED** (someone ran it and read the output)
or **UNVERIFIED** (inferred from the code, and therefore a guess with a citation). Nothing
here is presented as measurement unless it was measured.

## Ask your own machine instead of reading a table

```bash
deno run --allow-read --allow-env --allow-run server/capabilities.ts          # human table
deno run --allow-read --allow-env --allow-run server/capabilities.ts --json   # machine-readable
deno run --allow-read --allow-env --allow-run server/capabilities.ts --no-versions  # stat-only, no subprocesses
```

`server/capabilities.ts` probes every external tool the pipelines shell out to and reports,
for each: found or not, the **resolved absolute path**, the version where it is cheap to get,
and — when missing — the exact remediation the runner itself would have printed. It also lists
every candidate path it looked at, in order.

That last part is the reason the module exists. On 2026-08-30 COLMAP 3.13.0 was installed the
entire time at `~/.local/micromamba/envs/colmap/bin/colmap` while `which colmap` said it was
not, because a no-sudo micromamba env is not on `PATH`; ffmpeg was genuinely absent and only
said so as an HTTP 500 from `/ingest-video`. A report that answers "missing" without saying
where it looked would have cost the same hours in a nicer format.

## What was measured, and where

The **VERIFIED** rows below all come from one host, probed on 2026-08-30:

> Ubuntu 26.04.1 LTS, Linux 7.0.0-30-generic x86_64, Deno 2.9.5,
> NVIDIA GeForce RTX 4080 Laptop GPU, driver 610.57.04, 12282 MiB.

```
platform  linux/x86_64  deno 2.9.5

TOOLS
  ok      ffmpeg               7.0.2-static  /home/liam/.local/bin/ffmpeg  (path)
  ok      ffprobe              7.0.2-static  /home/liam/.local/bin/ffprobe  (path)
  ok      colmap               3.13.0 (CUDA)  /home/liam/.local/micromamba/envs/colmap/bin/colmap  (fallback)
  ok      brush                1.0.0  /home/liam/brush/target/release/brush-cli  (fallback)
  ok      spirula              2026.8.28  /home/liam/opt/spirula/spirula  (fallback)
  ok      panoptic-python      3.12.3  /home/liam/.venvs/panoptic/bin/python  (fallback)
          torch: 2.13.0+cu130 → cuda (cuda 13.0)
  ok      panoptic-worker      /home/liam/panoptic  (fallback)
  MISSING splat-detect-python  (looked in: /home/liam/.venvs/splat-analyzer/bin/python)
  MISSING splat-detect-dir     (looked in: /home/liam/splat_analyzer)
  ok      lingbot-map-python   3.14.4  /usr/bin/python3  (path)
          torch: absent — ModuleNotFoundError: No module named 'torch'
  MISSING lingbot-map-model    (looked in: nowhere — no candidate paths)

GPU (driver presence only)
  detected nvidia   NVIDIA GeForce RTX 4080 Laptop GPU, 610.57.04, 12282 MiB
  none     amd      No rocminfo/rocm-smi on PATH.
  none     apple    Not an Apple Silicon host.
```

Note what the last two tool rows say together: `/usr/bin/python3` exists and has **no torch**,
while `~/.venvs/panoptic/bin/python` on the same machine has torch 2.13.0+cu130. torch is a
per-interpreter fact, not a per-machine one, and `server/lingbot-map/lingbot_map.ts:115`
defaults to the bare `python3`. Any table that reported "torch: yes" for this host would be
lying about the process that actually needs it.

## Operating systems

| | Linux x86_64 | macOS (Apple Silicon) | macOS (Intel) | Windows |
| --- | --- | --- | --- | --- |
| Deno server + Vite frontend | **VERIFIED** | UNVERIFIED | UNVERIFIED | UNVERIFIED |
| Tool resolution (`server/capabilities.ts`) | **VERIFIED** | UNVERIFIED | UNVERIFIED | UNVERIFIED — both branches unit-tested, never run on Windows |
| ffmpeg / ffprobe ingest | **VERIFIED** (7.0.2) | UNVERIFIED (`brew install ffmpeg` lands on PATH) | UNVERIFIED | UNVERIFIED |
| COLMAP pose solve | **VERIFIED** (3.13.0 CUDA build, CPU features) | UNVERIFIED (`brew install colmap`) | UNVERIFIED | UNVERIFIED |
| Brush splat training | **VERIFIED** (binary + version only) | UNVERIFIED (needs Metal) | UNVERIFIED | UNVERIFIED |
| Spirula splat training | **VERIFIED** (binary + version only) | **Known not to work** — releases are `ubuntu-vulkan-x86_64` | Known not to work | UNVERIFIED |
| Panoptic / splat-detect / LingBot-Map workers | **VERIFIED** (panoptic venv only) | UNVERIFIED | UNVERIFIED | UNVERIFIED |

"VERIFIED (binary + version only)" means the probe found and version-stamped the tool on this
box. It does **not** mean a capture was pushed through it in this pass. For an end-to-end run
on this same host — COLMAP 27.6 s, Brush 166 s — see ADR 0007's Context section, which is
where that measurement lives.

### Windows: three things that are true by reading the code

1. `isRunnable()` and `whichPath()` (`server/exec_probe.ts`) both carry an explicit Windows
   branch — no POSIX exec bit, `;` as the PATH separator, PATHEXT suffixes tried before the
   bare name. Both branches are unit-tested from Linux via the injectable `ExecPlatform`
   (`tests/unit/deno/capabilities.test.ts`, `tests/unit/deno/exec_probe.test.ts`).
   **UNVERIFIED on real Windows** — the tests prove the logic, not the host.
2. Every runner builds its fallback install path from `HOME` alone
   (`Deno.env.get('HOME') ?? '~'` — colmap_poses.ts:96, splat_train.ts:97,
   spirula_train.ts:128, panoptic_scan.ts:38-39, splat_detect.ts:39-40). Windows normally sets
   `USERPROFILE`, not `HOME`, so on Windows those fallbacks degrade to the literal string
   `~/...` and resolve to nothing. `server/capabilities.ts` reads `USERPROFILE` as a second
   choice (`resolveHome`), so the **report** is right on Windows even where the **runners**
   would not be. Setting the per-tool env var (`COLMAP_BIN`, `BRUSH_BIN`, …) sidesteps this
   entirely and is the recommended Windows configuration.
3. The fallback paths keep forward slashes after the home prefix
   (`C:\Users\you/brush/target/release/brush-cli`). Deno's filesystem calls accept mixed
   separators, so this is expected to work — **UNVERIFIED**.

## Accelerators

| | NVIDIA / CUDA | AMD / ROCm | Apple Silicon / Metal + MPS | CPU only |
| --- | --- | --- | --- | --- |
| Driver detected by the report | **VERIFIED** (nvidia-smi) | UNVERIFIED (`rocminfo` / `rocm-smi` probe never exercised on AMD hardware) | UNVERIFIED (derived from `Deno.build`, no hardware) | n/a |
| torch reports the device | **VERIFIED** — `2.13.0+cu130`, `cuda_available=True`, `version.hip=None` | UNVERIFIED | UNVERIFIED | **VERIFIED** — a torch-less `python3` is reported as such |
| ffmpeg ingest | **VERIFIED** | UNVERIFIED | UNVERIFIED | works — ffmpeg here is CPU |
| COLMAP poses | **VERIFIED** | UNVERIFIED | UNVERIFIED | works by design — `USE_GPU = '0'` in colmap_poses.ts, CPU feature extraction is the portable default |
| Brush / Spirula training | UNVERIFIED (present, not run in this pass) | UNVERIFIED | UNVERIFIED | **Known not to work** — both need a Vulkan/Metal device |
| 4D person capture (4DAnyone) | **Known not to work on this host** — needs ~44 GiB on one CUDA device; this GPU has 12282 MiB. Runs off-box only (ADR 0006) | UNVERIFIED | UNVERIFIED | Known not to work |

### ROCm is not a separate branch, and must not become one

A ROCm build of torch reports `torch.cuda.is_available() == True` and uses the device string
`"cuda"`. That is how ROCm ships — it is not a bug and must not be "fixed" into a separate
device branch. `torch.version.hip` being non-`None` is the only honest NVIDIA/AMD
discriminator; `deriveAccelerator()` in `server/capabilities.ts` checks it first for exactly
this reason, and the report prints `→ rocm` where a naive reading would print `→ cuda`.

`server/splat/splat_detect.ts` is the one place already wired for AMD: it pins
`HIP_VISIBLE_DEVICES` for the analyzer subprocess, defaulting to `"1"` (splat_detect.ts:94).
That default selects the *second* device, which is a deliberate pin for the multi-GPU host it
was written on and will select a nonexistent device on a single-GPU AMD box. Set
`HIP_VISIBLE_DEVICES=0` there. **UNVERIFIED** — no AMD hardware was available.

### Apple Silicon

No Apple hardware was available, so everything in this section is UNVERIFIED by reading:

- The report detects Apple Silicon from `Deno.build.os === 'darwin' && arch === 'aarch64'`.
  There is no `apple-smi` to ask, and every arm64 Mac has an integrated GPU, so the platform
  fact *is* the measurement. An Intel Mac correctly reports not-detected.
- Python worker device selection (MPS included) now goes through `scripts/_torch_device.py`,
  landing in a parallel change. Before it, `scripts/panoptic_worker.py` and
  `scripts/lingbot_map_worker.py` each resolved `cuda` or `cpu` and never consulted
  `torch.backends.mps`, so a Mac ran on CPU silently. Check that file for the current
  behaviour rather than trusting this paragraph.
- Brush's remediation string names Metal as supported (splat_train.ts:186-189). Untested here.
- Spirula publishes `ubuntu-vulkan-x86_64` releases; no macOS build is referenced anywhere in
  this repo, which is why the OS table calls it known-not-to-work rather than untested.

## Where each tool is looked for

One convention, applied in this order for every row: **the env var always wins, then `PATH`,
then the documented no-sudo install path.** An env var that points at nothing is reported
missing — it is never silently replaced by a fallback, because an operator whose override has
a typo needs to be told.

| Tool | Env var | On PATH as | Documented fallback |
| --- | --- | --- | --- |
| ffmpeg | *(none — see below)* | `ffmpeg` | — |
| ffprobe | *(none)* | `ffprobe` | — |
| COLMAP | `COLMAP_BIN` | `colmap` | `~/.local/micromamba/envs/colmap/bin/colmap` |
| Brush | `BRUSH_BIN` | `brush-cli` | `~/brush/target/release/brush-cli` |
| Spirula | `SPIRULA_BIN` | `spirula` | `~/opt/spirula/spirula`, `~/.local/bin/spirula`, `/usr/local/bin/spirula` |
| Panoptic interpreter | `PANOPTIC_PYTHON` | — | `~/.venvs/panoptic/bin/python` |
| Panoptic checkout | `PANOPTIC_DIR` | — | `~/panoptic` |
| splat_analyzer interpreter | `SPLAT_DETECT_PYTHON` | — | `~/.venvs/splat-analyzer/bin/python` |
| splat_analyzer checkout | `SPLAT_DETECT_DIR` | — | `~/splat_analyzer` |
| LingBot-Map interpreter | `LINGBOT_MAP_PYTHON` | `python3` | — |
| LingBot-Map checkpoint | `LINGBOT_MAP_MODEL_PATH` | — | — |

ffmpeg has **no** env var on purpose. `scripts/ingest-video.mjs` spawns the bare name and
resolves it from `PATH`, so an override that only the capability report honoured would
describe a resolution the ingest path cannot make (ADR 0001: don't invent a second name for
something that already has one). If ffmpeg is installed and ingest still fails, restart the
Deno server — it resolves ffmpeg from the `PATH` it started with, not the one in your shell.

## Known not to work

| | Why |
| --- | --- |
| Brush or Spirula on a CPU-only host | Both need a Vulkan (or Metal) device. |
| Spirula on macOS | Releases are `ubuntu-vulkan-x86_64`; no macOS build is referenced in this repo. |
| 4D person capture on this fleet | `person-4d-reconstruct` needs ~44 GiB on one CUDA device. It delegates off-box by design and reports `skipped` with a hint when unconfigured — ADR 0006, `docs/pipelines/4d-person.md`. |
| ffprobe missing while ffmpeg is present | `scripts/ingest-video.mjs` guards on ffmpeg and then calls ffprobe, so a single-binary install passes the guard and fails after it. The report gives them separate rows for this reason. |

## Not yet wired into the product

The report is a module and a CLI. `GET /health` still reports only the inference model, so
nothing in the running server surfaces any of this yet. Wiring it is one route in
`server/main.ts`:

```ts
app.get('/capabilities', async (c) => c.json(await probeCapabilities()))
```

with `import { probeCapabilities } from './capabilities.ts'`. Pass `{ versions: false }` if it
is ever called on a hot path — that makes it pure `stat` calls with no subprocesses, at the
cost of the version strings and the torch blocks.

## Related

- ADR 0007 — the toolchain survey this doc grew out of, including the end-to-end timings.
- ADR 0006 — why 4D person capture is a subsystem rather than a local job.
- `docs/operations/COLMAP_SETUP.md` — the micromamba install that `which colmap` cannot see.
- `docs/pipelines/splat-train.md` — Brush and Spirula setup.
