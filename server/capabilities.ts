/**
 * "What can this machine actually do?" — one honest answer, in one place.
 *
 * Why this exists, measured rather than assumed. Every stage downstream of a
 * capture is an external program this repo shells out to, and none of them
 * arrive the same way (ADR 0007 tabulates the five installs). Nothing in the
 * product could report on that: `GET /health` covers the inference model and
 * nothing else, so a missing tool announced itself as an HTTP 500 or as a job
 * that quietly went `skipped`. On 2026-08-30 that cost the bulk of one
 * end-to-end capture attempt's wall clock — ffmpeg was genuinely absent with
 * no signal until the 500, and COLMAP 3.13.0 was installed the entire time at
 * `~/.local/micromamba/envs/colmap/bin/colmap` while `which colmap` said
 * otherwise, because a no-sudo micromamba env is not on PATH.
 *
 * So the report answers three questions, not one: is it there, *where* is it,
 * and — when it is not — what exact command fixes it. `searched` lists every
 * candidate in order, because the expensive failure was a false negative that
 * read like a missing dependency, and a boolean cannot be argued with.
 *
 * Honesty rules this module holds to:
 *   - A detected GPU driver is reported as `detected`, never as working. The
 *     only evidence that a *framework* can use the device is what torch says
 *     about itself, which is why the python entries carry a `torch` block —
 *     and, for the two wgpu trainers, what a Vulkan enumeration says, which is
 *     why `gpu.vulkan` carries a `measured` flag that is true only when
 *     `vulkaninfo --summary` actually listed a device.
 *   - torch on a ROCm build reports `torch.cuda.is_available() === true` and a
 *     device string of "cuda"; `torch.version.hip` is the only thing that
 *     separates it from a real CUDA build. `deriveAccelerator` reads it that
 *     way, so an AMD box is not mislabelled NVIDIA.
 *   - Nothing here throws. A probe that cannot run is `found: false` with a
 *     remediation, the same contract every optional-GPU stage already keeps.
 *
 * ADR 0001 (reuse, don't duplicate) shapes what is and isn't here. The
 * *resolution convention* — an env var always wins, then PATH, then the
 * documented no-sudo install path — is one convention that four runners spell
 * out separately today (`FALLBACK_COLMAP_BINS` colmap_poses.ts:96,
 * `DEFAULT_BRUSH_BIN` splat_train.ts:97, `FALLBACK_SPIRULA_BINS`
 * spirula_train.ts:128, and the `DEFAULT_*_PYTHON` pairs in panoptic_scan.ts
 * and splat_detect.ts). `toolSpecs()` below is that convention as data, in one
 * table. It is deliberately not imported from those five modules: every one of
 * them is under concurrent edit, and a report that fails to build when a
 * trainer is being refactored is a report nobody runs. The collapse direction
 * is the other way — each runner should eventually resolve through
 * `resolveTool()` here and delete its own constant — which is the same "the
 * type belongs elsewhere, the other file is in flight" note colmap_poses.ts
 * already carries for `ColmapReconstructionQuality`. Until then the candidate
 * paths are stated once here and their sources are cited per entry, so a drift
 * is a grep, not a mystery.
 *
 * No new env vars are invented. Every name below is one a runner already
 * reads; ffmpeg deliberately has none, because `scripts/ingest-video.mjs`
 * resolves it from bare PATH and giving the probe an override the ingest path
 * would ignore is worse than having none.
 */
import { isRunnable, whichPath, type ExecPlatform } from './exec_probe.ts'

/** How a tool is looked for: an executable, a checkout dir, or a data file. */
export type ToolKind = 'binary' | 'python' | 'dir' | 'file'

/** Which of the three resolution steps actually produced the path. */
export type ResolvedVia = 'env' | 'path' | 'fallback'

/**
 * What a python interpreter says about its own torch.
 *
 * The single most useful field on this whole report, because torch is the one
 * dependency that is per-interpreter rather than per-machine: on 2026-08-30
 * this box's `~/.venvs/panoptic/bin/python` had torch 2.13.0+cu130 while the
 * bare `python3` that `lingbot_map.ts:115` defaults to had none. The capability
 * was on the machine and absent from the process that needed it, and no
 * machine-level probe can see that difference.
 */
export interface TorchReport {
  present: boolean
  version?: string
  /** `torch.version.cuda`, verbatim — null on a CPU or ROCm build. */
  cudaBuild?: string | null
  /** `torch.version.hip`, verbatim. Non-null is the only proof of a ROCm build. */
  hipBuild?: string | null
  /** `torch.cuda.is_available()`. True on ROCm too; see `deriveAccelerator`. */
  cudaAvailable?: boolean
  /** `torch.backends.mps.is_available()`, absent on non-Apple builds. */
  mpsAvailable?: boolean
  /** What this interpreter would actually compute on. */
  accelerator?: Accelerator
  /** Interpreter version, when the probe ran at all. */
  python?: string
  /** The import error, verbatim, when torch is absent. */
  error?: string
}

export type Accelerator = 'cuda' | 'rocm' | 'mps' | 'cpu'

export interface ToolCapability {
  id: string
  label: string
  kind: ToolKind
  /** What stops working when this is missing — the reason to care. */
  usedBy: string
  found: boolean
  /** The path that answered, absolute. Absent when nothing did. */
  path?: string
  via?: ResolvedVia
  /** The env var that overrides resolution, when the runners define one. */
  envVar?: string
  /** Cheap version string, when the tool has a cheap way to state one. */
  version?: string
  torch?: TorchReport
  /** Present iff `!found`, in the same voice as the runners' skip remediations. */
  remediation?: string
  /** Every candidate tried, in order. A false negative has to be debuggable. */
  searched: string[]
}

export type GpuVendor = 'nvidia' | 'amd' | 'apple'

export interface GpuCapability {
  vendor: GpuVendor
  /**
   * A driver/toolchain for this vendor is present. NOT a claim that anything
   * can compute on it — see this module's header and `GPU_NOTE`.
   */
  detected: boolean
  /** What answered: a binary name, or `Deno.build` for the Apple Silicon fact. */
  via: string
  detail?: string
  remediation?: string
}

export type PipelineStatus = 'ready' | 'blocked'

