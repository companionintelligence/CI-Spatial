/**
 * Cross-platform "can this path actually be executed?" probe.
 *
 * Extracted from the byte-identical copies that lived in `splat_train.ts`
 * and `splat_detect.ts` (ADR 0001: reuse, don't duplicate — two copies of a
 * predicate is exactly the drift that rule exists to stop; they had already
 * diverged in their comments).
 *
 * Why it isn't just a mode-bit mask: on Windows there is no POSIX exec bit.
 * `Deno.stat()` there reports a *synthesized* numeric mode — `0o100666` for
 * an ordinary file, exec bits always clear — rather than the `null` the
 * original code's "unsupported platform" fallback was written against. So
 * masking `mode & 0o111` returned `false` for every binary on Windows,
 * including a real `deno.exe`, and every caller concluded its worker was
 * missing. That silently pushed `splat_train`/`splat_detect` down their
 * "skipped" branch, which is why 9 tests failed on Windows dev boxes while
 * passing in Linux CI.
 */

/** Platform string, injectable so both branches are testable from either OS. */
export type ExecPlatform = typeof Deno.build.os

/**
 * True when `bin` exists, is a regular file, and — on platforms that model
 * it — carries an executable bit.
 *
 * `platform` defaults to the host and exists so tests can exercise the
 * Windows and POSIX branches regardless of where they run.
 */
export async function isRunnable(
  bin: string,
  platform: ExecPlatform = Deno.build.os,
): Promise<boolean> {
  try {
    const info = await Deno.stat(bin)
    if (!info.isFile) return false

    // Windows: no exec-bit concept. Existence of a regular file is the only
    // meaningful signal, so don't mask a mode that is synthesized anyway.
    if (platform === 'windows') return true

    // POSIX: any exec bit (user/group/other) counts.
    if (typeof info.mode === 'number') return (info.mode & 0o111) !== 0

    // mode genuinely unavailable — fall back to "it exists".
    return true
  } catch {
    return false
  }
}

/** Injection seams for `whichPath`, so both platform branches run from either OS. */
export interface WhichOptions {
  platform?: ExecPlatform
  /** PATH contents. Defaults to the host's; pass a literal to test the other OS. */
  path?: string
  /** Windows PATHEXT contents. Ignored on POSIX. */
  pathExt?: string
  /** Replaces the filesystem probe, so a table of fake paths can stand in. */
  _isRunnable?: (bin: string, platform: ExecPlatform) => Promise<boolean>
}

/** What `cmd.exe` assumes when PATHEXT is unset. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'

/**
 * Resolve `bin` to the absolute path PATH would run, or null.
 *
 * Why this and not the `which()` in colmap_poses.ts:649: that one answers
 * "does `colmap -h` exit 0", which is enough to decide whether to spawn but
 * throws away the answer to the question that actually cost hours here —
 * *which* binary, at *which* path. A capability report whose only output is a
 * boolean reproduces the failure it exists to prevent (COLMAP was installed
 * the whole time; `which colmap` said no because it lives in a micromamba env
 * that is not on PATH). Spawning is also the wrong primitive for a report that
 * probes eight tools: `-h` is not a universal flag, and a tool that opens a
 * window or blocks on a device would hang the probe.
 *
 * PATH entries are used verbatim. Every real PATH holds absolute directories,
 * and rewriting a relative one against the server's cwd would report a
 * resolution nothing else could reproduce.
 */
export async function whichPath(bin: string, opts: WhichOptions = {}): Promise<string | null> {
  const platform = opts.platform ?? Deno.build.os
  const probe = opts._isRunnable ?? isRunnable
  const dirSep = platform === 'windows' ? '\\' : '/'

  // A name carrying a separator is already a path; PATH is not consulted for
  // it, the same way every shell treats `./foo` and `foo` differently.
  if (bin.includes('/') || (platform === 'windows' && bin.includes('\\'))) {
    return (await probe(bin, platform)) ? bin : null
  }

  const raw = opts.path ?? envOr('PATH', '')
  const exts = extensionCandidates(bin, platform, opts.pathExt)
  for (const dir of raw.split(platform === 'windows' ? ';' : ':')) {
    // An empty PATH entry means "the current directory" on POSIX. Skipped on
    // purpose: a capability report that resolved a tool out of whatever
    // directory the server happened to start in would be reporting something
    // no one else can reproduce.
    if (dir === '') continue
    const base = dir.endsWith(dirSep) ? dir.slice(0, -1) : dir
    for (const ext of exts) {
      const candidate = `${base}${dirSep}${bin}${ext}`
      if (await probe(candidate, platform)) return candidate
    }
  }
  return null
}

/**
 * Suffixes to try for a bare name.
 *
 * POSIX has none. On Windows the PATHEXT suffixes come *first* and the bare
 * name last, because `isRunnable` on Windows can only ask "is this a regular
 * file" — so a stray extensionless `colmap` sitting next to the real
 * `colmap.exe` would otherwise win and then fail to launch.
 */
function extensionCandidates(bin: string, platform: ExecPlatform, pathExt?: string): string[] {
  if (platform !== 'windows') return ['']
  if (bin.includes('.')) return ['']
  const exts = (pathExt ?? envOr('PATHEXT', DEFAULT_PATHEXT))
    .split(';')
    .map((e) => e.trim())
    .filter((e) => e !== '')
  return [...exts, '']
}

/** Env read that survives a host without --allow-env rather than throwing. */
function envOr(name: string, fallback: string): string {
  try {
    return Deno.env.get(name) ?? fallback
  } catch {
    return fallback
  }
}
