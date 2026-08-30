/**
 * Tests for capabilities.ts and exec_probe.ts's whichPath().
 *
 * The failure these pin is a false negative, not a crash: on 2026-08-30 COLMAP
 * 3.13.0 was installed at `~/.local/micromamba/envs/colmap/bin/colmap` the
 * whole time while `which colmap` said no, and hours went into chasing a
 * dependency that was already there. So the assertions below are mostly about
 * *where* the probe looked and what it reported, not merely whether it said
 * yes — a report that answers "missing" without saying where it looked
 * reproduces the original problem in a nicer format.
 *
 * Everything runs against injected filesystem/env/subprocess seams, so the
 * whole suite means the same thing on a Windows laptop as in Linux CI — the
 * same reason exec_probe.ts takes an ExecPlatform at all.
 */
import { assert } from 'jsr:@std/assert@^1.0.0/assert'
import { assertEquals } from 'jsr:@std/assert@^1.0.0/equals'
import { assertStringIncludes } from 'jsr:@std/assert@^1.0.0/string-includes'

import { whichPath, type ExecPlatform } from '../../../server/exec_probe.ts'
import {
  assessPipelines,
  deriveAccelerator,
  formatCapabilityReport,
  parseTorchProbe,
  parseVulkanSummary,
  probeCapabilities,
  resolveHome,
  runCapture,
  toolSpecs,
  TORCH_PROBE_SOURCE,
  vulkanIcdDirs,
  vulkanLoaderCandidates,
  type CapabilityProbeOptions,
  type RunResult,
  type ToolCapability,
} from '../../../server/capabilities.ts'

/** A filesystem stand-in: only these exact paths exist. */
function fakeFs(present: string[]) {
  const set = new Set(present)
  return (p: string) => Promise.resolve(set.has(p))
}

// ── whichPath ────────────────────────────────────────────────────────────────

Deno.test('whichPath: returns the resolved absolute path, not a boolean', async () => {
  const hit = await whichPath('colmap', {
    platform: 'linux',
    path: '/usr/local/bin:/usr/bin',
    _isRunnable: fakeFs(['/usr/bin/colmap']),
  })
  assertEquals(hit, '/usr/bin/colmap')
})

Deno.test('whichPath: honours PATH order, first hit wins', async () => {
  const hit = await whichPath('ffmpeg', {
    platform: 'linux',
    path: '/home/x/.local/bin:/usr/bin',
    _isRunnable: fakeFs(['/home/x/.local/bin/ffmpeg', '/usr/bin/ffmpeg']),
  })
  assertEquals(hit, '/home/x/.local/bin/ffmpeg')
})

Deno.test('whichPath: the micromamba case — installed but not on PATH — is null', async () => {
  // The exact 2026-08-30 state. whichPath must say null here so that the
  // fallback list, not PATH, is what finds COLMAP.
  const hit = await whichPath('colmap', {
    platform: 'linux',
    path: '/usr/local/bin:/usr/bin',
    _isRunnable: fakeFs(['/home/liam/.local/micromamba/envs/colmap/bin/colmap']),
  })
  assertEquals(hit, null)
})

Deno.test('whichPath: an empty PATH entry is never treated as the cwd', async () => {
  // A POSIX shell would run ./colmap here. A capability report must not, or it
  // reports a resolution that depends on where the server was started.
  const hit = await whichPath('colmap', {
    platform: 'linux',
    path: ':/usr/bin',
    _isRunnable: fakeFs(['/colmap', 'colmap']),
  })
  assertEquals(hit, null)
})

Deno.test('whichPath: a name with a separator is a path, not a PATH lookup', async () => {
  const seen: string[] = []
  const hit = await whichPath('/opt/spirula/spirula', {
    platform: 'linux',
    path: '/usr/bin',
    _isRunnable: (p) => {
      seen.push(p)
      return Promise.resolve(p === '/opt/spirula/spirula')
    },
  })
  assertEquals(hit, '/opt/spirula/spirula')
  assertEquals(seen, ['/opt/spirula/spirula'])
})