export interface PipelineCapability {
  id: string
  label: string
  status: PipelineStatus
  /** Tool ids this stage cannot run without. */
  requires: string[]
  /** The subset of `requires` that is missing. Empty iff status is 'ready'. */
  missing: string[]
  /** Things that will run but probably not as intended (e.g. no torch, no GPU). */
  warnings: string[]
}

/**
 * How strong the Vulkan evidence is. Only `enumerated` is a measurement.
 *
 *   enumerated      `vulkaninfo --summary` listed at least one physical device.
 *   inferred        No enumeration ran, but a loader and at least one ICD
 *                   manifest are on disk. Necessary, not sufficient.
 *   absent          Either an enumeration ran and found nothing, or there is no
 *                   loader/ICD to infer from. `measured` says which.
 *   not-applicable  macOS, where wgpu targets Metal and no Vulkan loader is
 *                   expected — reporting "absent" there would send an operator
 *                   to install something Brush does not want.
 */
export type VulkanStatus = 'enumerated' | 'inferred' | 'absent' | 'not-applicable'

export interface VulkanCapability {
  status: VulkanStatus
  /**
   * True iff a device enumeration actually ran. False means `status` was
   * derived from files on disk — see this interface's doc and `GPU_NOTE`.
   */
  measured: boolean
  /** What produced the status: the vulkaninfo path, or the filesystem check. */
  via: string
  /** `deviceName` lines from the summary. Empty whenever `measured` is false. */
  devices: string[]
  /**
   * Every enumerated device is a software rasteriser (Mesa's llvmpipe/lavapipe).
   * Vulkan "works" and Brush would train on the CPU at unusable speed, so this
   * is a distinct state from both a real GPU and no device at all. Absent when
   * nothing was enumerated — it would be a claim about devices not measured.
   */
  softwareOnly?: boolean
  /** "Vulkan Instance Version" as the loader reported it, when it ran. */
  instanceVersion?: string
  /** The loader that answered a stat, absolute. */
  loader?: string
  /** ICD manifests found, absolute. A driver with no manifest is invisible. */
  icdManifests: string[]
  detail?: string
  /** Present unless status is 'enumerated' or 'not-applicable'. */
  remediation?: string
}

export interface CapabilityReport {
  generatedAt: string
  platform: { os: ExecPlatform; arch: string; deno: string }
  tools: ToolCapability[]
  gpu: { detected: GpuCapability[]; vulkan: VulkanCapability; note: string }
  pipelines: PipelineCapability[]
}

/**
 * The disclaimer that keeps `gpu` honest.
 *
 * nvidia-smi answering proves a driver is loaded. It says nothing about
 * whether torch was built for this CUDA version, or whether the interpreter
 * that needs it has torch at all. Vulkan used to be the third unprobed hole in
 * that list and now isn't — `gpu.vulkan` covers it — but the answer there is
 * two-tier on purpose, so the note points at `measured` rather than implying
 * every Vulkan verdict is equally strong.
 */
export const GPU_NOTE =
  'Driver presence only. A detected GPU is not proof any framework can use it — ' +
  'the torch block on each python entry is the only measured evidence of that for ' +
  'the python stages, and gpu.vulkan is the equivalent for Brush/Spirula: its ' +
  'measured flag is true only when vulkaninfo actually enumerated a device, and ' +
  'false when the status is merely inferred from an installed loader and ICD manifests.'

// ── The tool table ───────────────────────────────────────────────────────────

export interface VersionProbe {
  args: string[]
  /** Both streams, because COLMAP and ffmpeg disagree about which one to use. */
  parse: (stdout: string, stderr: string) => string | null
}

export interface ToolSpec {
  id: string
  label: string
  kind: ToolKind
  usedBy: string
  /** Env var a runner already reads. Never a new one. */
  envVar?: string
  /** Bare name to look for on PATH. Omitted for things PATH never holds. */
  pathName?: string
  /** Documented no-sudo install locations, in the order the runners try them. */
  fallbacks: string[]
  remediation: string
  version?: VersionProbe
}

/**
 * Home directory for expanding the documented fallback paths.
 *
 * `HOME ?? '~'` is the idiom every runner uses; USERPROFILE is added because
 * this report is the one thing that must not silently mis-describe a Windows
 * box, and `~/...` there resolves to nothing at all.
 */
export function resolveHome(env: EnvReader): string {
  return env('HOME') ?? env('USERPROFILE') ?? '~'
}

export type EnvReader = (name: string) => string | undefined

/**
 * One row per external dependency, mirroring what each runner resolves today.
 * Each `fallbacks` entry cites the constant it mirrors; keep them in step.
 */
