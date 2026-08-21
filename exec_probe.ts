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