Deno.test('whichPath (windows): appends PATHEXT and uses the ; separator', async () => {
  const hit = await whichPath('colmap', {
    platform: 'windows',
    path: 'C:\\tools;C:\\Windows',
    pathExt: '.COM;.EXE;.BAT',
    _isRunnable: fakeFs(['C:\\tools\\colmap.EXE']),
  })
  assertEquals(hit, 'C:\\tools\\colmap.EXE')
})

Deno.test('whichPath (windows): a PATHEXT hit beats an extensionless sibling', async () => {
  // isRunnable on Windows can only ask "is this a regular file", so a stray
  // extensionless `colmap` would win and then fail to launch. Extensions first.
  const hit = await whichPath('colmap', {
    platform: 'windows',
    path: 'C:\\tools',
    pathExt: '.EXE',
    _isRunnable: fakeFs(['C:\\tools\\colmap', 'C:\\tools\\colmap.EXE']),
  })
  assertEquals(hit, 'C:\\tools\\colmap.EXE')
})

Deno.test('whichPath (windows): a name that already has an extension is used as-is', async () => {
  const hit = await whichPath('python.exe', {
    platform: 'windows',
    path: 'C:\\Python',
    pathExt: '.EXE',
    _isRunnable: fakeFs(['C:\\Python\\python.exe']),
  })
  assertEquals(hit, 'C:\\Python\\python.exe')
})

// ── Resolution order ─────────────────────────────────────────────────────────

/** probeCapabilities with every seam faked and no subprocesses. */
function probe(
  opts: {
    present?: string[]
    env?: Record<string, string>
    path?: string
    platform?: ExecPlatform
    arch?: string
    /** Directory listings the Vulkan ICD scan sees. Absent dirs list empty. */
    dirs?: Record<string, string[]>
    run?: (bin: string, args: string[]) => Promise<RunResult | null>
  } = {},
) {
  const present = new Set(opts.present ?? [])
  const pathDirs = (opts.path ?? '').split(':').filter((d) => d !== '')
  const base: CapabilityProbeOptions = {
    platform: opts.platform ?? 'linux',
    arch: opts.arch ?? 'x86_64',
    denoVersion: '0.0.0-test',
    home: '/home/t',
    env: (name) => opts.env?.[name],
    versions: opts.run !== undefined,
    _isRunnable: (p) => Promise.resolve(present.has(p)),
    _isDir: (p) => Promise.resolve(present.has(p)),
    _isFile: (p) => Promise.resolve(present.has(p)),
    // Defaulted to empty rather than left to the real Deno.readDir: without
    // this every "nothing is installed" case below would still see this box's
    // own /usr/share/vulkan/icd.d and stop meaning what it says.
    _listDir: (p) => Promise.resolve(opts.dirs?.[p] ?? []),
    _whichPath: (bin) => {
      for (const d of pathDirs) if (present.has(`${d}/${bin}`)) return Promise.resolve(`${d}/${bin}`)
      return Promise.resolve(null)
    },
    _run: opts.run ?? (() => Promise.resolve(null)),
  }
  return probeCapabilities(base)
}

function tool(report: { tools: ToolCapability[] }, id: string): ToolCapability {
  const t = report.tools.find((x) => x.id === id)
  assert(t, `no tool row for ${id}`)
  return t
}

Deno.test('resolution: the documented micromamba path is found when PATH has nothing', async () => {
  // The whole point of the module, as one assertion.
  const report = await probe({ present: ['/home/t/.local/micromamba/envs/colmap/bin/colmap'], path: '/usr/bin' })
  const colmap = tool(report, 'colmap')
  assertEquals(colmap.found, true)
  assertEquals(colmap.via, 'fallback')
  assertEquals(colmap.path, '/home/t/.local/micromamba/envs/colmap/bin/colmap')
})