export function toolSpecs(home: string): ToolSpec[] {
  return [
    {
      id: 'ffmpeg',
      label: 'ffmpeg',
      kind: 'binary',
      usedBy: 'Upload Content — /ingest-video and /ingest-photos (scripts/ingest-*.mjs)',
      // No env var on purpose: ingest-video.mjs spawns the bare name, so an
      // override here would describe a resolution the ingest path cannot make.
      pathName: 'ffmpeg',
      fallbacks: [],
      remediation:
        'Install ffmpeg (`apt install ffmpeg` / `brew install ffmpeg`), or drop a static build ' +
        '(https://johnvansickle.com/ffmpeg/) somewhere already on PATH, e.g. ~/.local/bin. ' +
        'Already installed? Restart the server — it resolves ffmpeg from the PATH it started with.',
      version: {
        args: ['-version'],
        parse: (out) => firstMatch(out, /ffmpeg version (\S+)/),
      },
    },
    {
      id: 'ffprobe',
      label: 'ffprobe',
      kind: 'binary',
      usedBy: 'Video ingest clip duration, which sets the adaptive keyframe fps',
      pathName: 'ffprobe',
      fallbacks: [],
      // Its own row rather than a footnote on ffmpeg: ingest-video.mjs guards
      // on ffmpeg and then calls ffprobe, so a build that ships only the former
      // fails past the guard, which is exactly the shape of failure this
      // report exists to pre-empt.
      remediation:
        'ffprobe ships with ffmpeg — install the full package rather than a single binary, ' +
        'or put the ffprobe from the same static build on PATH beside ffmpeg.',
      version: {
        args: ['-version'],
        parse: (out) => firstMatch(out, /ffprobe version (\S+)/),
      },
    },
    {
      id: 'colmap',
      label: 'COLMAP',
      kind: 'binary',
      usedBy: 'colmap-poses — the CPU pose source for pose-less sessions',
      envVar: 'COLMAP_BIN',
      pathName: 'colmap',
      // Mirrors FALLBACK_COLMAP_BINS, server/colmap/colmap_poses.ts:96.
      fallbacks: [`${home}/.local/micromamba/envs/colmap/bin/colmap`],
      remediation: 'Install COLMAP (`brew install colmap` / `apt install colmap`) or set COLMAP_BIN.',
      version: {
        // `colmap --version` is not a recognised command (measured on 3.13.0:
        // it prints an error and still exits 0). `colmap help` prints the
        // version and the build's CUDA-ness on its first two lines.
        args: ['help'],
        parse: (stdout, stderr) => {
          const both = `${stdout}\n${stderr}`
          const v = firstMatch(both, /COLMAP\s+([\d.]+)/)
          if (!v) return null
          return /with CUDA/.test(both) ? `${v} (CUDA)` : v
        },
      },
    },
    {
      id: 'brush',
      label: 'Brush (brush-cli)',
      kind: 'binary',
      usedBy: 'splat-train — Gaussian-splat training, the default backend',
      envVar: 'BRUSH_BIN',
      pathName: 'brush-cli',
      // Mirrors DEFAULT_BRUSH_BIN, server/splat/splat_train.ts:97.
      fallbacks: [`${home}/brush/target/release/brush-cli`],
      remediation:
        'Build Brush (`git clone https://github.com/ArthurBrussee/brush ~/brush && ' +
        'cd ~/brush && cargo build --release -p brush-cli`) or set BRUSH_BIN to an existing brush-cli. ' +
        'Needs a Vulkan/Metal-capable GPU; see docs/pipelines/splat-train.md — Setup.',
      version: {
        args: ['--version'],
        parse: (out) => firstMatch(out, /brush-cli\s+(\S+)/),
      },
    },
    {
      id: 'spirula',
      label: 'Spirula Studio',
      kind: 'binary',
      usedBy: 'splat-train with SPLAT_BACKEND=spirula — the alternate trainer',
      envVar: 'SPIRULA_BIN',
      pathName: 'spirula',
      // Mirrors FALLBACK_SPIRULA_BINS, server/splat/spirula_train.ts:128.
      // Probed by name only; that module is under concurrent edit and is
      // deliberately not imported (see this file's header).
      fallbacks: [`${home}/opt/spirula/spirula`, `${home}/.local/bin/spirula`, '/usr/local/bin/spirula'],
      remediation:
        'Download a prebuilt Spirula Studio release (https://github.com/harry7557558/spirula-studio/releases — ' +
        'the ubuntu-vulkan-x86_64 zip), unzip it to ~/opt/spirula/spirula, and `chmod +x` it; ' +
        'or set SPIRULA_BIN to an existing binary. Optional — SPLAT_BACKEND=brush is the default.',
      version: {
        // `--version` prints a bare date-stamped version and nothing else
        // (measured: `2026.8.28`, exit 0), so the first non-empty line *is*
        // the version — no pattern to match against.
        args: ['--version'],
        parse: (stdout, stderr) => firstLine(`${stdout}\n${stderr}`),
      },
    },
    {
      id: 'panoptic-python',
      label: 'Panoptic venv interpreter',
      kind: 'python',
      usedBy: 'panoptic-scan — per-keyframe segmentation (Mask2Former)',
      envVar: 'PANOPTIC_PYTHON',
      // Mirrors DEFAULT_PANOPTIC_PYTHON, server/panoptic/panoptic_scan.ts:38.
      fallbacks: [`${home}/.venvs/panoptic/bin/python`],
      remediation: 'Create the venv and set PANOPTIC_PYTHON (see docs/pipelines/panoptic-scan.md — Setup).',
    },
    {
      id: 'panoptic-worker',
      label: 'Panoptic worker checkout',
      kind: 'dir',
      usedBy: 'panoptic-scan — holds panoptic_worker.py',
      envVar: 'PANOPTIC_DIR',
      // Mirrors DEFAULT_PANOPTIC_DIR, server/panoptic/panoptic_scan.ts:39.
      fallbacks: [`${home}/panoptic`],
      remediation: 'Install the worker and set PANOPTIC_DIR (see docs/pipelines/panoptic-scan.md — Setup).',
    },
    {
      id: 'splat-detect-python',
      label: 'splat_analyzer venv interpreter',
      kind: 'python',
      usedBy: 'splat-detect — object detection over a trained splat',
      envVar: 'SPLAT_DETECT_PYTHON',
      // Mirrors DEFAULT_DETECT_PYTHON, server/splat/splat_detect.ts:39.
      fallbacks: [`${home}/.venvs/splat-analyzer/bin/python`],
      remediation: 'Create the venv and set SPLAT_DETECT_PYTHON (see docs/splat-detect.md — Setup).',
    },
    {
      id: 'splat-detect-dir',
      label: 'splat_analyzer checkout',
      kind: 'dir',
      usedBy: 'splat-detect — holds run_local.py and pointcloud_to_gs.py',
      envVar: 'SPLAT_DETECT_DIR',
      // Mirrors DEFAULT_DETECT_DIR, server/splat/splat_detect.ts:40.
      fallbacks: [`${home}/splat_analyzer`],
      remediation: 'Clone splat_analyzer and set SPLAT_DETECT_DIR (see docs/splat-detect.md — Setup).',
    },
    {
      id: 'lingbot-map-python',
      label: 'LingBot-Map interpreter',
      kind: 'python',
      usedBy: 'lingbot-map-reconstruct — point clouds and poses from keyframes',
      envVar: 'LINGBOT_MAP_PYTHON',
      // lingbot_map.ts:115 defaults to the bare name, so PATH is the fallback
      // here rather than a venv — and that default is precisely why this row's
      // torch block matters (ADR 0007: the bare python3 has no torch).
      pathName: 'python3',
      fallbacks: [],
      remediation:
        'Point LINGBOT_MAP_PYTHON at an interpreter with torch installed ' +
        '(see README — `LingBot-Map server processing`).',
    },
    {
      id: 'lingbot-map-model',
      label: 'LingBot-Map checkpoint',
      kind: 'file',
      usedBy: 'lingbot-map-reconstruct — the model weights',
      envVar: 'LINGBOT_MAP_MODEL_PATH',
      // No documented default path: the runner passes '' and the worker skips.
      fallbacks: [],
      remediation: 'Download the checkpoint and set LINGBOT_MAP_MODEL_PATH (see README — `LingBot-Map server processing`).',
    },
  ]
}

// ── Probing ──────────────────────────────────────────────────────────────────

/** Result of one subprocess, or null when it could not be spawned at all. */
export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export interface CapabilityProbeOptions {
  platform?: ExecPlatform
  arch?: string
  denoVersion?: string
  env?: EnvReader
  home?: string
  /**
   * Run the version/torch/GPU subprocesses. Off makes the report pure
   * filesystem lookups — every `found` is still correct, only `version`,
   * `torch` and the GPU detail go missing.
   */
  versions?: boolean
  /** Per-subprocess budget. Nothing here should take a second; 10s is a hang. */
  timeoutMs?: number
  // Injection seams, in the style of colmap_poses.ts's `_spawn`.
  _isRunnable?: (bin: string, platform: ExecPlatform) => Promise<boolean>
  _whichPath?: (bin: string, platform: ExecPlatform) => Promise<string | null>
  _isDir?: (path: string) => Promise<boolean>
  _isFile?: (path: string) => Promise<boolean>
  /** Entry names of a directory, or [] when it cannot be read. Vulkan ICDs only. */
  _listDir?: (path: string) => Promise<string[]>
  _run?: (bin: string, args: string[]) => Promise<RunResult | null>
}

/**
 * Resolve one tool: env var, then PATH, then the documented install paths.
 *
 * The order is the runners' order and is load-bearing — an explicit env var is
 * taken at its word and only probed, exactly as `resolveColmapBin` does, so an
 * operator who names a binary is never quietly overridden by a fallback.
 * `searched` records every candidate whether it hit or not.
 */
export async function resolveTool(
  spec: ToolSpec,
  opts: Required<Pick<CapabilityProbeOptions, 'platform'>> & {
    env: EnvReader
    isRunnable: (bin: string, platform: ExecPlatform) => Promise<boolean>
    which: (bin: string, platform: ExecPlatform) => Promise<string | null>
    isDir: (path: string) => Promise<boolean>
    isFile: (path: string) => Promise<boolean>
  },
): Promise<{ found: boolean; path?: string; via?: ResolvedVia; searched: string[] }> {
  const searched: string[] = []
  const exists = async (candidate: string): Promise<boolean> => {
    searched.push(candidate)
    if (spec.kind === 'dir') return await opts.isDir(candidate)
    if (spec.kind === 'file') return await opts.isFile(candidate)
    return await opts.isRunnable(candidate, opts.platform)
  }

  const explicit = spec.envVar ? opts.env(spec.envVar) : undefined
  if (explicit) {
    return { found: await exists(explicit), path: explicit, via: 'env', searched }
  }

  if (spec.pathName && spec.kind !== 'dir' && spec.kind !== 'file') {
    searched.push(`PATH:${spec.pathName}`)
    const hit = await opts.which(spec.pathName, opts.platform)
    if (hit) return { found: true, path: hit, via: 'path', searched }
  }

  for (const candidate of spec.fallbacks) {
    if (await exists(candidate)) return { found: true, path: candidate, via: 'fallback', searched }
  }
  return { found: false, searched }
}

/**
 * The one-liner each python interpreter runs to describe its own torch.
 *
 * Kept to stdlib + torch and wrapped in a bare `except`, because a venv whose
 * torch is half-installed must produce a report, not a stack trace. Measured
 * cost on this box's panoptic venv with torch 2.13.0+cu130: 1.07s wall.
 */
export const TORCH_PROBE_SOURCE = [
  'import json, sys',
  'd = {"python": sys.version.split()[0], "torch": None}',
  'try:',
  '    import torch',
  '    d["torch"] = torch.__version__',
  '    d["cudaBuild"] = torch.version.cuda',
  '    d["hipBuild"] = torch.version.hip',
  '    d["cudaAvailable"] = bool(torch.cuda.is_available())',
  '    b = getattr(torch.backends, "mps", None)',
  '    d["mpsAvailable"] = bool(b and b.is_available())',
  'except Exception as e:',
  '    d["error"] = "%s: %s" % (type(e).__name__, e)',
  'print(json.dumps(d))',
].join('\n')

/**
 * Which backend an interpreter would actually compute on.
 *
 * The ROCm case is the whole reason this is a function. A ROCm torch reports
 * `torch.cuda.is_available() === true` and uses the device string "cuda" —
 * that is how ROCm ships, not a bug — so `cudaAvailable` alone mislabels an
 * AMD box as NVIDIA. `torch.version.hip` being non-null is the discriminator,
 * and it is checked first for that reason.
 */
export function deriveAccelerator(t: {
  cudaAvailable?: boolean
  hipBuild?: string | null
  mpsAvailable?: boolean
}): Accelerator {
  if (t.cudaAvailable && t.hipBuild) return 'rocm'
  if (t.cudaAvailable) return 'cuda'
  if (t.mpsAvailable) return 'mps'
  return 'cpu'
}

/** Parse the torch probe's stdout. A garbled line is "no torch", never a throw. */
export function parseTorchProbe(stdout: string): TorchReport {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(lastLine(stdout)) as Record<string, unknown>
  } catch {
    return { present: false, error: `unparseable torch probe output: ${firstLine(stdout) ?? '(empty)'}` }
  }
  const python = typeof raw.python === 'string' ? raw.python : undefined
  if (typeof raw.torch !== 'string') {
    return {
      present: false,
      ...(python ? { python } : {}),
      error: typeof raw.error === 'string' ? raw.error : 'torch import failed',
    }
  }
  const report: TorchReport = {
    present: true,
    version: raw.torch,
    cudaBuild: (raw.cudaBuild ?? null) as string | null,
    hipBuild: (raw.hipBuild ?? null) as string | null,
    cudaAvailable: raw.cudaAvailable === true,
    mpsAvailable: raw.mpsAvailable === true,
    ...(python ? { python } : {}),
  }
  report.accelerator = deriveAccelerator(report)
  return report
}

/**
 * Which stages can run end to end, derived from the tool rows.
 *
 * Pure, so the rollup is testable without a filesystem. `warnings` is the
 * "runs but not as you meant" band: a torch-less interpreter or a CPU-only box
 * is not a missing tool, and calling it `blocked` would be as wrong as calling
 * it ready.
 */