Deno.test('resolution: an explicit env var wins over PATH and over the fallback', async () => {
  const report = await probe({
    present: ['/opt/colmap/bin/colmap', '/usr/bin/colmap', '/home/t/.local/micromamba/envs/colmap/bin/colmap'],
    path: '/usr/bin',
    env: { COLMAP_BIN: '/opt/colmap/bin/colmap' },
  })
  const colmap = tool(report, 'colmap')
  assertEquals(colmap.via, 'env')
  assertEquals(colmap.path, '/opt/colmap/bin/colmap')
})

Deno.test('resolution: an env var pointing at nothing is reported missing, not silently replaced', async () => {
  // If a bad COLMAP_BIN quietly fell through to the fallback, the operator
  // would never learn their override is wrong — and the runners do not fall
  // through either (resolveColmapBin probes an explicit binary and stops).
  const report = await probe({
    present: ['/home/t/.local/micromamba/envs/colmap/bin/colmap'],
    env: { COLMAP_BIN: '/typo/colmap' },
  })
  const colmap = tool(report, 'colmap')
  assertEquals(colmap.found, false)
  assertEquals(colmap.path, '/typo/colmap')
  assert(colmap.remediation)
})

Deno.test('resolution: every missing tool carries a remediation, every found one carries none', async () => {
  const report = await probe({ present: ['/usr/bin/ffmpeg'], path: '/usr/bin' })
  for (const t of report.tools) {
    assertEquals(
      t.remediation !== undefined,
      !t.found,
      `${t.id}: remediation presence must track found`,
    )
    if (!t.found) assert(t.remediation!.length > 20, `${t.id}: remediation is not actionable`)
  }
})

Deno.test('resolution: searched lists every candidate, so a false negative is debuggable', async () => {
  const report = await probe({ path: '/usr/bin' })
  const colmap = tool(report, 'colmap')
  assertEquals(colmap.found, false)
  assertEquals(colmap.searched, ['PATH:colmap', '/home/t/.local/micromamba/envs/colmap/bin/colmap'])
})

Deno.test('resolution: no tool spec invents an env var the runners do not read', async () => {
  // ADR 0001: reuse the existing option, never a parallel one. This list is
  // every variable already read by a runner or documented in .env.example.
  const known = new Set([
    'COLMAP_BIN',
    'BRUSH_BIN',
    'SPIRULA_BIN',
    'PANOPTIC_PYTHON',
    'PANOPTIC_DIR',
    'SPLAT_DETECT_PYTHON',
    'SPLAT_DETECT_DIR',
    'LINGBOT_MAP_PYTHON',
    'LINGBOT_MAP_MODEL_PATH',
  ])
  for (const spec of toolSpecs('/home/t')) {
    if (spec.envVar) assert(known.has(spec.envVar), `${spec.id} introduces unknown env var ${spec.envVar}`)
  }
})

Deno.test('resolution: a directory spec is checked as a directory, not as an executable', async () => {
  // panoptic-worker is a checkout, and a file at that path is not one.
  const report = await probeCapabilities({
    platform: 'linux',
    arch: 'x86_64',
    denoVersion: '0.0.0-test',
    home: '/home/t',
    env: () => undefined,
    versions: false,
    _isRunnable: () => Promise.resolve(true), // everything is "executable"
    _isDir: () => Promise.resolve(false), // but nothing is a directory
    _isFile: () => Promise.resolve(false),
    _whichPath: () => Promise.resolve(null),
    _run: () => Promise.resolve(null),
  })
  assertEquals(tool(report, 'panoptic-worker').found, false)
})

// ── torch ────────────────────────────────────────────────────────────────────

Deno.test('deriveAccelerator: a ROCm torch is rocm, not cuda', async () => {
  // ROCm torch reports cuda.is_available() === true and a "cuda" device
  // string. torch.version.hip is the only discriminator; getting this wrong
  // labels an AMD box NVIDIA.
  assertEquals(deriveAccelerator({ cudaAvailable: true, hipBuild: '6.2.41134-0' }), 'rocm')
  assertEquals(deriveAccelerator({ cudaAvailable: true, hipBuild: null }), 'cuda')
  assertEquals(deriveAccelerator({ cudaAvailable: false, mpsAvailable: true }), 'mps')
  assertEquals(deriveAccelerator({ cudaAvailable: false, mpsAvailable: false }), 'cpu')
  await Promise.resolve()
})