export function assessPipelines(
  tools: ToolCapability[],
  vulkan?: VulkanCapability,
): PipelineCapability[] {
  const byId = new Map(tools.map((t) => [t.id, t]))
  const found = (id: string) => byId.get(id)?.found === true
  const torchless = (id: string) => {
    const t = byId.get(id)
    return t?.found === true && t.torch !== undefined && !t.torch.present
  }
  // Only 'absent' and software-only enumeration warn. An 'inferred' Vulkan is
  // the ordinary state of a Linux box without vulkan-tools — a loader and a
  // driver manifest are there, nothing enumerated them — and turning that into
  // a warning on every such host would make this band mean nothing. The nuance
  // stays legible in `gpu.vulkan`.
  const vulkanWarnings = (who: string): string[] => {
    if (!vulkan) return []
    if (vulkan.status === 'absent') {
      return [
        `Vulkan ${vulkan.measured ? 'enumerated no device' : 'has no loader/ICD on this host'} — ` +
        `${who} is a wgpu program and will fail to start. ${vulkan.remediation ?? ''}`.trim(),
      ]
    }
    if (vulkan.softwareOnly) {
      return [`Vulkan enumerated only a software rasteriser — ${who} will train on the CPU, not the GPU.`]
    }
    return []
  }

  const stages: Array<{ id: string; label: string; requires: string[]; warn?: () => string[] }> = [
    {
      id: 'ingest-video',
      label: 'Upload Content (video / photos)',
      requires: ['ffmpeg', 'ffprobe'],
    },
    {
      id: 'colmap-poses',
      label: 'COLMAP pose solve (CPU)',
      requires: ['colmap'],
    },
    {
      id: 'splat-train',
      label: 'Splat training — Brush',
      requires: ['brush'],
      // Brush needs poses, and neither pose source is itself required: a
      // session captured with poses already has them.
      warn: () => [
        ...(found('colmap') || found('lingbot-map-python')
          ? []
          : ['No pose source installed — only sessions that arrive with poses can train.']),
        ...vulkanWarnings('Brush'),
      ],
    },
    {
      id: 'splat-train-spirula',
      label: 'Splat training — Spirula (optional backend)',
      requires: ['spirula'],
      warn: () => vulkanWarnings('Spirula'),
    },
    {
      id: 'panoptic-scan',
      label: 'Panoptic segmentation',
      requires: ['panoptic-python', 'panoptic-worker'],
      warn: () =>
        torchless('panoptic-python')
          ? ['PANOPTIC_PYTHON has no torch — the worker will fail on import.']
          : [],
    },
    {
      id: 'lingbot-map-reconstruct',
      label: 'LingBot-Map reconstruction',
      requires: ['lingbot-map-python', 'lingbot-map-model'],
      warn: () =>
        torchless('lingbot-map-python')
          ? ['LINGBOT_MAP_PYTHON has no torch — the worker skips with "torch import failed".']
          : [],
    },
    {
      id: 'splat-detect',
      label: 'Splat object detection',
      requires: ['splat-detect-python', 'splat-detect-dir'],
      warn: () =>
        torchless('splat-detect-python')
          ? ['SPLAT_DETECT_PYTHON has no torch — the analyzer will fail on import.']
          : [],
    },
  ]

  return stages.map((s) => {
    const missing = s.requires.filter((id) => !found(id))
    return {
      id: s.id,
      label: s.label,
      status: missing.length === 0 ? 'ready' : 'blocked',
      requires: s.requires,
      missing,
      warnings: s.warn ? s.warn() : [],
    }
  })
}

/**
 * Probe the host and return the report. Never throws.
 *
 * Every subprocess is optional and bounded: with `versions: false` this is
 * pure `stat` calls, which is the mode a hot HTTP route should use if the
 * report is ever wired into one.
 */
export async function probeCapabilities(opts: CapabilityProbeOptions = {}): Promise<CapabilityReport> {
  const platform = opts.platform ?? Deno.build.os
  const arch = opts.arch ?? Deno.build.arch
  const env: EnvReader = opts.env ?? ((name) => {
    try {
      return Deno.env.get(name)
    } catch {
      return undefined
    }
  })
  const home = opts.home ?? resolveHome(env)
  const timeoutMs = opts.timeoutMs ?? 10_000
  const wantVersions = opts.versions !== false
  const run = opts._run ?? ((bin, args) => runCapture(bin, args, timeoutMs))

  const deps = {
    platform,
    env,
    isRunnable: opts._isRunnable ?? isRunnable,
    which: opts._whichPath ?? ((bin: string, p: ExecPlatform) => whichPath(bin, { platform: p })),
    isDir: opts._isDir ?? ((p: string) => statKind(p, 'dir')),
    isFile: opts._isFile ?? ((p: string) => statKind(p, 'file')),
  }
  const listDir = opts._listDir ?? readDirNames

  const tools: ToolCapability[] = []
  for (const spec of toolSpecs(home)) {
    const resolved = await resolveTool(spec, deps)
    const tool: ToolCapability = {
      id: spec.id,
      label: spec.label,
      kind: spec.kind,
      usedBy: spec.usedBy,
      found: resolved.found,
      ...(resolved.path ? { path: resolved.path } : {}),
      ...(resolved.via ? { via: resolved.via } : {}),
      ...(spec.envVar ? { envVar: spec.envVar } : {}),
      searched: resolved.searched,
      ...(resolved.found ? {} : { remediation: spec.remediation }),
    }

    if (resolved.found && resolved.path && wantVersions) {
      if (spec.kind === 'python') {
        const out = await run(resolved.path, ['-c', TORCH_PROBE_SOURCE])
        tool.torch = out
          ? parseTorchProbe(out.stdout)
          : { present: false, error: `could not run ${resolved.path}` }
        if (tool.torch.python) tool.version = tool.torch.python
      } else if (spec.version) {
        const out = await run(resolved.path, spec.version.args)
        const v = out ? spec.version.parse(out.stdout, out.stderr) : null
        if (v) tool.version = v
      }
    }
    tools.push(tool)
  }

  const vulkan = await probeVulkan({
    platform,
    arch,
    home,
    env,
    run,
    which: deps.which,
    isFile: deps.isFile,
    listDir,
    wantVersions,
  })

  return {
    generatedAt: new Date().toISOString(),
    platform: { os: platform, arch, deno: opts.denoVersion ?? Deno.version.deno },
    tools,
    gpu: {
      detected: await probeGpu({ platform, arch, run, which: deps.which, wantVersions }),
      vulkan,
      note: GPU_NOTE,
    },
    // The two wgpu trainers' warnings need the Vulkan verdict, so it is probed
    // before the rollup rather than inline in the object above.
    pipelines: assessPipelines(tools, vulkan),
  }
}

/**
 * Vendor presence without torch, because the question "is there a GPU" must be
 * answerable on a box where no framework is installed yet — which is exactly
 * the box someone is trying to set up.
 *
 * Apple is the one vendor with no binary to probe: there is no `apple-smi`, and
 * every arm64 Mac has an integrated GPU, so `Deno.build` is the measurement.
 */
export async function probeGpu(opts: {
  platform: ExecPlatform
  arch: string
  run: (bin: string, args: string[]) => Promise<RunResult | null>
  which: (bin: string, platform: ExecPlatform) => Promise<string | null>
  wantVersions: boolean
}): Promise<GpuCapability[]> {
  const out: GpuCapability[] = []

  const nvidiaSmi = await opts.which('nvidia-smi', opts.platform)
  let nvidiaDetail: string | undefined
  if (nvidiaSmi && opts.wantVersions) {
    const r = await opts.run(nvidiaSmi, ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader'])
    // A present nvidia-smi that fails to query is a real state (a driver/library
    // version mismatch says exactly this), so keep the binary as detected and
    // let the detail carry the bad news.
    const line = r && r.code === 0 ? firstLine(r.stdout) : null
    nvidiaDetail = line ?? (r ? `nvidia-smi exited ${r.code}: ${firstLine(r.stderr) ?? 'no output'}` : undefined)
  }
  out.push({
    vendor: 'nvidia',
    detected: nvidiaSmi !== null,
    via: 'nvidia-smi',
    ...(nvidiaSmi ? { detail: nvidiaDetail ?? nvidiaSmi } : {}),
    ...(nvidiaSmi ? {} : {
      remediation: 'No nvidia-smi on PATH. Install the NVIDIA driver, or ignore this on a non-NVIDIA host.',
    }),
  })

  // rocminfo is the ROCm stack's own presence check; rocm-smi ships alongside
  // it and either one answering means the stack is installed.
  const rocm = (await opts.which('rocminfo', opts.platform)) ?? (await opts.which('rocm-smi', opts.platform))
  out.push({
    vendor: 'amd',
    detected: rocm !== null,
    via: rocm ? rocm.split(/[\\/]/).pop() ?? 'rocminfo' : 'rocminfo',
    ...(rocm ? { detail: rocm } : {}),
    ...(rocm ? {} : {
      remediation: 'No rocminfo/rocm-smi on PATH. Install ROCm, or ignore this on a non-AMD host.',
    }),
  })

  const apple = opts.platform === 'darwin' && opts.arch === 'aarch64'
  out.push({
    vendor: 'apple',
    detected: apple,
    via: 'Deno.build',
    ...(apple ? { detail: `Apple Silicon (${opts.platform}/${opts.arch}) — integrated GPU, Metal` } : {}),
    ...(apple ? {} : {
      remediation: 'Not an Apple Silicon host — nothing to install; Metal/MPS is unavailable here.',
    }),
  })

  return out
}

// ── Vulkan ───────────────────────────────────────────────────────────────────

/**
 * Where the Vulkan loader library lives, in the order the linker would find it.
 *
 * Deno's arch strings ('x86_64', 'aarch64') are exactly the prefix Debian's
 * multiarch triple uses, so the first candidate covers Ubuntu/Debian and the
 * next two cover the /usr/lib64 (Fedora/SUSE) and merged-/usr layouts. Measured
 * on this box: /usr/lib/x86_64-linux-gnu/libvulkan.so.1 → libvulkan.so.1.4.341.
 */
export function vulkanLoaderCandidates(platform: ExecPlatform, arch: string): string[] {
  if (platform === 'windows') return ['C:\\Windows\\System32\\vulkan-1.dll']
  return [
    `/usr/lib/${arch}-linux-gnu/libvulkan.so.1`,
    '/usr/lib64/libvulkan.so.1',
    '/usr/lib/libvulkan.so.1',
    '/usr/local/lib/libvulkan.so.1',
  ]
}

/**
 * The directories the Linux loader scans for ICD manifests, in its own order.
 *
 * Windows keeps its ICD registrations in the registry, not in files, so there
 * is nothing here to stat — which is why `probeVulkan` says so in `detail`
 * rather than reporting a Windows box as having no drivers.
 */
export function vulkanIcdDirs(platform: ExecPlatform, home: string): string[] {
  if (platform === 'windows') return []
  return [
    '/usr/local/etc/vulkan/icd.d',
    '/usr/local/share/vulkan/icd.d',
    '/etc/vulkan/icd.d',
    '/usr/share/vulkan/icd.d',
    `${home}/.local/share/vulkan/icd.d`,
  ]
}

/**
 * Pull device names out of `vulkaninfo --summary`.
 *
 * Two shapes, because the summary changed: current builds print a `deviceName =`
 * line per GPU under `Devices:`, older ones print `GPU id : 0 (Name)`. Both are
 * matched so an old vulkaninfo does not read as "enumerated nothing", which is
 * the one verdict that would be actively misleading.
 *
 * `deviceType` is read alongside because "a device enumerated" is not the same
 * claim as "a GPU enumerated" — measured on this box, three devices come back
 * and one of them is `PHYSICAL_DEVICE_TYPE_CPU` (llvmpipe). A host where that
 * is the *only* entry has working Vulkan and no usable trainer.
 */
export function parseVulkanSummary(stdout: string, stderr: string): {
  instanceVersion?: string
  devices: string[]
  /** True iff at least one device enumerated and every one of them is a CPU device. */
  softwareOnly?: boolean
} {
  const both = `${stdout}\n${stderr}`
  const devices: string[] = []
  for (const m of both.matchAll(/^\s*deviceName\s*=\s*(.+?)\s*$/gm)) devices.push(m[1])
  if (devices.length === 0) {
    for (const m of both.matchAll(/^\s*GPU\s*id\s*:\s*\d+\s*\((.+?)\)\s*$/gm)) devices.push(m[1])
  }
  const types = [...both.matchAll(/^\s*deviceType\s*=\s*(\S+)\s*$/gm)].map((m) => m[1])
  const version = firstMatch(both, /Vulkan Instance Version:\s*(\S+)/)
  return {
    ...(version ? { instanceVersion: version } : {}),
    devices,
    // Only claimed when every device reported a type: a partial parse must not
    // downgrade a real GPU to "software only".
    ...(devices.length > 0 && types.length === devices.length
      ? { softwareOnly: types.every((t) => t === 'PHYSICAL_DEVICE_TYPE_CPU') }
      : {}),
  }
}

/**
 * Is Vulkan actually there? — the question `GPU_NOTE` used to say nothing probed.
 *
 * Brush and Spirula are wgpu programs: on Linux they need a loader
 * (libvulkan.so.1), at least one ICD manifest pointing at a driver, and a
 * device that enumerates. Only the last of those three is decisive, and only
 * `vulkaninfo --summary` measures it — so this probe is deliberately two-tier
 * and says which tier it is in via `measured`. Measured on this box tonight:
 * loader present, nine ICD manifests including nvidia_icd.json, and *no*
 * vulkaninfo — i.e. the exact 'inferred' case, which must not be reported as a
 * yes (nothing proved a device enumerates) and must not be reported as a no
 * (Brush 1.0.0 trained the 37.5 MB fixture splat on this box).
 *
 * A missing vulkaninfo is a reportable state with a remediation, in the same
 * voice every optional-tool row here uses — never a crash, never a silent no.
 */
export async function probeVulkan(opts: {
  platform: ExecPlatform
  arch: string
  home: string
  env: EnvReader
  run: (bin: string, args: string[]) => Promise<RunResult | null>
  which: (bin: string, platform: ExecPlatform) => Promise<string | null>
  isFile: (path: string) => Promise<boolean>
  listDir: (path: string) => Promise<string[]>
  wantVersions: boolean
}): Promise<VulkanCapability> {
  if (opts.platform === 'darwin') {
    return {
      status: 'not-applicable',
      measured: false,
      via: 'Deno.build',
      devices: [],
      icdManifests: [],
      detail: 'macOS — wgpu targets Metal here, so Brush/Spirula need no Vulkan loader (MoltenVK is optional).',
    }
  }

  let loader: string | undefined
  for (const candidate of vulkanLoaderCandidates(opts.platform, opts.arch)) {
    if (await opts.isFile(candidate)) {
      loader = candidate
      break
    }
  }

  // VK_DRIVER_FILES (and its deprecated alias VK_ICD_FILENAMES) *replaces* the
  // directory scan in the loader rather than adding to it, so honouring it is
  // the difference between describing this host and describing a default host.
  const override = opts.env('VK_DRIVER_FILES') ?? opts.env('VK_ICD_FILENAMES')
  const icdManifests: string[] = []
  if (override) {
    for (const p of override.split(opts.platform === 'windows' ? ';' : ':')) {
      if (p !== '' && (await opts.isFile(p))) icdManifests.push(p)
    }
  } else {
    for (const dir of vulkanIcdDirs(opts.platform, opts.home)) {
      for (const name of await opts.listDir(dir)) {
        if (name.endsWith('.json')) icdManifests.push(`${dir}/${name}`)
      }
    }
  }

  const fsEvidence = {
    ...(loader ? { loader } : {}),
    icdManifests,
  }
  const inferredDetail = `loader ${loader ?? 'not found'}; ${icdManifests.length} ICD manifest(s)` +
    (override ? ' from VK_DRIVER_FILES/VK_ICD_FILENAMES' : '') +
    (opts.platform === 'windows' ? '; Windows registers ICDs in the registry, which is not probed here' : '')

  const vulkaninfo = await opts.which('vulkaninfo', opts.platform)
  if (vulkaninfo && opts.wantVersions) {
    const r = await opts.run(vulkaninfo, ['--summary'])
    if (r) {
      const parsed = parseVulkanSummary(r.stdout, r.stderr)
      if (parsed.devices.length > 0) {
        return {
          status: 'enumerated',
          measured: true,
          via: `${vulkaninfo} --summary`,
          devices: parsed.devices,
          ...(parsed.softwareOnly === undefined ? {} : { softwareOnly: parsed.softwareOnly }),
          ...(parsed.instanceVersion ? { instanceVersion: parsed.instanceVersion } : {}),
          ...fsEvidence,
          ...(parsed.softwareOnly
            ? {
              detail: 'Every enumerated device is a software rasteriser — Vulkan works, but there is no GPU behind it.',
              remediation:
                'Only llvmpipe/lavapipe enumerated. Brush and Spirula will run and train at CPU speed. ' +
                'Install your GPU vendor\'s Vulkan driver (NVIDIA proprietary, or `mesa-vulkan-drivers` for AMD/Intel) ' +
                'so a hardware device enumerates.',
            }
            : {}),
        }
      }
      // vulkaninfo ran and enumerated nothing. That is a measurement, and a
      // much worse one than "no vulkaninfo" — the loader is right there and no
      // driver answered it.
      return {
        status: 'absent',
        measured: true,
        via: `${vulkaninfo} --summary`,
        devices: [],
        ...(parsed.instanceVersion ? { instanceVersion: parsed.instanceVersion } : {}),
        ...fsEvidence,
        detail: `vulkaninfo exited ${r.code} and listed no devices: ${firstLine(r.stderr) ?? firstLine(r.stdout) ?? 'no output'}`,
        remediation:
          'Vulkan enumerated no device. Install your GPU vendor\'s Vulkan driver — the NVIDIA proprietary ' +
          'driver ships /usr/share/vulkan/icd.d/nvidia_icd.json, Mesa ships it as `mesa-vulkan-drivers` — ' +
          'then re-run. Brush and Spirula cannot train without an enumerable device.',
      }
    }
    // Present but unspawnable: report the inference and say why it stayed one.
    return {
      status: loader && icdManifests.length > 0 ? 'inferred' : 'absent',
      measured: false,
      via: 'filesystem (loader + ICD manifests)',
      devices: [],
      ...fsEvidence,
      detail: `${inferredDetail}; ${vulkaninfo} could not be run, so nothing enumerated`,
      remediation: `Reinstall vulkan-tools — ${vulkaninfo} exists but would not spawn, so this line is an inference, not a measurement.`,
    }
  }

  if (loader && icdManifests.length > 0) {
    return {
      status: 'inferred',
      measured: false,
      via: 'filesystem (loader + ICD manifests)',
      devices: [],
      ...fsEvidence,
      detail: inferredDetail + (vulkaninfo ? '' : '; no vulkaninfo on PATH, so no device enumeration was attempted'),
      remediation:
        'Install vulkan-tools (`apt install vulkan-tools` / `dnf install vulkan-tools`) and re-probe — ' +
        '`vulkaninfo --summary` is the only thing here that turns this inference into a measurement.',
    }
  }

  return {
    status: 'absent',
    measured: false,
    via: 'filesystem (loader + ICD manifests)',
    devices: [],
    ...fsEvidence,
    detail: inferredDetail,
    remediation:
      'No Vulkan loader and/or no ICD manifest found — Brush and Spirula (both wgpu) cannot run. ' +
      'Install the loader (`apt install libvulkan1`) and a driver (NVIDIA proprietary, or ' +
      '`mesa-vulkan-drivers`), plus `vulkan-tools` so this can be measured rather than inferred.',
  }
}

// ── Text rendering ───────────────────────────────────────────────────────────

/**
 * Human-readable rendering. Pure, so a test can assert that a missing tool's
 * remediation actually reaches the reader — the failure mode this whole module
 * exists to fix is a fact that was technically available and never surfaced.
 */
export function formatCapabilityReport(report: CapabilityReport): string {
  const lines: string[] = []
  lines.push(`platform  ${report.platform.os}/${report.platform.arch}  deno ${report.platform.deno}`)
  lines.push(`probed    ${report.generatedAt}`)
  lines.push('')
  lines.push('TOOLS')
  for (const t of report.tools) {
    const mark = t.found ? 'ok     ' : 'MISSING'
    const where = t.found ? `${t.path}${t.via ? `  (${t.via})` : ''}` : `(looked in: ${t.searched.join(', ') || 'nowhere — no candidate paths'})`
    lines.push(`  ${mark} ${t.id.padEnd(20)} ${t.version ? `${t.version}  ` : ''}${where}`)
    if (t.torch) {
      lines.push(
        `          torch: ${
          t.torch.present
            ? `${t.torch.version} → ${t.torch.accelerator}` +
              (t.torch.hipBuild ? ` (hip ${t.torch.hipBuild})` : '') +
              (t.torch.cudaBuild ? ` (cuda ${t.torch.cudaBuild})` : '')
            : `absent — ${t.torch.error ?? 'no detail'}`
        }`,
      )
    }
    if (t.remediation) lines.push(`          fix: ${t.remediation}`)
  }
  lines.push('')
  lines.push('GPU (driver presence only)')
  for (const g of report.gpu.detected) {
    lines.push(`  ${g.detected ? 'detected' : 'none    '} ${g.vendor.padEnd(8)} ${g.detail ?? g.remediation ?? ''}`)
  }
  const v = report.gpu.vulkan
  lines.push(
    `  vulkan   ${v.status.padEnd(14)} ${v.measured ? '(measured)' : '(not measured)'}  ${
      v.devices.length > 0 ? v.devices.join(', ') : v.detail ?? ''
    }`,
  )
  if (v.icdManifests.length > 0) lines.push(`          icd: ${v.icdManifests.join(', ')}`)
  if (v.remediation) lines.push(`          fix: ${v.remediation}`)
  lines.push(`  note: ${report.gpu.note}`)
  lines.push('')
  lines.push('PIPELINES')
  for (const p of report.pipelines) {
    lines.push(`  ${p.status === 'ready' ? 'READY  ' : 'BLOCKED'} ${p.id.padEnd(24)} ${p.status === 'ready' ? '' : `missing: ${p.missing.join(', ')}`}`)
    for (const w of p.warnings) lines.push(`          warn: ${w}`)
  }
  return lines.join('\n')
}

// ── Primitives ───────────────────────────────────────────────────────────────

/**
 * Bounded subprocess capture. Returns null when the binary cannot be spawned.
 *
 * The timeout is not decoration: this report is meant to be safe to call from
 * a health route, and a tool that blocks on a device or opens a window would
 * otherwise hang the request forever.
 */
export async function runCapture(bin: string, args: string[], timeoutMs: number): Promise<RunResult | null> {
  let child: Deno.ChildProcess
  try {
    child = new Deno.Command(bin, { args, stdout: 'piped', stderr: 'piped' }).spawn()
  } catch {
    return null
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      child.kill('SIGKILL')
    } catch {
      // Already exited between the timer firing and this line.
    }
  }, timeoutMs)
  try {
    const out = await child.output()
    const dec = new TextDecoder()
    return {
      code: out.code,
      stdout: dec.decode(out.stdout),
      stderr: timedOut ? `timed out after ${timeoutMs}ms` : dec.decode(out.stderr),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Entry names of a directory, or [] when it cannot be read.
 *
 * Symlinks count: a distro that ships /usr/share/vulkan/icd.d entries as links
 * into a driver package would otherwise look like a host with no drivers.
 */
async function readDirNames(path: string): Promise<string[]> {
  const names: string[] = []
  try {
    for await (const entry of Deno.readDir(path)) {
      if (entry.isFile || entry.isSymlink) names.push(entry.name)
    }
  } catch {
    return []
  }
  return names.sort()
}

async function statKind(path: string, want: 'dir' | 'file'): Promise<boolean> {
  try {
    const info = await Deno.stat(path)
    return want === 'dir' ? info.isDirectory : info.isFile
  } catch {
    return false
  }
}

function firstMatch(text: string, re: RegExp): string | null {
  const m = re.exec(text)
  return m ? m[1] : null
}

function firstLine(text: string): string | null {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '')
  return line ?? null
}

function lastLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  return lines.length > 0 ? lines[lines.length - 1] : ''
}

if (import.meta.main) {
  const json = Deno.args.includes('--json')
  const fast = Deno.args.includes('--no-versions')
  const report = await probeCapabilities({ versions: !fast })
  console.log(json ? JSON.stringify(report, null, 2) : formatCapabilityReport(report))
  // A blocked pipeline is information, not a failure of the probe — exit 0 so
  // this is safe in a setup script that just wants the table printed.
}