Deno.test('parseTorchProbe: a real CUDA payload', () => {
  const t = parseTorchProbe(JSON.stringify({
    python: '3.12.3',
    torch: '2.13.0+cu130',
    cudaBuild: '13.0',
    hipBuild: null,
    cudaAvailable: true,
    mpsAvailable: false,
  }))
  assertEquals(t.present, true)
  assertEquals(t.accelerator, 'cuda')
  assertEquals(t.python, '3.12.3')
})

Deno.test('parseTorchProbe: an interpreter without torch reports the import error verbatim', () => {
  const t = parseTorchProbe(JSON.stringify({
    python: '3.14.4',
    torch: null,
    error: "ModuleNotFoundError: No module named 'torch'",
  }))
  assertEquals(t.present, false)
  assertEquals(t.python, '3.14.4')
  assertStringIncludes(t.error!, 'No module named')
})

Deno.test('parseTorchProbe: garbage is "no torch", never a throw', () => {
  const t = parseTorchProbe('Traceback (most recent call last):\n  ImportError: libcudart.so.12\n')
  assertEquals(t.present, false)
  assert(t.error)
})

Deno.test('parseTorchProbe: warnings printed before the payload do not break it', () => {
  // Venvs routinely print deprecation noise on import; the payload is the
  // last line, which is why lastLine() and not firstLine() parses it.
  const t = parseTorchProbe(`UserWarning: something\n${JSON.stringify({ python: '3.12.3', torch: '2.13.0' })}\n`)
  assertEquals(t.present, true)
  assertEquals(t.version, '2.13.0')
})

Deno.test('torch: the probe source is what actually runs, and it runs', async () => {
  // Guards the one-liner against a syntax error, using the host's own python
  // if there is one. Skips rather than fails where python3 is absent — a box
  // without python is a legitimate host for the rest of this report.
  const out = await runCapture('python3', ['-c', TORCH_PROBE_SOURCE], 30_000)
  if (out === null) return
  assertEquals(out.code, 0, `probe source failed: ${out.stderr}`)
  const t = parseTorchProbe(out.stdout)
  assert(t.python, 'the probe must always report an interpreter version')
})

// ── Pipeline rollup ──────────────────────────────────────────────────────────

function row(id: string, found: boolean, torch?: { present: boolean }): ToolCapability {
  return {
    id,
    label: id,
    kind: 'binary',
    usedBy: '',
    found,
    searched: [],
    ...(torch ? { torch } : {}),
  }
}

Deno.test('pipelines: a stage is ready only when every requirement is present', () => {
  const ready = assessPipelines([row('ffmpeg', true), row('ffprobe', true)])
    .find((p) => p.id === 'ingest-video')!
  assertEquals(ready.status, 'ready')
  assertEquals(ready.missing, [])

  const half = assessPipelines([row('ffmpeg', true), row('ffprobe', false)])
    .find((p) => p.id === 'ingest-video')!
  // The exact shape of the original failure: ingest-video.mjs guards on ffmpeg
  // and then calls ffprobe, so "ffmpeg is installed" is not the question.
  assertEquals(half.status, 'blocked')
  assertEquals(half.missing, ['ffprobe'])
})

Deno.test('pipelines: a torch-less interpreter warns, it does not block', () => {
  const p = assessPipelines([
    row('lingbot-map-python', true, { present: false }),
    row('lingbot-map-model', true),
  ]).find((x) => x.id === 'lingbot-map-reconstruct')!
  assertEquals(p.status, 'ready')
  assertEquals(p.missing, [])
  assertEquals(p.warnings.length, 1)
  assertStringIncludes(p.warnings[0], 'torch')
})

Deno.test('pipelines: Brush with no pose source is ready-with-a-warning', () => {
  // A session that arrives with poses trains fine, so a missing COLMAP is not
  // a blocker for splat-train — but it is the difference between "some
  // captures work" and "all captures work", and must be said.
  const warned = assessPipelines([row('brush', true)]).find((p) => p.id === 'splat-train')!
  assertEquals(warned.status, 'ready')
  assertEquals(warned.warnings.length, 1)

  const quiet = assessPipelines([row('brush', true), row('colmap', true)])
    .find((p) => p.id === 'splat-train')!
  assertEquals(quiet.warnings, [])
})

Deno.test('pipelines: an unknown-torch interpreter (versions off) does not warn', () => {
  // Absence of measurement is not a measurement of absence.
  const p = assessPipelines([row('panoptic-python', true), row('panoptic-worker', true)])
    .find((x) => x.id === 'panoptic-scan')!
  assertEquals(p.warnings, [])
})

// ── GPU ──────────────────────────────────────────────────────────────────────

Deno.test('gpu: nvidia-smi on PATH is detected, and the detail is what it printed', async () => {
  const report = await probe({
    present: ['/usr/bin/nvidia-smi'],
    path: '/usr/bin',
    run: (bin) =>
      Promise.resolve(
        bin === '/usr/bin/nvidia-smi'
          ? { code: 0, stdout: 'NVIDIA GeForce RTX 4080 Laptop GPU, 610.57.04, 12282 MiB\n', stderr: '' }
          : null,
      ),
  })
  const nvidia = report.gpu.detected.find((g) => g.vendor === 'nvidia')!
  assertEquals(nvidia.detected, true)
  assertStringIncludes(nvidia.detail!, 'RTX 4080')
  assertEquals(nvidia.remediation, undefined)
})

Deno.test('gpu: a present nvidia-smi that fails to query stays detected, with the failure as detail', async () => {
  // A driver/library mismatch is a real, distinct state — "no GPU" would be
  // the wrong report and would send the operator to install a driver they have.
  const report = await probe({
    present: ['/usr/bin/nvidia-smi'],
    path: '/usr/bin',
    run: () => Promise.resolve({ code: 9, stdout: '', stderr: 'Failed to initialize NVML: Driver/library version mismatch\n' }),
  })
  const nvidia = report.gpu.detected.find((g) => g.vendor === 'nvidia')!
  assertEquals(nvidia.detected, true)
  assertStringIncludes(nvidia.detail!, 'NVML')
})

Deno.test('gpu: rocminfo is what makes AMD detected', async () => {
  const report = await probe({ present: ['/opt/rocm/bin/rocminfo'], path: '/opt/rocm/bin' })
  const amd = report.gpu.detected.find((g) => g.vendor === 'amd')!
  assertEquals(amd.detected, true)
  assertEquals(amd.via, 'rocminfo')
})

Deno.test('gpu: Apple Silicon is a Deno.build fact, and Intel Macs are not it', async () => {
  const arm = await probe({ platform: 'darwin', arch: 'aarch64' })
  assertEquals(arm.gpu.detected.find((g) => g.vendor === 'apple')!.detected, true)

  const intel = await probe({ platform: 'darwin', arch: 'x86_64' })
  assertEquals(intel.gpu.detected.find((g) => g.vendor === 'apple')!.detected, false)
})

Deno.test('gpu: the note never claims a detected driver works', async () => {
  const report = await probe({ present: ['/usr/bin/nvidia-smi'], path: '/usr/bin' })
  assertStringIncludes(report.gpu.note, 'not proof')
  for (const g of report.gpu.detected) {
    assertEquals(Object.hasOwn(g, 'working'), false, 'the report must not claim a GPU is "working"')
  }
})

// ── Vulkan ───────────────────────────────────────────────────────────────────

/**
 * Verbatim `vulkaninfo --summary` from this box on 2026-08-29, trimmed to the
 * Devices block. Kept real on purpose: the two things the parser has to get
 * right — the `deviceName =` shape and the fact that a CPU device sits in the
 * same list as two real GPUs — are both properties of the actual output, and a
 * hand-written fixture would have quietly dropped the llvmpipe entry.
 */
const REAL_VULKANINFO_SUMMARY = `==========
VULKANINFO
==========

Vulkan Instance Version: 1.4.341

Devices:
========
GPU0:
\tapiVersion         = 1.4.335
\tvendorID           = 0x8086
\tdeviceType         = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU
\tdeviceName         = Intel(R) Graphics (RPL-S)
GPU1:
\tapiVersion         = 1.4.341
\tvendorID           = 0x10de
\tdeviceType         = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU
\tdeviceName         = NVIDIA GeForce RTX 4080 Laptop GPU
GPU2:
\tapiVersion         = 1.4.335
\tvendorID           = 0x10005
\tdeviceType         = PHYSICAL_DEVICE_TYPE_CPU
\tdeviceName         = llvmpipe (LLVM 21.1.8, 256 bits)
`

/** The loader warnings vulkaninfo really prints on this host, on stderr. */
const REAL_VULKANINFO_STDERR =
  'WARNING: [Loader Message] Code 0 : ICD for selected physical device does not export vkGetPhysicalDeviceDisplayPlanePropertiesKHR!\n'

const LINUX_LOADER = '/usr/lib/x86_64-linux-gnu/libvulkan.so.1'
const NVIDIA_ICD = { '/usr/share/vulkan/icd.d': ['nvidia_icd.json'] }

Deno.test('vulkan: a real --summary parses to its device names and instance version', () => {
  const parsed = parseVulkanSummary(REAL_VULKANINFO_SUMMARY, REAL_VULKANINFO_STDERR)
  assertEquals(parsed.instanceVersion, '1.4.341')
  assertEquals(parsed.devices, [
    'Intel(R) Graphics (RPL-S)',
    'NVIDIA GeForce RTX 4080 Laptop GPU',
    'llvmpipe (LLVM 21.1.8, 256 bits)',
  ])
  // A real GPU is in the list, so this host is not software-only.
  assertEquals(parsed.softwareOnly, false)
})

Deno.test('vulkan: an older summary that prints "GPU id : N (Name)" still enumerates', () => {
  const parsed = parseVulkanSummary('GPU id : 0 (NVIDIA GeForce RTX 4080 Laptop GPU)\n', '')
  assertEquals(parsed.devices, ['NVIDIA GeForce RTX 4080 Laptop GPU'])
  // No deviceType lines to read, so no claim is made either way.
  assertEquals(parsed.softwareOnly, undefined)
})

Deno.test('vulkan: enumerating a device is the one measured verdict', async () => {
  const report = await probe({
    present: ['/usr/bin/vulkaninfo', LINUX_LOADER],
    path: '/usr/bin',
    dirs: NVIDIA_ICD,
    run: (bin) =>
      Promise.resolve(
        bin === '/usr/bin/vulkaninfo'
          ? { code: 0, stdout: REAL_VULKANINFO_SUMMARY, stderr: REAL_VULKANINFO_STDERR }
          : null,
      ),
  })
  const v = report.gpu.vulkan
  assertEquals(v.status, 'enumerated')
  assertEquals(v.measured, true)
  assertEquals(v.remediation, undefined)
  assertStringIncludes(v.devices.join(', '), 'RTX 4080')
  assertEquals(v.loader, LINUX_LOADER)
  assertEquals(v.icdManifests, ['/usr/share/vulkan/icd.d/nvidia_icd.json'])
})

Deno.test('vulkan: no vulkaninfo is an inference with a remediation, not a silent no', async () => {
  // The measured state of this box on 2026-08-29: loader and nine ICD
  // manifests present, vulkan-tools absent — and Brush trains here. Reporting
  // that as "no Vulkan" would send an operator to fix a working machine.
  const report = await probe({ present: [LINUX_LOADER], path: '/usr/bin', dirs: NVIDIA_ICD })
  const v = report.gpu.vulkan
  assertEquals(v.status, 'inferred')
  assertEquals(v.measured, false)
  assertEquals(v.devices, [])
  assertStringIncludes(v.detail!, 'no vulkaninfo on PATH')
  assertStringIncludes(v.remediation!, 'vulkan-tools')
})

Deno.test('vulkan: an inferred Vulkan does not warn the wgpu pipelines', async () => {
  const report = await probe({
    present: [LINUX_LOADER, '/home/t/brush/target/release/brush-cli'],
    path: '/usr/bin',
    dirs: NVIDIA_ICD,
  })
  const brush = report.pipelines.find((p) => p.id === 'splat-train')!
  assertEquals(brush.status, 'ready')
  assertEquals(brush.warnings.some((w) => w.includes('Vulkan')), false)
})

Deno.test('vulkan: vulkaninfo enumerating nothing is a measured "absent", and it warns Brush', async () => {
  const report = await probe({
    present: ['/usr/bin/vulkaninfo', LINUX_LOADER, '/home/t/brush/target/release/brush-cli'],
    path: '/usr/bin',
    dirs: NVIDIA_ICD,
    run: () => Promise.resolve({ code: 1, stdout: '', stderr: 'ERROR_INITIALIZATION_FAILED\n' }),
  })
  const v = report.gpu.vulkan
  assertEquals(v.status, 'absent')
  assertEquals(v.measured, true)
  assertStringIncludes(v.detail!, 'ERROR_INITIALIZATION_FAILED')
  const brush = report.pipelines.find((p) => p.id === 'splat-train')!
  // Brush is installed, so the stage is not blocked — but it will not start.
  assertEquals(brush.status, 'ready')
  assertStringIncludes(brush.warnings.join(' '), 'wgpu program and will fail to start')
})

Deno.test('vulkan: a software-only enumeration is not reported as a working GPU', async () => {
  const llvmpipeOnly = `Vulkan Instance Version: 1.4.341

Devices:
========
GPU0:
\tdeviceType         = PHYSICAL_DEVICE_TYPE_CPU
\tdeviceName         = llvmpipe (LLVM 21.1.8, 256 bits)
`
  const report = await probe({
    present: ['/usr/bin/vulkaninfo', LINUX_LOADER, '/home/t/brush/target/release/brush-cli'],
    path: '/usr/bin',
    dirs: NVIDIA_ICD,
    run: () => Promise.resolve({ code: 0, stdout: llvmpipeOnly, stderr: '' }),
  })
  const v = report.gpu.vulkan
  assertEquals(v.status, 'enumerated')
  assertEquals(v.softwareOnly, true)
  assertStringIncludes(v.remediation!, 'llvmpipe')
  const brush = report.pipelines.find((p) => p.id === 'splat-train')!
  assertStringIncludes(brush.warnings.join(' '), 'CPU, not the GPU')
})

Deno.test('vulkan: nothing installed at all is absent with an install remediation', async () => {
  const report = await probe({ path: '/usr/bin' })
  const v = report.gpu.vulkan
  assertEquals(v.status, 'absent')
  assertEquals(v.measured, false)
  assertEquals(v.loader, undefined)
  assertEquals(v.icdManifests, [])
  assertStringIncludes(v.remediation!, 'libvulkan1')
})

Deno.test('vulkan: VK_DRIVER_FILES replaces the directory scan, as the loader does', async () => {
  // The loader ignores /usr/share/vulkan/icd.d entirely when this is set, so a
  // report that added the two together would describe a host that isn't this one.
  const report = await probe({
    present: [LINUX_LOADER, '/opt/icd/mine.json'],
    path: '/usr/bin',
    dirs: NVIDIA_ICD,
    env: { VK_DRIVER_FILES: '/opt/icd/mine.json' },
  })
  assertEquals(report.gpu.vulkan.icdManifests, ['/opt/icd/mine.json'])
  assertStringIncludes(report.gpu.vulkan.detail!, 'VK_DRIVER_FILES')
})

Deno.test('vulkan: macOS is not-applicable, not "absent" — wgpu targets Metal there', async () => {
  const report = await probe({ platform: 'darwin', arch: 'aarch64' })
  const v = report.gpu.vulkan
  assertEquals(v.status, 'not-applicable')
  assertEquals(v.remediation, undefined)
  assertStringIncludes(v.detail!, 'Metal')
  // And it must not drag a warning into the trainers on a Mac.
  assertEquals(report.pipelines.find((p) => p.id === 'splat-train')!.warnings.some((w) => w.includes('Vulkan')), false)
})

Deno.test('vulkan: the candidate paths are platform-shaped, not linux-shaped everywhere', () => {
  assertEquals(vulkanLoaderCandidates('linux', 'aarch64')[0], '/usr/lib/aarch64-linux-gnu/libvulkan.so.1')
  assertEquals(vulkanLoaderCandidates('windows', 'x86_64'), ['C:\\Windows\\System32\\vulkan-1.dll'])
  // Windows registers ICDs in the registry, so there is no directory to scan.
  assertEquals(vulkanIcdDirs('windows', 'C:\\Users\\t'), [])
  assert(vulkanIcdDirs('linux', '/home/t').includes('/usr/share/vulkan/icd.d'))
})

Deno.test('vulkan: versions:false stays pure filesystem — no enumeration is attempted', async () => {
  // The cheap mode a hot HTTP route uses. It must still describe Vulkan, and
  // must not claim a measurement it did not make.
  const report = await probe({ present: ['/usr/bin/vulkaninfo', LINUX_LOADER], path: '/usr/bin', dirs: NVIDIA_ICD })
  assertEquals(report.gpu.vulkan.measured, false)
  assertEquals(report.gpu.vulkan.status, 'inferred')
})

Deno.test('vulkan: the note no longer claims nothing probes Vulkan', async () => {
  const report = await probe({ path: '/usr/bin' })
  assertEquals(/which nothing here probes/.test(report.gpu.note), false)
  assertStringIncludes(report.gpu.note, 'vulkaninfo')
  assertStringIncludes(formatCapabilityReport(report), 'vulkan')
})

// ── Platform + rendering ─────────────────────────────────────────────────────

Deno.test('platform: windows falls back to USERPROFILE for the documented install paths', () => {
  const env = (n: string) => (n === 'USERPROFILE' ? 'C:\\Users\\t' : undefined)
  assertEquals(resolveHome(env), 'C:\\Users\\t')
  const spec = toolSpecs(resolveHome(env)).find((s) => s.id === 'brush')!
  assertEquals(spec.fallbacks, ['C:\\Users\\t/brush/target/release/brush-cli'])
})

Deno.test('format: a missing tool prints where it looked and how to fix it', async () => {
  const text = formatCapabilityReport(await probe({ path: '/usr/bin' }))
  assertStringIncludes(text, 'MISSING colmap')
  assertStringIncludes(text, '/home/t/.local/micromamba/envs/colmap/bin/colmap')
  assertStringIncludes(text, 'or set COLMAP_BIN')
})

Deno.test('format: a found tool prints its path and how it was resolved', async () => {
  const text = formatCapabilityReport(
    await probe({ present: ['/home/t/.local/micromamba/envs/colmap/bin/colmap'], path: '/usr/bin' }),
  )
  assertStringIncludes(text, '(fallback)')
})

Deno.test('probe: never throws when nothing at all is installed', async () => {
  const report = await probe()
  assertEquals(report.tools.every((t) => !t.found), true)
  assertEquals(report.pipelines.every((p) => p.status === 'blocked'), true)
  assert(formatCapabilityReport(report).length > 0)
})

Deno.test('runCapture: a binary that cannot be spawned is null, not a throw', async () => {
  assertEquals(await runCapture('/definitely/not/a/real/binary', [], 1000), null)
})
